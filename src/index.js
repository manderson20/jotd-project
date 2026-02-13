/**
 * JOTD Worker (GitHub-backed jokes + Admin UI)
 *
 * Public:
 *   GET /            -> info
 *   GET /health      -> info
 *   GET /admin       -> HTML UI (public page)
 *
 * Protected (X-API-Key header == env.JOTD_API_KEY):
 *   GET  /v1/joke/today
 *   GET  /v1/joke/random
 *   GET  /v1/joke?id=123
 *   GET  /v1/admin/jokes
 *   POST /v1/admin/jokes   { text, rating, category, active }
 *
 * Required Cloudflare Secrets:
 *   JOTD_API_KEY
 *   GITHUB_TOKEN  (fine-grained PAT with Contents: Read & write for this repo)
 *
 * Required Cloudflare Vars (non-secret):
 *   GITHUB_OWNER=manderson20
 *   GITHUB_REPO=jotd-project
 *   GITHUB_BRANCH=main
 *   JOKES_PATH=jokes.json
 */

const JOKES_URL = "https://raw.githubusercontent.com/manderson20/jotd-project/main/jokes.json";

const DEFAULT_RATING = "G";
const DEFAULT_TIMEZONE = "America/Chicago";
const SALT = "edgine-joke-salt-1";

// Similarity threshold for "this looks like a repeat"
const SIMILARITY_THRESHOLD = 0.82;

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      // ---------- Public routes ----------
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({
          ok: true,
          public: ["/", "/health", "/admin"],
          jokes: ["/v1/joke/today", "/v1/joke/random", "/v1/joke?id=1"],
          admin_api: ["/v1/admin/jokes (GET, POST)"],
          auth: "Send X-API-Key header for /v1/*"
        });
      }

      // Public admin UI page (no header needed to load)
      if (url.pathname === "/admin") {
        return new Response(renderAdminHtml(), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      // ---------- Auth for /v1/* ----------
      if (url.pathname.startsWith("/v1/")) {
        const required = env.JOTD_API_KEY;
        const provided = request.headers.get("X-API-Key");
        if (required && provided !== required) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      // ---------- Admin API ----------
      if (url.pathname === "/v1/admin/jokes") {
        if (request.method === "GET") return handleAdminList(env);
        if (request.method === "POST") return handleAdminAdd(request, env);
        return json({ error: "Method not allowed" }, 405);
      }

      // ---------- Joke API ----------
      if (!url.pathname.startsWith("/v1/joke")) {
        return json({ error: "Not found" }, 404);
      }

      return handleJokes(request, env, ctx);
    } catch (err) {
      return json({ error: "Internal error", detail: String(err?.message || err) }, 500);
    }
  }
};

// ------------------ Joke Endpoints ------------------

async function handleJokes(request, env, ctx) {
  const url = new URL(request.url);

  const rating = (url.searchParams.get("rating") || DEFAULT_RATING).toUpperCase();
  const category = url.searchParams.get("category");
  const tz = url.searchParams.get("tz") || DEFAULT_TIMEZONE;
  const idParam = url.searchParams.get("id");

  const jokes = await fetchJokesFromRaw(ctx);

  const filtered = jokes
    .filter(j => j && j.active !== false)
    .filter(j => passesRating(j.rating || "G", rating))
    .filter(j =>
      category ? String(j.category || "").toLowerCase() === category.toLowerCase() : true
    );

  if (!filtered.length) {
    return json({ error: "No jokes available for the given filters." }, 404);
  }

  // /v1/joke?id=123
  if (idParam) {
    const idNum = Number(idParam);
    const match = filtered.find(j => Number(j.id) === idNum);
    if (!match) return json({ error: "Joke not found for that id (or filtered out)." }, 404);
    return json({ mode: "id", joke: match }, 200);
  }

  // /v1/joke/random
  if (url.pathname.endsWith("/random")) {
    const idx = cryptoRandomInt(filtered.length);
    return json({ mode: "random", joke: filtered[idx] }, 200);
  }

  // /v1/joke/today
  if (url.pathname.endsWith("/today")) {
    const key = formatDateInTZ(new Date(), tz); // YYYY-MM-DD in tz
    const idx = await stableIndex(`${key}:${SALT}`, filtered.length);
    return json({ mode: "today", date: key, tz, joke: filtered[idx] }, 200);
  }

  return json({ error: "Not found" }, 404);
}

