#!/bin/sh
# Who this container is.
#
# nginx:alpine runs every executable /docker-entrypoint.d/*.sh before nginx
# starts, and the Dockerfile installs this as 40-brand.sh. So the logo, the
# AI's name and the colours come from the CONTAINER'S environment rather than
# the build: one image serves every customer, exactly as AGENT_URL already
# lets one image serve every environment.
#
#   docker run --env-file brands/acme.env -e AGENT_URL=http://agent:3001 rafai-web
#
# It writes window.__BRAND__ to /brand.js. The rules mirror readBrandEnv() in
# src/brand-schema.ts — there is no Node in this image to share code with — and
# tools/brand-test.ts runs both on the same inputs and fails if they disagree.
#
# RUNTIME REPLACES BUILD. If any BRAND_* variable is set here, this file is
# rebuilt from the runtime environment alone; a brand baked in at build time
# is not merged with it. If none is set, the built file is left untouched.
#
# A value that fails validation is DROPPED WITH A WARNING and the app falls
# back, rather than refusing to start: a typo in a colour should not take a
# customer's site down. It will be in the container log.
#
# An image given as /brands/<name>/<file> is that file from the repo's brands/
# folder, which the image keeps OUTSIDE the web root (BRAND_ASSETS_DIR,
# /usr/share/nginx/brands). Only the files this brand names are copied in, so a
# customer's site serves its own logo and not every customer's.
#
# BRAND_JS_PATH=- prints the file instead of writing it (for inspection and
# for the tests), and skips the keep-the-built-file checks and the copying.
set -eu

# Character classes below are ASCII rules. Without this they change meaning
# with the locale, and the output would depend on the machine.
export LC_ALL=C

out="${BRAND_JS_PATH:-/usr/share/nginx/html/brand.js}"
names="BRAND_NAME BRAND_COMPANY BRAND_TAGLINE BRAND_LOGO_URL BRAND_LOGO_DARK_URL BRAND_FAVICON_URL BRAND_ACCENT BRAND_ACCENT_DARK BRAND_BAR BRAND_SIDEBAR BRAND_SIDEBAR_DARK"
body=""
assets=""

warn() { printf 'brand: %s\n' "$*" >&2; }

# Control characters out, spaces trimmed, then one surrounding pair of quotes
# removed: `docker run --env-file` passes quotes through literally.
clean() {
  printf '%s' "$1" \
    | tr -d '\000-\037\177' \
    | sed -e 's/^ *//' -e 's/ *$//' \
          -e 's/^"\(.*\)"$/\1/' \
          -e "s/^'\\(.*\\)'\$/\\1/" \
          -e 's/^ *//' -e 's/ *$//'
}

# Inside a JSON string only a backslash or a double quote can end it; control
# characters are already gone.
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

put() { body="${body:+$body,}\"$1\":\"$(esc "$2")\""; }

text() {
  v=$(clean "$2")
  if [ -n "$v" ]; then put "$1" "$v"; fi
}

# With or without the '#'. Carried with it.
colour() {
  v=$(clean "$2")
  [ -n "$v" ] || return 0
  if printf '%s' "$v" | grep -Eq '^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'; then
    put "$1" "#${v#\#}"
  else
    warn "ignoring $3=\"$v\": not a hex colour (write it as 6d28d9 or #6d28d9)"
  fi
}

# https, a same-origin /path (not //host), or an inline image. Printable ASCII
# only, and never a quote or a backslash — "/\evil.com/x" is a path to a browser
# only until it resolves it to https://evil.com/x.
# okurl prints the cleaned value when it passes and nothing when it does not;
# url() is the same check, warned about and carried into brand.js.
okurl() {
  v=$(clean "$1")
  case "$v" in ''|*[!!-~]*|*\"*|*\\*) return 0 ;; esac
  if printf '%s' "$v" | grep -Eq '^(https://.+|/[^/].*|data:image/[a-zA-Z0-9.+-]+[;,].*)$'; then
    printf '%s' "$v"
  fi
}

