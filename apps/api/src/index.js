// apps/api/src/index.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // -----------------------------
    // CORS / Preflight
    // -----------------------------
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // -----------------------------
    // Old bookmark-friendly redirect
    // -----------------------------
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      return Response.redirect("https://jotd-project.pages.dev/admin/", 302);
    }

    // -----------------------------
    // Routes
    // -----------------------------
    try {
      // Health
      if (url.pathname === "/" || url.pathname === "/health") {
        return json(
          { ok: true, service: "joke-api", routes: ["/v1/joke/today", "/v1/joke/random", "/v1/admin/debug"] },
          200,
          request
        );
      }

      // Public
      if (url.pathname === "/v1/joke/today" && request.method === "GET") {
        return await handleJokeToday(request, env);
      }

      if (url.pathname === "/v1/joke/random" && request.method === "GET") {
        return await handleJokeRandom(request, env);
      }

      // Admin
      if (url.pathname === "/v1/admin/debug" && request.method === "GET") {
        requireAdmin(request, env);
        return json(
          {
            has_JOTD_API_KEY: !!env.JOTD_API_KEY,
            has_GITHUB_TOKEN: !!env.GITHUB_TOKEN,
            GITHUB_OWNER: env.GITHUB_OWNER,
            GITHUB_REPO: env.GITHUB_REPO,
            GITHUB_BRANCH: env.GITHUB_BRANCH,
            JOKES_PATH: env.JOKES_PATH,
            TZ: env.TZ || "UTC",
          },
          200,
          request,
          true
        );
      }

      if (url.pathname === "/v1/admin/jokes" && request.method === "GET") {
        requireAdmin(request, env);
        const { sha, contentText } = await githubReadFile(env, env.JOKES_PATH);
        const jokes = JSON.parse(contentText);
        return json({ sha, jokes }, 200, request, true);
      }

      if (url.pathname === "/v1/admin/jokes" && request.method === "PUT") {
        requireAdmin(request, env);

        const body = await request.json();
        const sha = body?.sha;
        const jokes = body?.jokes;

        if (!Array.isArray(jokes)) {
          return json(
            { error: "bad_request", message: "Expected JSON body { sha, jokes: [...] }" },
            400,
            request,
            true
          );
        }

        // basic sanity: require id/text/rating/category/active-ish
        for (const j of jokes) {
          if (!j || typeof j !== "object") {
            return json({ error: "bad_request", message: "Each joke must be an object." }, 400, request, true);
          }
          if (typeof j.id !== "number") {
            return json({ error: "bad_request", message: "Each joke must have numeric id." }, 400, request, true);
          }
          if (typeof j.text !== "string") {
            return json({ error: "bad_request", message: "Each joke must have text string." }, 400, request, true);
          }
          if (typeof j.category !== "string") {
            return json({ error: "bad_request", message: "Each joke must have category string." }, 400, request, true);
          }
          if (typeof j.rating !== "string") {
            return json({ error: "bad_request", message: "Each joke must have rating string." }, 400, request, true);
          }
        }

        const newContentText = JSON.stringify(jokes, null, 2);

        const saved = await githubWriteFile(env, env.JOKES_PATH, {
          sha,
          contentText: newContentText,
          message: "Update jokes.json via admin UI",
        });

        return json({ ok: true, sha: saved.sha }, 200, request, true);
      }

      // Not found
      return json({ error: "not_found" }, 404, request);
    } catch (err) {
      const status = err?.statusCode || 500;
      const msg = err?.message || String(err);
      return json({ error: status === 401 ? "unauthorized" : "server_error", message: msg }, status, request, true);
    }
  },
};

// =====================================================
// Public handlers
// =====================================================

async function handleJokeToday(request, env) {
  const url = new URL(request.url);
  const { jokes } = await loadJokesFromGitHub(env);

  const filters = parseFilters(url);
  const pool = filterJokes(jokes, filters);

  if (pool.length === 0) {
    return json(
      {
        error: "no_jokes",
        message: "No jokes matched your filters (ratings/categories) and active flags.",
        filters,
      },
      404,
      request
    );
  }

  const dateStr = getDateStringInTZ(env.TZ || "UTC");
  const idx = stableIndexFromString(dateStr, pool.length);
  const picked = pool[idx];

  const shaped = shapeJoke(picked, filters.maxChars);

  return json({ date: dateStr, joke: shaped }, 200, request);
}

async function handleJokeRandom(request, env) {
  const url = new URL(request.url);
  const { jokes } = await loadJokesFromGitHub(env);

  const filters = parseFilters(url);
  const pool = filterJokes(jokes, filters);

  if (pool.length === 0) {
    return json(
      {
        error: "no_jokes",
        message: "No jokes matched your filters (ratings/categories) and active flags.",
        filters,
      },
      404,
      request
    );
  }

  const picked = pool[Math.floor(Math.random() * pool.length)];
  const shaped = shapeJoke(picked, filters.maxChars);

  return json({ joke: shaped }, 200, request);
}

// =====================================================
// Filtering, shaping, truncation
// =====================================================

function parseFilters(url) {
  const ratings = normalizeCSV(url.searchParams.get("ratings") || "G,PG");
  const categories = normalizeCSV(url.searchParams.get("categories") || "");
  const maxCharsRaw = url.searchParams.get("maxChars");
  const maxChars = maxCharsRaw ? clampInt(maxCharsRaw, 40, 4000) : null;

  return {
    ratings: ratings.length ? ratings : ["G", "PG"],
    categories: categories.length ? categories : null,
    maxChars,
  };
}

