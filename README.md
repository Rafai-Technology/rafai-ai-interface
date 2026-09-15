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

Copy `.env.example` to `.env`. Two variables point the app at the service, and
both are optional; the `BRAND_*` variables white-label it — see
[White-label](#white-label).

| Variable | When you need it |
| --- | --- |
| `VITE_API_BASE_URL` | The frontend is hosted separately from the agent service. Set it to the service's origin, e.g. `https://agent.rafaitech.in`. |
| `VITE_DEV_API_TARGET` | Development only: the service is not on `localhost:3000`. |

**`VITE_` variables are inlined at build time, not read at runtime.** A built
bundle points at whatever the API base was when it was built. Pointing the same
bundle at a different service means rebuilding it — or leaving
`VITE_API_BASE_URL` unset and putting a reverse proxy in front, which is the
better option if you want one artifact across environments.

## White-label

One build, branded per customer from `BRAND_*` variables: the AI's name, the
logo in the sidebar and on the browser tab, and colours. Every variable is
optional, and `brands/example.env` is a complete, commented customer file.

| Variable | Changes | When unset |
| --- | --- | --- |
| `BRAND_NAME` | Tab title, top bar, the empty-state prompt, sidebar, PDF footer, export filenames | `BRAND_COMPANY`, else "AI Assistant" |
| `BRAND_COMPANY` | Logo alt text | `BRAND_NAME` |
| `BRAND_TAGLINE` | Line under the logo | "Analytics" |
| `BRAND_LOGO_URL` | Sidebar logo, any aspect ratio | The name, set as a wordmark |
| `BRAND_LOGO_DARK_URL` | Sidebar logo on the dark theme | `BRAND_LOGO_URL` |
| `BRAND_FAVICON_URL` | Browser tab icon | `BRAND_LOGO_URL`, else a monogram of the name |
| `BRAND_ACCENT` | Buttons, links, tabs, focus rings, the question bubble | Rafai teal |
| `BRAND_ACCENT_DARK` | The same, on the dark theme | `BRAND_ACCENT` |
| `BRAND_BAR` | The rule across the top | `BRAND_ACCENT` |
| `BRAND_SIDEBAR` | Sidebar background; its text colour is worked out from it | The neutral sidebar |
| `BRAND_SIDEBAR_DARK` | The same, on the dark theme | `BRAND_SIDEBAR` |

"When unset" assumes the deployment is branded at all. Set any of the name,
company, logo or icon and nothing of Rafai's is shown — a forgotten logo becomes
the customer's wordmark, not Rafai's logo. With nothing set, it is Rafai.

**Values.** Colours as `6d28d9` or `#6d28d9`, and prefer no `#`: in a `.env`
file an unquoted `#` starts a comment and the value arrives empty. Images as
`https://…`, a `/path` served by this site, or a `data:image` URL. `http://`,
`//host`, and anything with a space, quote or backslash in it are refused.

**Not brandable, on purpose:** page backgrounds, text greys and borders, which
are tuned for contrast in both themes; and chart colours, which are validated as
a set for colour-blind readers — one brand hue can make two series look alike.

### How the brand reaches the page

`/brand.js` sets `window.__BRAND__` before the app loads. One of three things
writes it:

| | Written by | Brand comes from |
| --- | --- | --- |
| `npm run dev` | the Vite plugin, served live | `.env`, `.env.local` |
| `npm run build` | the Vite plugin, into `dist/brand.js` | the environment at build time |
| Docker | `brand.sh`, at container start | the container's environment |

```bash
cp brands/acme.env .env.local && npm run dev       # try a brand locally
cp brands/acme.env .env.local && npm run build     # a static host
docker run --env-file brands/acme.env -e AGENT_URL=http://agent:3001 -p 8080:80 rafai-web
```

In Docker the brand is a runtime setting, like `AGENT_URL`: build the image
once, run it per customer. If any `BRAND_*` variable is set on the container,
the brand is rebuilt from those alone — not merged with anything baked in at
build time. If none is, the built `brand.js` is kept. `/brand.js` is served
`no-cache`, so a restart with new values reaches browsers straight away.

**Logo files.** Mount them rather than pointing at another site. An `https://`
logo is fetched from that host by every user's browser, which a network with
no internet access cannot do:

```bash
docker run --env-file brands/acme.env \
  -v ./acme-logo.svg:/usr/share/nginx/html/brand/acme-logo.svg:ro \
  -e BRAND_LOGO_URL=/brand/acme-logo.svg -p 8080:80 rafai-web
```

### When a value is wrong

- `npm run dev` and `npm run build` **stop**, naming the variable.
- A container **warns and ignores** it (look for `brand:` in the log) and keeps
  serving — a typo in a colour should not take a customer's site down.
- A colour too light or dark to read as text (under 4.5:1) is warned about at
  build time and in the browser console. The shipped dark-theme teal is itself
  only 3.5:1, so a brand colour close to it will trigger that warning.

`node --experimental-strip-types tools/brand-test.ts` checks the rules,
including that the container and the build turn the same variables into the
same brand. `BRAND_TEST_DOCKER=1` repeats that under real busybox.

### The assistant's own name

`BRAND_NAME` here changes what the page says. What the assistant says about
itself — "I'm …" when a user asks who it is, and the default title of an export
it names — comes from the agent service, which cannot read this app's settings
(and must not take them from the browser, where any caller could rewrite them).
Set it on the service as well, one of two ways:

- **Per customer**, in `rafai-ai-agent/src/db/tenants.json`: `assistantName` and
  `assistantCompany` on that tenant's entry. Use this when one agent service
  serves several customers.
- **For the whole service**, with the same `BRAND_NAME` and `BRAND_COMPANY`
  variables in the agent service's environment. Use this when it runs for one
  customer.

A tenant's own values win, and replace the service-wide ones rather than mixing
with them. Unset everywhere, the assistant is Rafai AI.

### Not branded yet

- PDF exports use jsPDF's built-in font, which cannot draw non-Latin names.
- `/rafai-logo.png` is still served by every deployment, though nothing links to
  it once a brand is set.

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
