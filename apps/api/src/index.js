/**
 * Joke of the Day API — Cloudflare Worker
 *
 * Public (no key):
 *   GET /                     -> index
 *   GET /health               -> ok
 *   GET /v1/joke/today         -> deterministic daily joke
 *   GET /v1/joke/random        -> random joke
 *   GET /v1/joke?id=123        -> joke by id
 *
 * Admin (requires X-API-Key):
 *   GET  /admin                -> admin HTML
 *   GET  /v1/admin/debug        -> env/debug
 *   GET  /v1/admin/jokes        -> list jokes
 *   POST /v1/admin/jokes        -> add joke
 */

const DEFAULT_ALLOWED_RATINGS = ["G", "PG"]; // safe public default

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ---------------- PUBLIC ----------------
      if (request.method === "GET" && path === "/") {
        return json({
          ok: true,
          public: ["/", "/health", "/admin"],
          jokes: ["/v1/joke/today", "/v1/joke/random", "/v1/joke?id=1"],
          admin: ["/v1/admin/debug", "/v1/admin/jokes (GET, POST)"],
          tz: env.TZ || "America/Chicago",
          note: "Public endpoints do not require a key. Admin endpoints require X-API-Key.",
        });
      }

      if (request.method === "GET" && path === "/health") {
        return json({ ok: true });
      }

      if (request.method === "GET" && path === "/v1/joke/today") {
        const jokes = await loadJokesFromGitHub(env);
        const payload = pickToday(jokes, url, env);
        return json(payload, 200, { "Cache-Control": "public, max-age=60" });
      }

      if (request.method === "GET" && path === "/v1/joke/random") {
        const jokes = await loadJokesFromGitHub(env);
        const payload = pickRandom(jokes, url, env);
        return json(payload, 200, { "Cache-Control": "public, max-age=30" });
      }

      if (request.method === "GET" && path === "/v1/joke") {
        const idStr = url.searchParams.get("id");
        if (!idStr) return json({ error: "missing_id", message: "Use /v1/joke?id=123" }, 400);

        const id = Number(idStr);
        if (!Number.isFinite(id)) return json({ error: "invalid_id" }, 400);

        const jokes = await loadJokesFromGitHub(env);
        const j = jokes.find((x) => x.id === id);
        if (!j) return json({ error: "not_found" }, 404);

        return json(formatResponse({ mode: "id", joke: j }, url));
      }

      // ---------------- ADMIN UI ----------------
      if (request.method === "GET" && path === "/admin") {
        return html(adminHtml());
      }

      // ---------------- ADMIN API ----------------
      if (path === "/v1/admin/debug" && request.method === "GET") {
        requireApiKey(request, env);
        return json({
          has_JOTD_API_KEY: !!env.JOTD_API_KEY,
          has_GITHUB_TOKEN: !!env.GITHUB_TOKEN,
          GITHUB_OWNER: env.GITHUB_OWNER ?? null,
          GITHUB_REPO: env.GITHUB_REPO ?? null,
          GITHUB_BRANCH: env.GITHUB_BRANCH ?? "main",
          JOKES_PATH: env.JOKES_PATH ?? "apps/api/jokes.json",
        });
      }

      if (path === "/v1/admin/jokes" && request.method === "GET") {
        requireApiKey(request, env);
        const jokes = await loadJokesFromGitHub(env);
        return json({ count: jokes.length, jokes });
      }

      if (path === "/v1/admin/jokes" && request.method === "POST") {
        requireApiKey(request, env);

        const body = await request.json().catch(() => null);
        if (!body || typeof body.text !== "string") {
          return json({ error: "bad_request", message: "Expected JSON {text,rating,category,active}" }, 400);
        }

        const incoming = normalizeIncoming(body);
        const jokes = await loadJokesFromGitHub(env);

        const dup = findDuplicate(jokes, incoming.text);
        if (dup) {
          return json(
            {
              error: "duplicate_or_similar",
              message: "Rejected: duplicate or very similar text already exists.",
              similarTo: { id: dup.id, text: dup.text },
            },
            409
          );
        }

        const added = { id: nextId(jokes), ...incoming };
        jokes.push(added);

        await saveJokesToGitHub(env, jokes);

        return json({ ok: true, added }, 201);
      }

      return json({ error: "not_found" }, 404);
    } catch (err) {
      // IMPORTANT: return useful error info instead of opaque 1101.
      const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
      return json(
        {
          error: "server_error",
          message: err?.message || String(err),
          hint:
            "If this is /v1/admin/*, verify GITHUB_OWNER/GITHUB_REPO/GITHUB_TOKEN and JOKES_PATH=apps/api/jokes.json in Worker env vars.",
        },
        status
      );
    }
  },
};

