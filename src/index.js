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

      // Public admin UI page (no header needed to load the page)
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
    .filter(j => (category ? String(j.category || "").toLowerCase() === category.toLowerCase() : true));

  if (!filtered.length) {
    return json({ error: "No jokes available for the given filters." }, 404);
  }

  if (idParam) {
    const idNum = Number(idParam);
    const match = filtered.find(j => Number(j.id) === idNum);
    if (!match) return json({ error: "Joke not found for that id (or filtered out)." }, 404);
    return json({ mode: "id", joke: match }, 200);
  }

  if (url.pathname.endsWith("/random")) {
    const idx = cryptoRandomInt(filtered.length);
    return json({ mode: "random", joke: filtered[idx] }, 200);
  }

  if (url.pathname.endsWith("/today")) {
    const key = formatDateInTZ(new Date(), tz);
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
    if (!j?.text) continue;
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

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "jotd-worker"
    }
  });

  if (!res.ok) {
    const t = await res.text