async function fetchJokesFromRaw(ctx) {
  const cache = caches.default;
  const cacheKey = new Request(JOKES_URL, { method: "GET" });

  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(JOKES_URL, { headers: { "User-Agent": "jotd-worker" } });
    if (!res.ok) throw new Error(`Failed to fetch jokes.json (${res.status})`);

    // Cache upstream fetch for 5 minutes
    const cached = new Response(res.body, res);
    cached.headers.set("Cache-Control", "public, max-age=300");
    ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    res = cached;
  }

  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("jokes.json must be an array");
  return data;
}

// ------------------ Admin API (GitHub write) ------------------

async function handleAdminList(env) {
  const { jokes } = await githubReadJokesFile(env);
  return json({ count: jokes.length, jokes }, 200);
}

async function handleAdminAdd(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  const text = String(body.text || "").trim();
  const rating = String(body.rating || "G").toUpperCase();
  const category = String(body.category || "").trim() || "general";
  const active = body.active !== false;

  if (!text) return json({ error: "text is required" }, 400);
  if (!["G", "PG", "PG-13", "R"].includes(rating)) return json({ error: "Invalid rating" }, 400);

  const { jokes, sha } = await githubReadJokesFile(env);

  // Duplicate checks (exact + similar)
  const normNew = normalizeText(text);
  let best = { score: 0, id: null, text: null };

  for (const j of jokes) {
    if (!j || !j.text) continue;
    const normOld = normalizeText(j.text);

    if (normOld === normNew) {
      return json(
        { error: "Exact duplicate joke already exists", duplicate: { id: j.id, text: j.text } },
        409
      );
    }

    const score = jaccardTrigrams(normOld, normNew);
    if (score > best.score) best = { score, id: j.id, text: j.text };
  }

  if (best.score >= SIMILARITY_THRESHOLD) {
    return json(
      {
        error: "Similar joke already exists",
        similar: { score: Number(best.score.toFixed(3)), id: best.id, text: best.text }
      },
      409
    );
  }

  // Assign next id
  const maxId = jokes.reduce((m, j) => Math.max(m, Number(j?.id || 0)), 0);
  const newJoke = { id: maxId + 1, text, rating, category, active };

  jokes.push(newJoke);
  jokes.sort((a, b) => Number(a.id) - Number(b.id));

  const content = JSON.stringify(jokes, null, 2) + "\n";
  const commitMsg = `Add joke #${newJoke.id} (${category}, ${rating})`;

  await githubWriteJokesFile(env, sha, content, commitMsg);

  return json({ ok: true, added: newJoke }, 201);
}