/* -------------------- Picks -------------------- */

function pickToday(jokes, url, env) {
  const tz = env.TZ || "America/Chicago";
  const date = dateYYYYMMDD(tz);

  const allowedRatings = parseRatings(url.searchParams.get("ratings")) ?? DEFAULT_ALLOWED_RATINGS;
  const categories = parseCsv(url.searchParams.get("categories"));

  const pool = jokes
    .filter((j) => j.active !== false)
    .filter((j) => allowedRatings.includes(j.rating))
    .filter((j) => (categories ? categories.includes(j.category) : true));

  if (pool.length === 0) {
    return { mode: "today", date, tz, joke: null, warning: "No jokes match filters." };
  }

  // Deterministic daily pick
  const seed = hash(`${date}|${pool.length}|jotd`);
  const idx = seed % pool.length;

  return formatResponse({ mode: "today", date, tz, joke: pool[idx] }, url);
}

function pickRandom(jokes, url, env) {
  const tz = env.TZ || "America/Chicago";
  const date = dateYYYYMMDD(tz);

  const allowedRatings = parseRatings(url.searchParams.get("ratings")) ?? DEFAULT_ALLOWED_RATINGS;
  const categories = parseCsv(url.searchParams.get("categories"));

  const pool = jokes
    .filter((j) => j.active !== false)
    .filter((j) => allowedRatings.includes(j.rating))
    .filter((j) => (categories ? categories.includes(j.category) : true));

  if (pool.length === 0) {
    return { mode: "random", date, tz, joke: null, warning: "No jokes match filters." };
  }

  const idx = Math.floor(Math.random() * pool.length);
  return formatResponse({ mode: "random", date, tz, joke: pool[idx] }, url);
}

/* -------------- Display truncation support -------------- */

function formatResponse(base, url) {
  const maxCharsRaw = url.searchParams.get("maxChars");
  const maxChars = maxCharsRaw ? clampInt(Number(maxCharsRaw), 20, 5000) : null;

  if (!base.joke || !maxChars) return base;

  const full = String(base.joke.text || "");
  const { displayText, isTruncated } = truncateNice(full, maxChars);

  return {
    ...base,
    joke: { ...base.joke, displayText, isTruncated },
  };
}

function truncateNice(text, maxChars) {
  if (text.length <= maxChars) return { displayText: text, isTruncated: false };

  const cut = text.slice(0, maxChars);
  const punct = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("; "), cut.lastIndexOf(": "));
  let trimmed;

  if (punct >= Math.floor(maxChars * 0.6)) trimmed = cut.slice(0, punct + 1).trim();
  else {
    const sp = cut.lastIndexOf(" ");
    trimmed = (sp > 0 ? cut.slice(0, sp) : cut).trim();
  }
  return { displayText: `${trimmed}…`, isTruncated: true };
}

/* -------------------- Admin Auth -------------------- */

function requireApiKey(request, env) {
  const got = request.headers.get("X-API-Key") || "";
  const want = env.JOTD_API_KEY || "";
  if (!want) throw Object.assign(new Error("Missing JOTD_API_KEY secret"), { statusCode: 500 });
  if (got !== want) throw Object.assign(new Error("Unauthorized"), { statusCode: 401 });
}

/* -------------------- GitHub Storage -------------------- */

let cache = { jokes: null, etag: null, ts: 0 };

