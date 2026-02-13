# 🎉 Joke of the Day (JOTD)

A universal, embeddable Joke of the Day system powered by:

- **Cloudflare Workers** (API)
- **Cloudflare Pages** (Widget UI)
- **GitHub** (Joke storage & version control)

This project provides:

- ✅ Public joke endpoint (safe for embedding)
- 🔐 Protected admin endpoints
- 🌐 Universal embed script (drop-in for any website)
- 📦 Auto-resizing widget
- 🌙 Automatic dark mode support

---

# 🏗 Architecture

```
GitHub (jokes.json)
        ↓
Cloudflare Worker (API)
        ↓
Cloudflare Pages (Widget UI)
        ↓
embed.js (Universal loader)
        ↓
Any website
```

---

# 🚀 Quick Start – Embed Anywhere (Recommended)

Add this to **any website**:

```html
<div data-jotd-embed></div>
<script src="https://jotd-project.pages.dev/embed.js" async></script>
```

That’s it.

No API key required.  
The widget automatically resizes itself.

---

# ⚙ Optional Customization

You can customize behavior using data attributes:

```html
<div
  data-jotd-embed
  data-ratings="G,PG"
  data-categories="tech"
  data-maxchars="400"
  data-title="Today's Tech Joke">
</div>

<script src="https://jotd-project.pages.dev/embed.js" async></script>
```

---

## Available Options

| Attribute | Description | Example |
|------------|------------|----------|
| `data-ratings` | Filter by rating | `"G,PG"` |
| `data-categories` | Filter by category | `"tech"` |
| `data-maxchars` | Truncate joke length | `"300"` |
| `data-title` | Override widget title | `"Daily Humor"` |

---

# 🖥 Alternative: Direct iframe

If preferred, you can embed using an iframe:

```html
<iframe
  src="https://jotd-project.pages.dev/?ratings=G,PG&maxChars=400"
  style="width:100%;border:0;overflow:hidden"
  scrolling="no">
</iframe>
```

The universal `embed.js` method is recommended because it automatically handles resizing.

---

# 🔐 API Overview

## Public Endpoint (No Authentication Required)

```
GET /v1/joke/today
```

Example:

```
https://joke-api.mthwanderson20.workers.dev/v1/joke/today?ratings=G,PG
```

Returns:

```json
{
  "date": "2026-02-13",
  "joke": {
    "id": 1025,
    "text": "I tried to write a joke about backups. Don’t worry—I saved it for later.",
    "category": "tech",
    "rating": "G",
    "displayText": "...",
    "isTruncated": false
  }
}
```

---

## Admin Endpoints (Require API Key)

Admin routes require:

```
X-API-Key: YOUR_SECRET_KEY
```

Examples:

```
GET /v1/admin/debug
POST /v1/admin/activate
POST /v1/admin/deactivate
```

Admin endpoints are protected and should not be used in public embeds.

---

# 🛠 Project Structure

```
jotd-project/
│
├── apps/
│   ├── api/           # Cloudflare Worker (API)
│   │   ├── src/
│   │   │   └── index.js
│   │   ├── jokes.json
│   │   └── wrangler.toml
│   │
│   └── embed/         # Cloudflare Pages widget
│       ├── index.html
│       └── embed.js
│
└── README.md
```

---

# ☁ Deployment

## Worker (API)

Deployed using Wrangler:

```bash
cd apps/api
npx wrangler deploy
```

Cloudflare Git integration may also deploy automatically.

---

## Pages (Widget)

- Root directory: `apps/embed`
- Framework preset: None
- Build command: (leave blank)
- Output directory: (leave blank)

Cloudflare Pages automatically deploys on push to `main`.

---

# 🔒 Security Notes

- Public joke endpoints do NOT require authentication.
- Admin endpoints require `X-API-Key`.
- GitHub token is stored securely in Cloudflare environment variables.
- No secrets are exposed to the client.

---

# 🌙 Theming

The widget automatically adapts to the user's system theme using:

```
prefers-color-scheme
```

Dark mode is automatic.

---

# 🧩 Use Cases

This widget can be embedded into:

- Websites
- IT dashboards
- WordPress sites
- Google Sites
- Internal portals
- Newsletters (via iframe)
- Digital signage dashboards

---

# 📜 License

Open-source. Modify and use as needed.

---

# 🙌 Credits

Created and maintained by **manderson20**.
Powered by Cloudflare + GitHub.
