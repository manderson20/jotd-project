/**
 * JOTD Worker (GitHub-backed jokes + Admin UI)
 * NO template literals/backticks anywhere (prevents CI escaping issues).
 */

var JOKES_URL = "https://raw.githubusercontent.com/manderson20/jotd-project/main/jokes.json";
var DEFAULT_RATING = "G";
var DEFAULT_TIMEZONE = "America/Chicago";
var SALT = "edgine-joke-salt-1";
var SIMILARITY_THRESHOLD = 0.82;

export default {
  async fetch(request, env, ctx) {
    try {
      var url = new URL(request.url);

      // Public info routes
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({
          ok: true,
          public: ["/", "/health", "/admin"],
          jokes: ["/v1/joke/today", "/v1/joke/random", "/v1/joke?id=1"],
          admin_api: ["/v1/admin/jokes (GET, POST)"],
          auth: "Send X-API-Key header for /v1/*"
        });
      }

      // Public admin UI (loads without header; API calls require header)
      if (url.pathname === "/admin") {
        return new Response(renderAdminHtml(), {
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }

      // Require auth for /v1/*
      if (startsWith(url.pathname, "/v1/")) {
        var required = env.JOTD_API_KEY;
        var provided = request.headers.get("X-API-Key");
        if (required && provided !== required) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      // Admin API
      if (url.pathname === "/v1/admin/jokes") {
        if (request.method === "GET") return handleAdminList(env);
        if (request.method === "POST") return handleAdminAdd(request, env);
        return json({ error: "Method not allowed" }, 405);
      }

      // Joke API
      if (!startsWith(url.pathname, "/v1/joke")) {
        return json({ error: "Not found" }, 404);
      }

      return handleJokes(request, env, ctx);
    } catch (err) {
      return json({ error: "Internal error", detail: String(err && err.message ? err.message : err) }, 500);
    }
  }
};

// ------------------ Joke Endpoints ------------------

async function handleJokes(request, env, ctx) {
  var url = new URL(request.url);

  var rating = String(url.searchParams.get("rating") || DEFAULT_RATING).toUpperCase();
  var category = url.searchParams.get("category");
  var tz = url.searchParams.get("tz") || DEFAULT_TIMEZONE;
  var idParam = url.searchParams.get("id");

  var jokes = await fetchJokesFromRaw(ctx);

  var filtered = jokes
    .filter(function (j) { return j && j.active !== false; })
    .filter(function (j) { return passesRating(j.rating || "G", rating); })
    .filter(function (j) {
      if (!category) return true;
      return String(j.category || "").toLowerCase() === String(category).toLowerCase();
    });

  if (!filtered.length) return json({ error: "No jokes available for the given filters." }, 404);

  if (idParam) {
    var idNum = Number(idParam);
    var match = filtered.find(function (j) { return Number(j.id) === idNum; });
    if (!match) return json({ error: "Joke not found for that id (or filtered out)." }, 404);
    return json({ mode: "id", joke: match }, 200);
  }

  if (endsWith(url.pathname, "/random")) {
    var idx = cryptoRandomInt(filtered.length);
    return json({ mode: "random", joke: filtered[idx] }, 200);
  }

  if (endsWith(url.pathname, "/today")) {
    var key = formatDateInTZ(new Date(), tz);
    var idx2 = await stableIndex(key + ":" + SALT, filtered.length);
    return json({ mode: "today", date: key, tz: tz, joke: filtered[idx2] }, 200);
  }

  return json({ error: "Not found" }, 404);
}

async function fetchJokesFromRaw(ctx) {
  var cache = caches.default;
  var cacheKey = new Request(JOKES_URL, { method: "GET" });

  var res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(JOKES_URL, { headers: { "User-Agent": "jotd-worker" } });
    if (!res.ok) throw new Error("Failed to fetch jokes.json (" + res.status + ")");

    var cached = new Response(res.body, res);
    cached.headers.set("Cache-Control", "public, max-age=300");
    ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    res = cached;
  }

  var data = await res.json();
  if (!Array.isArray(data)) throw new Error("jokes.json must be an array");
  return data;
}

// ------------------ Admin API (GitHub write) ------------------

async function handleAdminList(env) {
  var out = await githubReadJokesFile(env);
  return json({ count: out.jokes.length, jokes: out.jokes }, 200);
}

async function handleAdminAdd(request, env) {
  var body = await request.json().catch(function () { return null; });
  if (!body) return json({ error: "Invalid JSON body" }, 400);

  var text = String(body.text || "").trim();
  var rating = String(body.rating || "G").toUpperCase();
  var category = String(body.category || "").trim() || "general";
  var active = body.active !== false;

  if (!text) return json({ error: "text is required" }, 400);
  if (["G", "PG", "PG-13", "R"].indexOf(rating) === -1) return json({ error: "Invalid rating" }, 400);

  var read = await githubReadJokesFile(env);
  var jokes = read.jokes;
  var sha = read.sha;

  var normNew = normalizeText(text);
  var bestScore = 0;
  var bestId = null;
  var bestText = null;

  for (var i = 0; i < jokes.length; i++) {
    var j = jokes[i];
    if (!j || !j.text) continue;
    var normOld = normalizeText(j.text);

    if (normOld === normNew) {
      return json({ error: "Exact duplicate joke already exists", duplicate: { id: j.id, text: j.text } }, 409);
    }

    var score = jaccardTrigrams(normOld, normNew);
    if (score > bestScore) {
      bestScore = score;
      bestId = j.id;
      bestText = j.text;
    }
  }

  if (bestScore >= SIMILARITY_THRESHOLD) {
    return json(
      { error: "Similar joke already exists", similar: { score: round3(bestScore), id: bestId, text: bestText } },
      409
    );
  }

  var maxId = 0;
  for (var k = 0; k < jokes.length; k++) {
    var jid = Number(jokes[k] && jokes[k].id ? jokes[k].id : 0);
    if (jid > maxId) maxId = jid;
  }

  var newJoke = { id: maxId + 1, text: text, rating: rating, category: category, active: active };
  jokes.push(newJoke);
  jokes.sort(function (a, b) { return Number(a.id) - Number(b.id); });

  var content = JSON.stringify(jokes, null, 2) + "\n";
  var commitMsg = "Add joke #" + newJoke.id + " (" + category + ", " + rating + ")";

  await githubWriteJokesFile(env, sha, content, commitMsg);

  return json({ ok: true, added: newJoke }, 201);
}

async function githubReadJokesFile(env) {
  var owner = env.GITHUB_OWNER;
  var repo = env.GITHUB_REPO;
  var branch = env.GITHUB_BRANCH || "main";
  var path = env.JOKES_PATH || "jokes.json";

  if (!env.GITHUB_TOKEN) throw new Error("Missing env.GITHUB_TOKEN");
  if (!owner || !repo) throw new Error("Missing GITHUB_OWNER/GITHUB_REPO");

  var url =
    "https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + encodeURIComponent(path) +
    "?ref=" + encodeURIComponent(branch);

  var res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "User-Agent": "jotd-worker"
    }
  });

  if (!res.ok) {
    var t = await res.text().catch(function () { return ""; });
    throw new Error("GitHub read failed (" + res.status + "): " + t);
  }

  var data = await res.json();
  var sha = data.sha;
  var decoded = atob(String(data.content || "").replace(/\n/g, ""));
  var jokes = JSON.parse(decoded);

  if (!Array.isArray(jokes)) throw new Error("jokes.json must be a JSON array");
  return { jokes: jokes, sha: sha };
}