async function loadJokesFromGitHub(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const path = env.JOKES_PATH || "apps/api/jokes.json";
  const token = env.GITHUB_TOKEN;

  if (!owner || !repo) throw Object.assign(new Error("Missing GITHUB_OWNER/GITHUB_REPO"), { statusCode: 500 });
  if (!token) throw Object.assign(new Error("Missing GITHUB_TOKEN secret"), { statusCode: 500 });

  // small cache to reduce GitHub calls
  const now = Date.now();
  if (cache.jokes && now - cache.ts < 10_000) return cache.jokes;

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;

  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "jotd-worker",
    Accept: "application/vnd.github+json",
  };
  if (cache.etag) headers["If-None-Match"] = cache.etag;

  const res = await fetch(apiUrl, { headers });
  if (res.status === 304 && cache.jokes) {
    cache.ts = now;
    return cache.jokes;
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw Object.assign(new Error(`GitHub read failed (${res.status}): ${t}`), { statusCode: 500 });
  }

  const etag = res.headers.get("etag");
  const data = await res.json();
  const decoded = atob(String(data.content || "").replace(/\n/g, ""));
  const parsed = JSON.parse(decoded);

  if (!Array.isArray(parsed)) throw Object.assign(new Error("jokes.json must be a JSON array"), { statusCode: 500 });

  const jokes = parsed.map((j) => ({
    id: Number(j.id),
    text: String(j.text ?? ""),
    rating: String(j.rating ?? "G").toUpperCase(),
    category: String(j.category ?? "general"),
    active: j.active !== false,
  }));

  cache = { jokes, etag, ts: now };
  return jokes;
}

async function saveJokesToGitHub(env, jokes) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const path = env.JOKES_PATH || "apps/api/jokes.json";
  const token = env.GITHUB_TOKEN;

  if (!owner || !repo) throw Object.assign(new Error("Missing GITHUB_OWNER/GITHUB_REPO"), { statusCode: 500 });
  if (!token) throw Object.assign(new Error("Missing GITHUB_TOKEN secret"), { statusCode: 500 });

  // get current SHA
  const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "jotd-worker",
    Accept: "application/vnd.github+json",
  };

  const getRes = await fetch(getUrl, { headers });
  if (!getRes.ok) {
    const t = await getRes.text().catch(() => "");
    throw Object.assign(new Error(`GitHub get SHA failed (${getRes.status}): ${t}`), { statusCode: 500 });
  }
  const current = await getRes.json();
  if (!current.sha) throw Object.assign(new Error("GitHub response missing sha"), { statusCode: 500 });

  const content = btoa(JSON.stringify(jokes, null, 2));

  const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const body = {
    message: `Update jokes.json via JOTD admin (${new Date().toISOString()})`,
    content,
    sha: current.sha,
    branch,
  };

  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const t = await putRes.text().catch(() => "");
    throw Object.assign(new Error(`GitHub write failed (${putRes.status}): ${t}`), { statusCode: 500 });
  }

  // bust cache
  cache = { jokes: null, etag: null, ts: 0 };
}

/* -------------------- Admin HTML -------------------- */