url() {
  v=$(clean "$2")
  [ -n "$v" ] || return 0
  case "$v" in
    *[!!-~]*|*\"*|*\\*)
      warn "ignoring $3: spaces, quotes, backslashes and non-ASCII are not allowed in a URL"
      return 0 ;;
  esac
  if [ -n "$(okurl "$v")" ]; then
    put "$1" "$v"
    case "$v" in /brands/*) assets="$assets $v" ;; esac
  else
    warn "ignoring $3=\"$v\": use https://..., a /path on this site, or a data:image URL"
  fi
}

# Escaped for an HTML attribute or text. & first, or it escapes the others twice.
h() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
                         -e 's/"/\&quot;/g' -e "s/'/\\&#39;/g"
}

# The title, icon and link-preview tags for index.html. Mirrors brandHead() in
# src/brand-schema.ts, which tools/brand-test.ts compares byte for byte.
# WhatsApp, Slack and Teams read these from the raw HTML and never run
# brand.js, so without it a container kept the BUILD's preview.
head_block() {
  n=$(clean "${BRAND_NAME:-}"); c=$(clean "${BRAND_COMPANY:-}"); tg=$(clean "${BRAND_TAGLINE:-}")
  lo=$(okurl "${BRAND_LOGO_URL:-}"); ld=$(okurl "${BRAND_LOGO_DARK_URL:-}"); fv=$(okurl "${BRAND_FAVICON_URL:-}")
  customised=""
  if [ -n "$n$c$lo$ld$fv" ]; then customised=1; fi

  sh_=$(okurl "${BRAND_SHARE_IMAGE_URL:-}")
  raw=$(clean "${BRAND_SHARE_IMAGE_URL:-}")
  case "$sh_" in data:*) sh_="" ;; esac
  if [ -n "$raw" ] && [ -z "$sh_" ]; then warn "ignoring BRAND_SHARE_IMAGE_URL=\"$raw\": use https://... or a /path on this site"; fi
  site=$(okurl "${BRAND_SITE_URL:-}")
  raw=$(clean "${BRAND_SITE_URL:-}")
  if ! printf '%s' "$site" | grep -Eq '^https://[^/]'; then site=""; fi
  if [ -n "$raw" ] && [ -z "$site" ]; then warn "ignoring BRAND_SITE_URL=\"$raw\": use https://your.domain"; fi
  site=$(printf '%s' "$site" | sed -e 's:/*$::')

  if [ -n "$n" ]; then name="$n"; elif [ -n "$c" ]; then name="$c"; elif [ -n "$customised" ]; then name="AI Assistant"; else name="Rafai AI"; fi
  if [ -n "$c" ]; then company="$c"; elif [ -n "$customised" ]; then company="$name"; else company="Rafai Technologies"; fi
  desc="${tg:-Analytics} assistant for $company"
  if [ -n "$fv" ]; then icon="$fv"; elif [ -n "$lo" ]; then icon="$lo"; elif [ -n "$customised" ]; then icon=""; else icon="/rafai-logo.png"; fi
  image=""
  for cand in "$sh_" "$lo" "$fv" "$([ -n "$customised" ] || printf '/rafai-logo.png')"; do
    case "$cand" in ''|data:*) continue ;; esac
    image="$cand"; break
  done
  abs() { case "$1" in /*) printf '%s%s' "$site" "$1" ;; *) printf '%s' "$1" ;; esac; }

  printf '<title>%s</title>\n' "$(h "$name")"
  printf '<meta name="description" content="%s" />\n' "$(h "$desc")"
  if [ -n "$icon" ]; then printf '<link rel="icon" href="%s" />\n' "$(h "$icon")"; fi
  case "$icon" in ''|data:*) ;; *) printf '<link rel="apple-touch-icon" href="%s" />\n' "$(h "$(abs "$icon")")" ;; esac
  printf '<meta property="og:type" content="website" />\n'
  printf '<meta property="og:site_name" content="%s" />\n' "$(h "$name")"
  printf '<meta property="og:title" content="%s" />\n' "$(h "$name")"
  printf '<meta property="og:description" content="%s" />\n' "$(h "$desc")"
  if [ -n "$image" ]; then
    printf '<meta property="og:image" content="%s" />\n' "$(h "$(abs "$image")")"
    printf '<meta name="twitter:card" content="summary_large_image" />'
  else
    printf '<meta name="twitter:card" content="summary" />'
  fi
  case "$sh_" in /brands/*) assets="$assets $sh_" ;; esac
}

if [ "$out" != "-" ]; then
  # Nothing branded at runtime: keep what the build wrote. Checked by name, so
  # BRAND_JS_PATH — configuration, not branding — never counts.
  branded=""
  for n in $names; do
    eval "v=\${$n:-}"
    if [ -n "$(clean "$v")" ]; then branded=1; fi
  done
  if [ -z "$branded" ]; then
    printf 'brand: no BRAND_* variables set, keeping the brand.js the build wrote\n'
    exit 0
  fi
  # A read-only root filesystem or a non-root image: warn and serve the built
  # brand. Failing here would stop the container, which is worse than the
  # wrong logo.
  if [ ! -w "$(dirname "$out")" ]; then
    warn "$(dirname "$out") is not writable, keeping the brand.js the build wrote"
    exit 0
  fi
fi

text   name        "${BRAND_NAME:-}"
text   company     "${BRAND_COMPANY:-}"
text   tagline     "${BRAND_TAGLINE:-}"
url    logo        "${BRAND_LOGO_URL:-}"      BRAND_LOGO_URL
url    logoDark    "${BRAND_LOGO_DARK_URL:-}" BRAND_LOGO_DARK_URL
url    favicon     "${BRAND_FAVICON_URL:-}"   BRAND_FAVICON_URL
colour accent      "${BRAND_ACCENT:-}"        BRAND_ACCENT
colour accentDark  "${BRAND_ACCENT_DARK:-}"   BRAND_ACCENT_DARK
colour bar         "${BRAND_BAR:-}"           BRAND_BAR
colour sidebar     "${BRAND_SIDEBAR:-}"       BRAND_SIDEBAR
colour sidebarDark "${BRAND_SIDEBAR_DARK:-}"  BRAND_SIDEBAR_DARK

payload=$(printf 'window.__BRAND__ = {%s};' "$body")

# BRAND_HTML_PATH=- prints the head block instead, for the tests.
if [ "${BRAND_HTML_PATH:-}" = "-" ]; then
  head_block
  exit 0
fi

if [ "$out" = "-" ]; then
  printf '%s\n' "$payload"
  exit 0
fi

# Written beside, then moved: nginx never serves a half-written file.
tmp="$out.tmp.$$"
if ! printf '%s\n' "$payload" > "$tmp" 2>/dev/null; then
  rm -f "$tmp"
  warn "could not write $out, keeping the brand.js the build wrote"
  exit 0
fi
mv "$tmp" "$out"

# The same brand into index.html's head, between the markers the build left.
# Anything wrong here is a warning: the app still brands itself in the browser.
html="${BRAND_HTML_PATH:-$(dirname "$out")/index.html}"
block="$html.block.$$"
head_block > "$block"
if [ ! -f "$html" ] || ! grep -q '<!-- brand:head -->' "$html"; then
  warn "$html has no <!-- brand:head --> block, link previews keep the build's brand"
elif awk -v f="$block" '
    index($0, "<!-- brand:head -->") { print; while ((getline l < f) > 0) print l; skip = 1; next }
    index($0, "<!-- /brand:head -->") { skip = 0 }
    !skip { print }' "$html" > "$html.tmp.$$" 2>/dev/null; then
  mv "$html.tmp.$$" "$html"
else
  rm -f "$html.tmp.$$"
  warn "could not write $html, link previews keep the build's brand"
fi
rm -f "$block"

# The brand's images. Whatever a previous start copied goes first: runtime
# replaces build, and a logo the brand no longer names should stop being served.
# A missing file is warned about; the page falls back to the name.
src_root="${BRAND_ASSETS_DIR:-/usr/share/nginx/brands}"
web_root=$(dirname "$out")
rm -rf "$web_root/brands"
for a in $assets; do
  if ! printf '%s' "$a" | grep -Eq '^/brands/[a-z0-9-]+/[a-zA-Z0-9_-][a-zA-Z0-9._-]*$'; then
    warn "not copying $a: expected /brands/<name>/<file>"
  elif [ ! -f "$src_root/${a#/brands/}" ]; then
    warn "$a: there is no ${a#/brands/} in $src_root"
  elif ! { mkdir -p "$web_root$(dirname "$a")" && cp "$src_root/${a#/brands/}" "$web_root$a"; } 2>/dev/null; then
    warn "could not copy $a into $web_root"
  fi
done
name=$(clean "${BRAND_NAME:-}")
printf 'brand: wrote %s (%s)\n' "$out" "${name:-no name set}"