async function githubWriteJokesFile(env, sha, newContent, message) {
  var owner = env.GITHUB_OWNER;
  var repo = env.GITHUB_REPO;
  var branch = env.GITHUB_BRANCH || "main";
  var path = env.JOKES_PATH || "jokes.json";

  var url = "https://api.github.com/repos/" + owner + "/" + repo + "/contents/" + encodeURIComponent(path);

  var body = {
    message: message,
    content: btoa(newContent),
    sha: sha,
    branch: branch
  };

  var res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + env.GITHUB_TOKEN,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "jotd-worker"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    var t = await res.text().catch(function () { return ""; });
    throw new Error("GitHub write failed (" + res.status + "): " + t);
  }
}

// ------------------ UI (no backticks) ------------------

function renderAdminHtml() {
  // Basic HTML; uses only normal quotes and concatenation
  return (
'<!doctype html><html><head><meta charset="utf-8"/>' +
'<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
'<title>JOTD Admin</title>' +
'<style>' +
'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:24px;max-width:900px}' +
'input,select,textarea,button{font-size:16px;padding:10px}' +
'textarea{width:100%;min-height:120px}' +
'.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1}' +
'.card{border:1px solid #ddd;border-radius:10px;padding:16px;margin:16px 0}' +
'code{background:#f6f6f6;padding:2px 6px;border-radius:6px}' +
'.err{color:#b00020;white-space:pre-wrap}.ok{color:#0a7a2f}' +
'table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #eee;padding:8px;text-align:left}' +
'</style></head><body>' +
'<h1>Joke of the Day Admin</h1>' +
'<p>Paste your API key below. The page is public, but the API calls require <code>X-API-Key</code>.</p>' +

'<div class="card"><h2>Add a joke</h2>' +
'<div class="row">' +
'<div><label>Rating</label><br/>' +
'<select id="rating"><option>G</option><option>PG</option><option>PG-13</option><option>R</option></select>' +
'</div>' +
'<div><label>Category</label><br/>' +
'<input id="category" placeholder="tech, dad, school, pun..."/></div>' +
'<div><label>Active</label><br/>' +
'<select id="active"><option value="true" selected>true</option><option value="false">false</option></select>' +
'</div></div>' +
'<p><label>Joke text</label><br/>' +
'<textarea id="text" placeholder="Type the joke here..."></textarea></p>' +
'<p><label>API Key</label><br/>' +
'<input id="key" type="password" placeholder="Paste your X-API-Key here"/></p>' +
'<button id="submit">Add joke</button>' +
'<p id="status"></p><p class="err" id="error"></p></div>' +

'<div class="card"><h2>Preview current jokes</h2>' +
'<button id="refresh">Refresh list</button>' +
'<p id="count"></p>' +
'<table id="table" style="display:none">' +
'<thead><tr><th>ID</th><th>Rating</th><th>Category</th><th>Active</th><th>Text</th></tr></thead>' +
'<tbody id="tbody"></tbody></table></div>' +

'<script>' +
'const statusEl=document.getElementById("status");' +
'const errorEl=document.getElementById("error");' +
'const table=document.getElementById("table");' +
'const tbody=document.getElementById("tbody");' +
'const countEl=document.getElementById("count");' +
'function setStatus(msg,ok){statusEl.className=ok?"ok":"err";statusEl.textContent=msg;}' +
'function setError(msg){errorEl.textContent=msg||"";}' +
'function escapeHtml(s){return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}' +
'async function refresh(){setError("");setStatus("Loading...",true);' +
'const key=document.getElementById("key").value.trim();' +
'const res=await fetch("/v1/admin/jokes",{headers:{"X-API-Key":key}});' +
'const data=await res.json().catch(()=>({}));' +
'if(!res.ok){setStatus("Failed",false);setError(JSON.stringify(data,null,2));return;}' +
'setStatus("Loaded.",true);countEl.textContent="Count: "+data.count;' +
'tbody.innerHTML="";' +
'for(const j of data.jokes.slice().reverse().slice(0,50)){' +
'const tr=document.createElement("tr");' +
'tr.innerHTML="<td>"+j.id+"</td><td>"+j.rating+"</td><td>"+j.category+"</td><td>"+j.active+"</td><td>"+escapeHtml(j.text)+"</td>";' +
'tbody.appendChild(tr);}' +
'table.style.display="";}' +
'document.getElementById("refresh").addEventListener("click",refresh);' +
'document.getElementById("submit").addEventListener("click",async ()=>{' +
'setError("");setStatus("Submitting...",true);' +
'const key=document.getElementById("key").value.trim();' +
'const text=document.getElementById("text").value;' +
'const rating=document.getElementById("rating").value;' +
'const category=document.getElementById("category").value||"general";' +
'const active=document.getElementById("active").value==="true";' +
'const res=await fetch("/v1/admin/jokes",{method:"POST",headers:{"Content-Type":"application/json","X-API-Key":key},' +
'body:JSON.stringify({text,rating,category,active})});' +
'const data=await res.json().catch(()=>({}));' +
'if(res.status===409){setStatus("Rejected (duplicate/similar)",false);setError(JSON.stringify(data,null,2));return;}' +
'if(!res.ok){setStatus("Failed",false);setError(JSON.stringify(data,null,2));return;}' +
'setStatus("Added joke #"+data.added.id,true);document.getElementById("text").value="";refresh();});' +
'refresh();' +
'</script></body></html>'
  );
}