function adminHtml() {
  return `<!doctype html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>JOTD Admin</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:24px;max-width:980px}
input,select,textarea,button{font-size:16px;padding:10px}
textarea{width:100%;min-height:120px}
.row{display:flex;gap:12px;flex-wrap:wrap}
.row>*{flex:1}
.card{border:1px solid #ddd;border-radius:10px;padding:16px;margin:16px 0}
code{background:#f6f6f6;padding:2px 6px;border-radius:6px}
.err{color:#b00020;white-space:pre-wrap}
.ok{color:#0a7a2f}
table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid #eee;padding:8px;text-align:left;vertical-align:top}
.small{opacity:.75;font-size:14px}
</style></head><body>
<h1>Joke of the Day Admin</h1>
<p class="small">This page is public, but API calls require <code>X-API-Key</code>.</p>

<div class="card">
  <h2>Add a joke</h2>
  <div class="row">
    <div><label>Rating</label><br/>
      <select id="rating"><option>G</option><option>PG</option><option>PG-13</option><option>R</option></select>
    </div>
    <div><label>Category</label><br/><input id="category" placeholder="tech, dad, fortune..."/></div>
    <div><label>Active</label><br/>
      <select id="active"><option value="true" selected>true</option><option value="false">false</option></select>
    </div>
  </div>
  <p><label>Joke text</label><br/><textarea id="text"></textarea></p>
  <p><label>API Key</label><br/><input id="key" type="password" placeholder="Paste X-API-Key"/></p>
  <button id="submit">Add joke</button>
  <p id="status"></p><p class="err" id="error"></p>
</div>

<div class="card">
  <h2>Preview current jokes</h2>
  <button id="refresh">Refresh list</button>
  <p id="count" class="small"></p>
  <table id="table" style="display:none">
    <thead><tr><th>ID</th><th>Rating</th><th>Category</th><th>Active</th><th>Text</th></tr></thead>
    <tbody id="tbody"></tbody>
  </table>
</div>

<script>
const statusEl=document.getElementById("status");
const errorEl=document.getElementById("error");
const table=document.getElementById("table");
const tbody=document.getElementById("tbody");
const countEl=document.getElementById("count");
function setStatus(msg,ok){statusEl.className=ok?"ok":"err";statusEl.textContent=msg;}
function setError(msg){errorEl.textContent=msg||"";}
function escapeHtml(s){return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}

async function refresh(){
  setError(""); setStatus("Loading...", true);
  const key=document.getElementById("key").value.trim();
  const res=await fetch("/v1/admin/jokes",{headers:{"X-API-Key":key}});
  const data=await res.json().catch(()=>({error:"bad_json"}));
  if(!res.ok){ setStatus("Failed", false); setError(JSON.stringify(data,null,2)); return; }
  setStatus("Loaded.", true);
  countEl.textContent="Count: "+data.count;
  tbody.innerHTML="";
  for(const j of data.jokes.slice().reverse().slice(0,100)){
    const tr=document.createElement("tr");
    tr.innerHTML="<td>"+j.id+"</td><td>"+j.rating+"</td><td>"+escapeHtml(j.category)+"</td><td>"+String(j.active)+"</td><td>"+escapeHtml(j.text)+"</td>";
    tbody.appendChild(tr);
  }
  table.style.display="";
}
document.getElementById("refresh").addEventListener("click", refresh);

document.getElementById("submit").addEventListener("click", async ()=>{
  setError(""); setStatus("Submitting...", true);
  const key=document.getElementById("key").value.trim();
  const text=document.getElementById("text").value;
  const rating=document.getElementById("rating").value;
  const category=document.getElementById("category").value||"general";
  const active=document.getElementById("active").value==="true";
  const res=await fetch("/v1/admin/jokes",{
    method:"POST",
    headers:{"Content-Type":"application/json","X-API-Key":key},
    body:JSON.stringify({text,rating,category,active})
  });
  const data=await res.json().catch(()=>({error:"bad_json"}));
  if(res.status===409){ setStatus("Rejected (duplicate/similar)", false); setError(JSON.stringify(data,null,2)); return; }
  if(!res.ok){ setStatus("Failed", false); setError(JSON.stringify(data,null,2)); return; }
  setStatus("Added joke #"+data.added.id,true);
  document.getElementById("text").value="";
  refresh();
});
refresh();
</script></body></html>`;
}

/* -------------------- Helpers -------------------- */

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=UTF-8", ...headers },
  });
}

function html(s, status = 200) {
  return new Response(s, { status, headers: { "Content-Type": "text/html; charset=UTF-8" } });
}

function parseCsv(s) {
  if (!s) return null;
  const arr = s.split(",").map((x) => x.trim()).filter(Boolean);
  return arr.length ? arr : null;
}

function parseRatings(s) {
  const arr = parseCsv(s);
  return arr ? arr.map((x) => x.toUpperCase()) : null;
}

function normalizeIncoming(body) {
  return {
    text: String(body.text).trim().replace(/\s+/g, " "),
    rating: String(body.rating || "G").toUpperCase(),
    category: String(body.category || "general").trim().toLowerCase(),
    active: body.active !== false,
  };
}

function nextId(jokes) {
  let max = 0;
  for (const j of jokes) if (Number.isFinite(j.id)) max = Math.max(max, j.id);
  return max + 1;
}

function findDuplicate(jokes, text) {
  const n = norm(text);
  for (const j of jokes) {
    const e = norm(j.text);
    if (e === n) return j;
    if ((e.includes(n) || n.includes(e)) && Math.min(e.length, n.length) / Math.max(e.length, n.length) > 0.85) return j;
  }
  return null;
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function dateYYYYMMDD(timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}
