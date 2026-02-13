/**
 * JOTD Worker API
 * - Public endpoints (no auth): /v1/joke/today, /v1/joke/random, /v1/health
 * - Admin endpoints (auth): /v1/admin/debug, /v1/admin/jokes (GET/PUT)
 *
 * Required env vars/secrets:
 *   - TZ (e.g. "America/Chicago")
 *   - GITHUB_OWNER (e.g. "manderson20")
 *   - GITHUB_REPO (e.g. "jotd-project")
 *   - GITHUB_BRANCH (e.g. "main")
 *   - JOKES_PATH (e.g. "apps/api/jokes.json")
 *   - GITHUB_TOKEN (secret)
 *   - JOTD_API_KEY (secret)  // only for /v1/admin/*
 */

const CACHE_TTL_MS = 60_000;

let cache = {
  jokes: null,
  sha: null,
  fetchedAt: 0,
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

function corsPublicHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// Admin CORS: you can lock this down to your own origins later.
// For now, we allow origin echo to avoid blocking your own admin UI,
// but admin routes STILL require X-API-Key.
function corsAdminHeaders(request) {
  const origin = request.headers.get("Origin");
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function isAdminPath(pathname) {
  return pathname.startsWith("/v1/admin/");
}

function unauthorized(request) {
  return json(
    { error: "unauthorized" },
    401,
    isAdminPath(new URL(request.url).pathname) ? corsAdminHeaders(request) : corsPublicHeaders()
  );
}

function badRequest(request, message) {
  return json({ error: message }, 400, isAdminPath(new URL(request.url).pathname) ? corsAdminHeaders(request) : corsPublicHeaders());
}

function notFound(request) {
  return json({ error: "not_found" }, 404, isAdminPath(new URL(request.url).pathname) ? corsAdminHeaders(request) : corsPublicHeaders());
}

function getLocalDateISO(env) {
  const tz = env.TZ || "UTC";
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD
  return dtf.format(new Date());
}

function parseCsvParam(value) {
  if (!value) return null;
  const parts = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

function normalizeRating(r) {
  return String(r || "").trim().toUpperCase();
}

function filterJokes(jokes, { ratings, categories, activeOnly = true }) {
  let out = Array.isArray(jokes) ? jokes.slice() : [];

  if (activeOnly) out = out.filter((j) => j && j.active === true);

  if (ratings && ratings.length) {
    const set = new Set(ratings.map(normalizeRating));
    out = out.filter((j) => set.has(normalizeRating(j.rating)));
  }

  if (categories && categories.length) {
    const set = new Set(categories.map((c) => String(c).trim().toLowerCase()));
    out = out.filter((j) => set.has(String(j.category || "").trim().toLowerCase()));
  }

  return out;
}

function stableHashToInt(str) {
  // Simple stable hash -> 32-bit int
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickTodayJoke(jokes, seedStr) {
  if (!jokes.length) return null;
  const h = stableHashToInt(seedStr);
  const idx = h % jokes.length;
  return jokes[idx];
}

function pickRandomJoke(jokes) {
  if (!jokes.length) return null;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return jokes[buf[0] % jokes.length];
}

function truncateText(textStr, maxChars) {
  const text = String(textStr || "");
  if (!maxChars || !Number.isFinite(maxChars) || maxChars <= 0) {
    return { displayText: text, isTruncated: false };
  }
  if (text.length <= maxChars) {
    return { displayText: text, isTruncated: false };
  }
  const trimmed = text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return { displayText: trimmed + "…", isTruncated: true };
}

async function readJokesFromGitHub(env) {
  const now = Date.now();
  if (cache.jokes && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { jokes: cache.jokes, sha: cache.sha, cached: true };
  }

  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const path = env.JOKES_PATH;

  if (!owner || !repo || !path) {
    throw new Error("Missing required env vars: GITHUB_OWNER, GITHUB_REPO, JOKES_PATH");
  }
  if (!env.GITHUB_TOKEN) {
    throw new Error("Missing secret: GITHUB_TOKEN");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/contents/${path}?ref=${encodeURIComponent(branch)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "jotd-worker",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub read failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const contentB64 = data.content || "";
  const sha = data.sha || null;

  const jsonStr = atob(contentB64.replace(/\n/g, ""));
  let jokes;
  try {
    jokes = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error("jokes.json is not valid JSON");
  }

  if (!Array.isArray(jokes)) {
    throw new Error("jokes.json must be an array of jokes");
  }

  cache.jokes = jokes;
  cache.sha = sha;
  cache.fetchedAt = now;

  return { jokes, sha, cached: false };
}

async function writeJokesToGitHub(env, jokesArray, sha) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  const path = env.JOKES_PATH;

  if (!owner || !repo || !path) {
    throw new Error("Missing required env vars: GITHUB_OWNER, GITHUB_REPO, JOKES_PATH");
  }
  if (!env.GITHUB_TOKEN) {
    throw new Error("Missing secret: GITHUB_TOKEN");
  }

  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/contents/${path}`;

  const bodyObj = {
    message: `Update jokes.json via JOTD admin`,
    content: btoa(JSON.stringify(jokesArray, null, 2)),
    branch,
    sha, // required to update existing file
  };

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "User-Agent": "jotd-worker",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub write failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const newSha = data?.content?.sha || null;

  // update cache
  cache.jokes = jokesArray;
  cache.sha = newSha;
  cache.fetchedAt = Date.now();

  return newSha;
}

function requireAdminAuth(request, env) {
  const key = request.headers.get("X-API-Key");
  return !!env.JOTD_API_KEY && key === env.JOTD_API_KEY;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight
    if (request.method === "OPTIONS") {
      const headers = isAdminPath(path) ? corsAdminHeaders(request) : corsPublicHeaders();
      return new Response(null, { status: 204, headers });
    }

    try {
      // ---------- Admin routes ----------
      if (isAdminPath(path)) {
        if (!requireAdminAuth(request, env)) {
          return unauthorized(request);
        }

        // GET /v1/admin/debug
        if (request.method === "GET" && path === "/v1/admin/debug") {
          return json(
            {
              has_JOTD_API_KEY: !!env.JOTD_API_KEY,
              has_GITHUB_TOKEN: !!env.GITHUB_TOKEN,
              GITHUB_OWNER: env.GITHUB_OWNER || null,
              GITHUB_REPO: env.GITHUB_REPO || null,
              GITHUB_BRANCH: env.GITHUB_BRANCH || null,
              JOKES_PATH: env.JOKES_PATH || null,
              TZ: env.TZ || null,
            },
            200,
            corsAdminHeaders(request)
          );
        }

        // GET /v1/admin/jokes  -> returns full jokes file (including inactive)
        if (request.method === "GET" && path === "/v1/admin/jokes") {
          const { jokes, sha } = await readJokesFromGitHub(env);
          return json({ sha, jokes }, 200, corsAdminHeaders(request));
        }

        // PUT /v1/admin/jokes -> replace jokes file
        if (request.method === "PUT" && path === "/v1/admin/jokes") {
          const { sha } = await readJokesFromGitHub(env);

          let payload;
          try {
            payload = await request.json();
          } catch {
            return badRequest(request, "Invalid JSON body");
          }

          const jokes = Array.isArray(payload) ? payload : payload?.jokes;
          if (!Array.isArray(jokes)) {
            return badRequest(request, "Body must be an array OR { jokes: [...] }");
          }

          // basic validation: ensure required fields exist
          for (const j of jokes) {
            if (!j || typeof j !== "object") return badRequest(request, "Each joke must be an object");
            if (typeof j.id !== "number") return badRequest(request, "Each joke must have numeric id");
            if (typeof j.text !== "string") return badRequest(request, "Each joke must have text string");
            if (typeof j.rating !== "string") return badRequest(request, "Each joke must have rating string");
            if (typeof j.category !== "string") return badRequest(request, "Each joke must have category string");
            if (typeof j.active !== "boolean") return badRequest(request, "Each joke must have active boolean");
          }

          const newSha = await writeJokesToGitHub(env, jokes, sha);
          return json({ ok: true, sha: newSha }, 200, corsAdminHeaders(request));
        }

        return notFound(request);
      }

      // ---------- Public routes ----------
      // GET /v1/health
      if (request.method === "GET" && path === "/v1/health") {
        return json({ ok: true }, 200, corsPublicHeaders());
      }

      // GET /v1/joke/today?ratings=G,PG&categories=tech,dad&maxChars=220
      if (request.method === "GET" && path === "/v1/joke/today") {
        const { jokes: allJokes } = await readJokesFromGitHub(env);

        const ratings = parseCsvParam(url.searchParams.get("ratings"));
        const categories = parseCsvParam(url.searchParams.get("categories"));
        const maxCharsRaw = url.searchParams.get("maxChars");
        const maxChars = maxCharsRaw ? Number(maxCharsRaw) : null;

        const list = filterJokes(allJokes, { ratings, categories, activeOnly: true });
        const date = getLocalDateISO(env);

        const seedStr = `${date}|${(ratings || []).join(",")}|${(categories || []).join(",")}`;
        const picked = pickTodayJoke(list, seedStr);

        if (!picked) {
          return json(
            { date, joke: null, error: "No matching jokes found (check ratings/categories/active)" },
            200,
            corsPublicHeaders()
          );
        }

        const { displayText, isTruncated } = truncateText(picked.text, maxChars);

        return json(
          {
            date,
            joke: {
              ...picked,
              displayText,
              isTruncated,
            },
          },
          200,
          {
            ...corsPublicHeaders(),
            // a little caching is okay; "today" changes daily (and when you edit jokes)
            "Cache-Control": "public, max-age=60",
          }
        );
      }

      // GET /v1/joke/random?ratings=G,PG&categories=tech&maxChars=220
      if (request.method === "GET" && path === "/v1/joke/random") {
        const { jokes: allJokes } = await readJokesFromGitHub(env);

        const ratings = parseCsvParam(url.searchParams.get("ratings"));
        const categories = parseCsvParam(url.searchParams.get("categories"));
        const maxCharsRaw = url.searchParams.get("maxChars");
        const maxChars = maxCharsRaw ? Number(maxCharsRaw) : null;

        const list = filterJokes(allJokes, { ratings, categories, activeOnly: true });
        const picked = pickRandomJoke(list);

        if (!picked) {
          return json(
            { joke: null, error: "No matching jokes found (check ratings/categories/active)" },
            200,
            corsPublicHeaders()
          );
        }

        const { displayText, isTruncated } = truncateText(picked.text, maxChars);

        return json(
          {
            joke: {
              ...picked,
              displayText,
              isTruncated,
            },
          },
          200,
          {
            ...corsPublicHeaders(),
            "Cache-Control": "no-store",
          }
        );
      }

      // Friendly root
      if (request.method === "GET" && path === "/") {
        return json(
          {
            name: "Joke of the Day API",
            endpoints: {
              health: "/v1/health",
              today: "/v1/joke/today?ratings=G,PG&maxChars=220",
              random: "/v1/joke/random?ratings=G,PG&maxChars=220",
              admin_debug: "/v1/admin/debug (requires X-API-Key)",
              admin_jokes: "/v1/admin/jokes (GET/PUT requires X-API-Key)",
            },
          },
          200,
          corsPublicHeaders()
        );
      }

      return notFound(request);
    } catch (err) {
      const headers = isAdminPath(path) ? corsAdminHeaders(request) : corsPublicHeaders();
      return json(
        {
          error: "server_error",
          message: String(err?.message || err),
        },
        500,
        headers
      );
    }
  },
};