async function githubReadJokesFile(env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const path = env.JOKES_PATH || "jokes.json";

  if (!env.GITHUB_TOKEN) throw new Error("Missing env.GITHUB_TOKEN");
  if (!owner || !repo) throw new Error("Missing GITHUB_OWNER/GITHUB_REPO");

  const url =
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}` +
    `?ref=${encodeURIComponent(branch)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "jotd-worker"
    }
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GitHub read failed (${res.status}): ${t}`);
  }

  const data = await res.json();
  const sha = data.sha;
  const decoded = atob(String(data.content || "").replace(/\n/g, ""));
  const jokes = JSON.parse(decoded);

  if (!Array.isArray(jokes)) throw new Error("jokes.json must be a JSON array");
  return { jokes, sha };
}

async function githubWriteJokesFile(env, sha, newContent, message) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const path = env.JOKES_PATH || "jokes.json";

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`;

  const body = {
    message,
    content: btoa(newContent),
    sha,
    branch
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "jotd-worker"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GitHub write failed (${res.status}): ${t}`);
  }
}

// ------------------ Admin UI HTML ------------------

function renderAdminHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>JOTD Admin</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:24px;max-width:900px}
    input,select,textarea,button{font-size:16px;padding:10px}
    textarea{width:100%;min-height:120px}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .row > *{flex:1}
    .card{border:1px solid #ddd;border-radius:10px;padding:16px;margin:16px 0}
    code{background:#f6f6f6;padding:2px 6px;border-radius:6px}
    .err{color:#b00020;white-space:pre-wrap}
    .ok{color:#0a7a2f}
    table{width:100%;border-collapse:collapse}
    th,td{border-bottom:1px solid #eee;padding:8px;text-align:left}
  </style>
</head>
<body>
  <h1>Joke of the Day Admin</h1>
  <p>Paste your API key below. The page is public, but the API calls require <code>X-API-Key</code>.</p>

  <div class="card">
    <h2>Add a joke</h2>
    <div class="row">
      <div>
        <label>Rating</label><br/>
        <select id="rating">
          <option>G</option>
          <option>PG</option>
          <option>PG-13</option>
          <option>R</option>
        </select>
      </div>
      <div>
        <label>Category</label><br/>
        <input id="category" placeholder="tech, dad, school, pun..." />
      </div>
      <div>
        <label>Active</label><br/>
        <select id="active">
          <option value="true" selected>true</option>
          <option value="false">false</option>
        </select>
      </div>
    </div>

    <p>
      <label>Joke text</label><br/>
      <textarea id="text" placeholder="Type the joke here..."></textarea>
    </p>

    <p>
      <label>API Key</label><br/>
      <input id="key" type="password" placeholder="Paste your X-API-Key here" />
    </p>

    <button id="submit">Add joke</button>
    <p id="status"></p>
    <p class="err" id="error"></p>
  </div>

  <div class="card">
    <h2>Preview current jokes</h2>
    <button id="refresh">Refresh list</button>
    <p id="count"></p>
    <table id="table" style="display:none">
      <thead><tr><th>ID</th><th>Rating</th><th>Category</th><th>Active</th><th>Text</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>

<script>
const statusEl = document.getElementById("status");
const errorEl  = document.getElementById("error");
const table    = document.getElementById("table");
const tbody    = document.getElementById("tbody");
const countEl  = document.getElementById("count");

function setStatus(msg, ok=true){
  statusEl.className = ok ? "ok" : "err";
  statusEl.textContent = msg;
}
function setError(msg){
  errorEl.textContent = msg || "";
}

async function refresh(){
  setError("");
  setStatus("Loading...", true);

  const key = document.getElementById("key").value.trim();
  const res = await fetch("/v1/admin/jokes", { headers: { "X-API-Key": key } });
  const data = await res.json().catch(()=>({}));

  if(!res.ok){
    setStatus("Failed", false);
    setError(JSON.stringify(data, null, 2));
    return;
  }

  setStatus("Loaded.", true);
  countEl.textContent = "Count: " + data.count;

  tbody.innerHTML = "";
  for(const j of data.jokes.slice().reverse().slice(0, 50)){
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + j.id + "</td><td>" + j.rating + "</td><td>" + j.category + "</td><td>" + j.active + "</td><td>" + escapeHtml(j.text) + "</td>";
    tbody.appendChild(tr);
  }
  table.style.display = "";
}

function escapeHtml(s){
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

document.getElementById("refresh").addEventListener("click", refresh);

document.getElementById("submit").addEventListener("click", async () => {
  setError("");
  setStatus("Submitting...", true);

  const key = document.getElementById("key").value.trim();
  const text = document.getElementById("text").value;
  const rating = document.getElementById("rating").value;
  const category = document.getElementById("category").value || "general";
  const active = document.getElementById("active").value === "true";

  const res = await fetch("/v1/admin/jokes", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: JSON.stringify({ text, rating, category, active })
  });

  const data = await res.json().catch(()=>({}));

  if(res.status === 409){
    setStatus("Rejected (duplicate/similar)", false);
    setError(JSON.stringify(data, null, 2));
    return;
  }

  if(!res.ok){
    setStatus("Failed", false);
    setError(JSON.stringify(data, null, 2));
    return;
  }

  setStatus("Added joke #" + data.added.id, true);
  document.getElementById("text").value = "";
  refresh();
});

refresh();
</script>
</body>
</html>`;
}

// ------------------ Utilities ------------------

function passesRating(jokeRating, requestedRating) {
  const order = ["G", "PG", "PG-13", "R"];
  const jr = String(jokeRating || "G").toUpperCase();
  const rr = String(requestedRating || "G").toUpperCase();
  const jIdx = order.indexOf(jr) === -1 ? 0 : order.indexOf(jr);
  const rIdx = order.indexOf(rr) === -1 ? 0 : order.indexOf(rr);
  return jIdx <= rIdx;
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

async function stableIndex(input, modulo) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  let x = 0n;
  for (let i = 0; i < 8; i++) x = (x << 8n) + BigInt(bytes[i]);
  return Number(x % BigInt(modulo));
}

function cryptoRandomInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function formatDateInTZ(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const y = parts.find(p => p.type === "year")?.value;
  const m = parts.find(p => p.type === "month")?.value;
  const d = parts.find(p => p.type === "day")?.value;

  return `${y}-${m}-${d}`;
}

function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\\s]/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
}

function trigrams(s) {
  const t = new Set();
  const padded = `  ${s}  `;
  for (let i = 0; i < padded.length - 2; i++) t.add(padded.slice(i, i + 3));
  return t;
}

function jaccardTrigrams(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}
