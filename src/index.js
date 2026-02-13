const JOKES_URL = "https://raw.githubusercontent.com/manderson20/jotd-project/main/jokes.json";
const DEFAULT_RATING = "G";
const SALT = "edgine-joke-salt-1";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/" || url.pathname === "/health") {
        return json({
          ok: true,
          endpoints: [
            "/v1/joke/today",
            "/v1/joke/random",
            "/v1/joke?id=1"
          ]
        });
      }

      if (!url.pathname.startsWith("/v1/joke")) {
        return json({ error: "Not found" }, 404);
      }

      const rating = (url.searchParams.get("rating") || DEFAULT_RATING).toUpperCase();
      const category = url.searchParams.get("category");
      const idParam = url.searchParams.get("id");

      const jokes = await fetchJokes(ctx);

      const filtered = jokes
        .filter(j => j && j.active !== false)
        .filter(j => passesRating(j.rating || "G", rating))
        .filter(j =>
          category
            ? String(j.category || "").toLowerCase() === category.toLowerCase()
            : true
        );

      if (!filtered.length) {
        return json({ error: "No jokes available for the given filters." }, 404);
      }

      if (idParam) {
        const idNum = Number(idParam);
        const match = filtered.find(j => Number(j.id) === idNum);
        if (!match) return json({ error: "Joke not found." }, 404);
        return json({ mode: "id", joke: match }, 200);
      }

      if (url.pathname.endsWith("/random")) {
        const idx = cryptoRandomInt(filtered.length);
        return json({ mode: "random", joke: filtered[idx] }, 200);
      }

      if (url.pathname.endsWith("/today")) {
        const now = new Date();
        const y = now.getUTCFullYear();
        const m = String(now.getUTCMonth() + 1).padStart(2, "0");
        const d = String(now.getUTCDate()).padStart(2, "0");
        const key = `${y}-${m}-${d}`;

        const idx = await stableIndex(`${key}:${SALT}`, filtered.length);
        return json({ mode: "today", date: key, joke: filtered[idx] }, 200);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: "Internal error", detail: String(err) }, 500);
    }
  }
};

async function fetchJokes(ctx) {
  const cache = caches.default;
  const cacheKey = new Request(JOKES_URL);

  let res = await cache.match(cacheKey);
  if (!res) {
    res = await fetch(JOKES_URL);
    if (!res.ok) throw new Error("Failed to fetch jokes");

    ctx.waitUntil(cache.put(cacheKey, res.clone()));
  }

  return res.json();
}

function passesRating(jokeRating, requestedRating) {
  const order = ["G", "PG", "PG-13", "R"];
  const jr = order.indexOf(jokeRating.toUpperCase());
  const rr = order.indexOf(requestedRating.toUpperCase());
  return jr <= rr;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json" }
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
