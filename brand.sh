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
url() {
  v=$(clean "$2")
  [ -n "$v" ] || return 0
  case "$v" in
    *[!!-~]*|*\"*|*\\*)
      warn "ignoring $3: spaces, quotes, backslashes and non-ASCII are not allowed in a URL"
      return 0 ;;
  esac
  if printf '%s' "$v" | grep -Eq '^(https://.+|/[^/].*|data:image/[a-zA-Z0-9.+-]+[;,].*)$'; then
    put "$1" "$v"
    case "$v" in /brands/*) assets="$assets $v" ;; esac
  else
    warn "ignoring $3=\"$v\": use https://..., a /path on this site, or a data:image URL"
  fi
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