function filterJokes(jokes, filters) {
  const allowedRatings = new Set((filters.ratings || []).map((r) => r.toUpperCase()));
  const allowedCategories = filters.categories
    ? new Set(filters.categories.map((c) => c.toLowerCase()))
    : null;

  return (jokes || []).filter((j) => {
    if (!j || typeof j !== "object") return false;
    if (j.active !== true) return false;

    const rating = String(j.rating || "").toUpperCase().trim();
    const category = String(j.category || "").toLowerCase().trim();

    if (!allowedRatings.has(rating)) return false;
    if (allowedCategories && !allowedCategories.has(category)) return false;

    // must have text
    if (!j.text || typeof j.text !== "string") return false;

    return true;
  });
}

function shapeJoke(j, maxChars) {
  const text = (j.text || "").trim();

  let displayText = text;
  let isTruncated = false;

  if (maxChars && text.length > maxChars) {
    displayText = text.slice(0, maxChars).trimEnd() + "…";
    isTruncated = true;
  }

  return {
    id: j.id,
    category: j.category,
    rating: j.rating,
    text,
    displayText,
    isTruncated,
  };
}

// =====================================================
// Date + stable index
// =====================================================

function getDateStringInTZ(tz) {
  // YYYY-MM-DD in specified TZ
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // en-CA gives YYYY-MM-DD
}

function stableIndexFromString(str, mod) {
  // simple stable hash -> [0, mod)
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // make unsigned
  h >>>= 0;
  return mod ? h % mod : 0;
}

// =====================================================
// Admin auth
// =====================================================

function requireAdmin(request, env) {
  const key = request.headers.get("X-API-Key") || "";
  if (!env.JOTD_API_KEY || key !== env.JOTD_API_KEY) {
    const e = new Error("Missing or invalid X-API-Key");
    e.statusCode = 401;
    throw e;
  }
}

// =====================================================
// GitHub I/O
// =====================================================

let _cache = { at: 0, data: null };
const CACHE_MS = 30_000; // short cache to reduce GitHub hits

async function loadJokesFromGitHub(env) {
  // tiny cache
  const now = Date.now();
  if (_cache.data && now - _cache.at < CACHE_MS) return _cache.data;

  const { contentText } = await githubReadFile(env, env.JOKES_PATH);
  const jokes = JSON.parse(contentText);

  const data = { jokes };
  _cache = { at: now, data };
  return data;
}

async function githubReadFile(env, path) {
  assertEnv(env);

  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/contents/${path}?ref=${encodeURIComponent(branch)}`;

  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "jotd-worker",
      Accept: "application/vnd.github+json",
    },
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const e = new Error(`GitHub read failed: ${res.status} ${JSON.stringify(data)}`);
    e.statusCode = 500;
    throw e;
  }

  if (!data?.content || !data?.sha) {
    const e = new Error("GitHub response missing content/sha.");
    e.statusCode = 500;
    throw e;
  }

  const contentText = decodeBase64(data.content);

  return { sha: data.sha, contentText };
}

async function githubWriteFile(env, path, { sha, contentText, message }) {
  assertEnv(env);

  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";

  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/contents/${path}`;

  const body = {
    message: message || "Update file via jotd-worker",
    content: encodeBase64(contentText),
    branch,
  };

  if (sha) body.sha = sha;

  const res = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "jotd-worker",
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const e = new Error(`GitHub write failed: ${res.status} ${JSON.stringify(data)}`);
    e.statusCode = 500;
    throw e;
  }

  const newSha = data?.content?.sha || data?.commit?.sha;
  if (!newSha) {
    const e = new Error("GitHub write response missing sha.");
    e.statusCode = 500;
    throw e;
  }

  // clear cache so new jokes show quickly
  _cache = { at: 0, data: null };

  return { sha: newSha, raw: data };
}

function assertEnv(env) {
  const missing = [];
  if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN");
  if (!env.GITHUB_OWNER) missing.push("GITHUB_OWNER");
  if (!env.GITHUB_REPO) missing.push("GITHUB_REPO");
  if (!env.JOKES_PATH) missing.push("JOKES_PATH");
  if (missing.length) {
    const e = new Error(`Missing env vars: ${missing.join(", ")}`);
    e.statusCode = 500;
    throw e;
  }
}

// =====================================================
// Helpers: JSON, CORS, parsing, base64
// =====================================================

function json(obj, status, request, isAdmin = false) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(request, isAdmin),
  };
  return new Response(JSON.stringify(obj, null, 2), { status, headers });
}

function corsHeaders(request, isAdmin = false) {
  // Public endpoints must be fetchable from anywhere for widgets
  // Admin endpoints also need CORS for browser UI sending X-API-Key
  const origin = request.headers.get("Origin") || "*";
  return {
    "access-control-allow-origin": origin === "null" ? "*" : origin,
    "access-control-allow-methods": "GET,PUT,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, X-API-Key",
    "access-control-max-age": "86400",
    // helpful for debugging
    "vary": "Origin",
  };
}

function normalizeCSV(s) {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function clampInt(v, min, max) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function decodeBase64(b64) {
  // GitHub content has newlines; remove them
  const clean = String(b64).replace(/\s+/g, "");
  // atob not always available; use Buffer-like decode via Uint8Array
  const binary = atob(clean);
  let out = "";
  for (let i = 0; i < binary.length; i++) out += String.fromCharCode(binary.charCodeAt(i));
  return out;
}

function encodeBase64(text) {
  // btoa expects binary-ish; UTF-8 safe encode
  const utf8 = new TextEncoder().encode(text);
  let bin = "";
  for (const b of utf8) bin += String.fromCharCode(b);
  return btoa(bin);
}
