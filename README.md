# Rafai AI — web

The chat interface for Rafai AI. A Vite + React single-page app with no server
of its own: it talks to the agent service over HTTP and is deployable to any
static host.

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

With no configuration, the dev server proxies `/api` to
`http://localhost:3000`, so the browser stays on one origin and there is no
CORS to think about. Point it elsewhere with `VITE_DEV_API_TARGET`.

```bash
npm run build        # type-checks, then bundles to dist/
npm run preview      # serve the built bundle locally
```

## Configuration

Copy `.env.example` to `.env`. There are only two variables, and both are
optional.

| Variable | When you need it |
| --- | --- |
| `VITE_API_BASE_URL` | The frontend is hosted separately from the agent service. Set it to the service's origin, e.g. `https://agent.rafaitech.in`. |
| `VITE_DEV_API_TARGET` | Development only: the service is not on `localhost:3000`. |

**`VITE_` variables are inlined at build time, not read at runtime.** A built
bundle points at whatever the API base was when it was built. Pointing the same
bundle at a different service means rebuilding it — or leaving
`VITE_API_BASE_URL` unset and putting a reverse proxy in front, which is the
better option if you want one artifact across environments.

## Deploying

### Behind a reverse proxy (recommended)

Serve `dist/` and map `/api` to the agent service. The browser sees one origin,
so no CORS configuration is needed on either side and the token never crosses an
origin boundary.

```nginx
server {
  root /var/www/rafai-web;

  location /api/ {
    proxy_pass http://agent-service:3000/;
  }

  # SPA: unknown paths return index.html, not 404.
  location / {
    try_files $uri $uri/ /index.html;
  }
}
```

### Static host (Vercel, Netlify, S3 + CloudFront)

```bash
VITE_API_BASE_URL=https://agent.rafaitech.in npm run build
```

Then, on the agent service, allow this frontend's origin:

```bash
CORS_ORIGINS=https://ai.rafaitech.in
```

Two things to get right on a static host, or the app breaks in ways that look
random:

- **SPA fallback.** Unknown paths must serve `index.html`.
- **CORS.** If `CORS_ORIGINS` is unset the service reflects any origin, which
  works but leaves it callable from any page on the internet. Set it.

## What it expects from the service

| Endpoint | Purpose |
| --- | --- |
| `POST /auth/roles` | Role list, with each role's starter questions |
| `POST /auth/demo-token` | Demo sign-in. **Not present in production** — the ERP issues the token instead |
| `POST /agent/ask` | Ask a question |
| `GET /agent/schema` | Views and columns the current role may read |
| `GET /agent/conversations` | Saved chats, plus `GET/PATCH/DELETE` by id |

The token is held in `localStorage` and sent as `Authorization: Bearer`. It is
never a cookie, which is why CORS credentials are deliberately not enabled.

## Notes

- **Speech input** uses the Web Speech API. Chrome, Edge and Safari have it;
  Firefox does not, and the mic button is hidden there rather than shown broken.
  Chrome sends audio to Google for recognition — worth knowing before promising
  a customer that nothing leaves their infrastructure.
- **Charts** are Recharts. Chart specs come from the service in a fenced
  ```chart block inside the answer.
- **No analytics, no external fonts, no CDN.** Everything is bundled, so the app
  runs inside a network that cannot reach the public internet.