// ------------------ Helpers (no backticks) ------------------

function passesRating(jokeRating, requestedRating) {
  var order = ["G", "PG", "PG-13", "R"];
  var jr = String(jokeRating || "G").toUpperCase();
  var rr = String(requestedRating || "G").toUpperCase();
  var jIdx = order.indexOf(jr); if (jIdx === -1) jIdx = 0;
  var rIdx = order.indexOf(rr); if (rIdx === -1) rIdx = 0;
  return jIdx <= rIdx;
}

function json(obj, status, extraHeaders) {
  if (status === undefined) status = 200;
  if (!extraHeaders) extraHeaders = {};
  var headers = { "content-type": "application/json; charset=utf-8" };
  for (var k in extraHeaders) headers[k] = extraHeaders[k];
  return new Response(JSON.stringify(obj, null, 2), { status: status, headers: headers });
}

async function stableIndex(input, modulo) {
  var data = new TextEncoder().encode(input);
  var hash = await crypto.subtle.digest("SHA-256", data);
  var bytes = new Uint8Array(hash);
  var x = 0n;
  for (var i = 0; i < 8; i++) x = (x << 8n) + BigInt(bytes[i]);
  return Number(x % BigInt(modulo));
}

function cryptoRandomInt(max) {
  var buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

function formatDateInTZ(date, timeZone) {
  var parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  var y = findPart(parts, "year");
  var m = findPart(parts, "month");
  var d = findPart(parts, "day");
  return y + "-" + m + "-" + d;
}

function findPart(parts, type) {
  for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return parts[i].value;
  return "";
}

function normalizeText(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function trigrams(s) {
  var t = new Set();
  var padded = "  " + s + "  ";
  for (var i = 0; i < padded.length - 2; i++) t.add(padded.slice(i, i + 3));
  return t;
}

function jaccardTrigrams(a, b) {
  var A = trigrams(a);
  var B = trigrams(b);
  var inter = 0;
  A.forEach(function (x) { if (B.has(x)) inter++; });
  var union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function startsWith(s, prefix) {
  return String(s).slice(0, prefix.length) === prefix;
}
function endsWith(s, suffix) {
  s = String(s); suffix = String(suffix);
  return s.slice(s.length - suffix.length) === suffix;
}
