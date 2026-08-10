#!/usr/bin/env bash
# Smoke-test an instance end to end: units, bindings, dashboard routing, the
# T3 proxy, and the Tailscale Serve mapping. Run it after applying a change to
# either instance.
#
#   ./check.sh                       # production
#   T3CODE_INSTANCE=dev ./check.sh   # development
#
# Exits non-zero if any check fails, so it also works as a deploy gate.
set -uo pipefail

instance="${T3CODE_INSTANCE:-production}"
if [[ ! "$instance" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "T3CODE_INSTANCE must contain only lowercase letters, numbers, and hyphens." >&2
  exit 1
fi

if [ "$instance" = production ]; then
  instance_suffix=""
  service_port="${T3CODE_PORT:-4123}"
  dashboard_port="${T3CODE_DASH_PORT:-4124}"
  pair_port="${T3CODE_PAIR_PORT:-443}"
else
  instance_suffix="-$instance"
  service_port="${T3CODE_TEST_PORT:-5123}"
  dashboard_port="${T3CODE_TEST_DASH_PORT:-5124}"
  pair_port="${T3CODE_TEST_PAIR_PORT:-8446}"
fi

app_name="t3code-host$instance_suffix"
service_unit="t3code$instance_suffix.service"
dashboard_unit="t3code-dashboard$instance_suffix.service"
state_dir="${HOME}/.local/state/$app_name"

# Ask the unit which checkout it deploys rather than assuming the default; an
# instance can be pointed at any worktree, as ./dev.sh does.
unit_env="$(systemctl --user show "$dashboard_unit" -p Environment --value 2>/dev/null)"
unit_value() { tr ' ' '\n' <<<"$unit_env" | sed -n "s/^$1=//p" | head -n1; }
unit_repo="$(unit_value T3CODE_REPO)"
repo_dir="${T3CODE_REPO:-${unit_repo:-${HOME}/.local/share/$app_name/src}}"
dev_repo="$(unit_value T3CODE_DEV_REPO)"
branch="$(unit_value T3CODE_BRANCH)"
branch="${branch:-deploy}"

passed=0
failed=0
skipped=0

ok()   { printf '  ok    %s\n' "$1"; passed=$((passed + 1)); }
bad()  { printf '  FAIL  %s\n' "$1"; failed=$((failed + 1)); }
skip() { printf '  --    %s\n' "$1"; skipped=$((skipped + 1)); }
note() { printf '\n%s\n' "$1"; }

# Compares an observed value against an expected one.
expect() {
  if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi
}

# Prints "<site url>\t<proxy target>" for an HTTPS port. Serve omits :443.
serve_site() {
  tailscale serve status 2>/dev/null |
    awk -v port=":$1" -v bare="$([ "$1" = 443 ] && echo 1 || echo 0)" '
      /^https:\/\// { site = $1; want = (site ~ port) || (bare && site !~ /:[0-9]+$/); next }
      want && /proxy/ { print site "\t" $NF; exit }
    '
}

status_of() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }
body_of()   { curl -s --max-time 10 "$@"; }

host="$(tailscale ip -4 2>/dev/null | head -n1)"
if [ -z "$host" ]; then
  echo "No Tailscale IPv4 address; is tailscaled up?" >&2
  exit 1
fi
base="http://$host:$dashboard_port"

echo "Checking $instance at $base"

# Run straight after a reinstall this would otherwise race the restart and
# report a page of false failures. Wait for both ports to answer at all; the
# checks below decide whether the answers are correct.
for _ in $(seq 30); do
  [ "$(status_of "$base/")" != 000 ] && break
  sleep 1
done

# An instance run by ./dev.sh is two plain processes: no units, no build, and a
# backend deliberately on the loopback address behind the dashboard's proxy.
# Checking it against the installed instance's expectations would report a page
# of failures that are all by design.
managed=1
if grep -q '"managed":false' <<<"$(body_of "$base/_dash/status")"; then
  managed=0
  echo "  (dev servers: no systemd units, no installed build)"
fi

# Only the installed instance binds the service port; the dev runner's backend
# is on loopback behind the proxy, so waiting for it there would always stall.
if [ "$managed" = 1 ]; then
  for _ in $(seq 30); do
    [ "$(status_of "http://$host:$service_port/")" != 000 ] && break
    sleep 1
  done
fi

# ---------------------------------------------------------------------------
note "services"
# ---------------------------------------------------------------------------
if [ "$managed" = 0 ]; then
  skip "not systemd-managed"
else
  for unit in "$service_unit" "$dashboard_unit"; do
    expect "$unit" "$(systemctl --user is-active "$unit" 2>/dev/null)" active
  done
fi

# ---------------------------------------------------------------------------
note "bindings"
# ---------------------------------------------------------------------------
# Binding the loopback fallback is the failure mode when the units start before
# tailscaled has an address, and it is invisible until something tries to
# connect over the tailnet.
listening="$(ss -ltn 2>/dev/null | awk '{print $4}')"
binding_targets=("dashboard:$dashboard_port")
# The dev runner keeps its backend on loopback on purpose; the dashboard proxy
# is the tailnet-facing side, so only the dashboard's binding is load-bearing.
[ "$managed" = 1 ] && binding_targets=("T3 Code:$service_port" "${binding_targets[@]}")
for port_pair in "${binding_targets[@]}"; do
  what="${port_pair%%:*}"
  port="${port_pair##*:}"
  if grep -qx "$host:$port" <<<"$listening"; then
    ok "$what listening on $host:$port"
  elif grep -qx "127.0.0.1:$port" <<<"$listening"; then
    bad "$what bound to 127.0.0.1:$port, not the tailnet address (restart the unit)"
  else
    bad "$what is not listening on port $port"
  fi
done

# ---------------------------------------------------------------------------
note "dashboard"
# ---------------------------------------------------------------------------
# The pre-proxy dashboard served its page at / and its API under /api. Detect
# it rather than reporting a wall of confusing routing failures.
legacy=0
if [ "$(status_of "$base/_dash/status")" != 200 ] && [ "$(status_of "$base/api/status")" = 200 ]; then
  legacy=1
  bad "running the pre-proxy dashboard (no /_dash API, no embedded console)"
  echo "        reinstall this instance to pick up the current dashboard"
fi

if [ "$legacy" = 1 ]; then
  skip "routing checks (legacy dashboard)"
else
  # The shell proxies src/dev-stub-t3.mjs and not T3 Code. Thus a page that is
  # not the dashboard is the console or that stub.
  is_t3() { grep -qE '<html lang="en"|name="t3code-stub"' <<<"$1"; }

  page="$(body_of -H 'Sec-Fetch-Dest: document' "$base/")"
  if grep -q 'class="app"' <<<"$page"; then
    ok "top-level / serves the dashboard"
  else
    bad "top-level / did not serve the dashboard page"
  fi

  # Same URL, framed: this is what the iframe requests.
  framed="$(body_of -H 'Sec-Fetch-Dest: iframe' "$base/")"
  if is_t3 "$framed"; then
    ok "framed / serves T3 Code"
  else
    bad "framed / did not serve T3 Code"
  fi

  embed="$(body_of "$base/?embed=1")"
  if is_t3 "$embed"; then
    ok "/?embed=1 serves T3 Code"
  else
    bad "/?embed=1 did not serve T3 Code"
  fi

  if grep -q 'class="app"' <<<"$(body_of "$base/dashboard")"; then
    ok "/dashboard serves the dashboard without fetch metadata"
  else
    bad "/dashboard did not serve the dashboard page"
  fi

  # Native and headless clients send no Sec-Fetch-Dest; they must reach T3.
  if is_t3 "$(body_of "$base/")"; then
    ok "/ without fetch metadata serves T3 Code (API clients)"
  else
    bad "/ without fetch metadata served the dashboard; API clients would break"
  fi

  if grep -q '"unit"' <<<"$(body_of "$base/_dash/status")"; then
    ok "/_dash/status returns service state"
  else
    bad "/_dash/status did not return service state"
  fi
fi

# ---------------------------------------------------------------------------
note "T3 proxy"
# ---------------------------------------------------------------------------
if [ "$managed" = 1 ]; then
  expect "T3 Code direct on $service_port" "$(status_of "http://$host:$service_port/")" 200
else
  # The shell proxies the stub. An instance that uses the dev runner of the
  # fork proxies a Vite address. The two results are correct for an instance
  # that systemd does not manage.
  probe="$(body_of -H 'Sec-Fetch-Dest: iframe' "$base/")"
  if grep -q '@vite/client' <<<"$probe"; then
    ok "proxied origin is the dev server (hot reload active)"
  elif grep -q 'name="t3code-stub"' <<<"$probe"; then
    ok "proxied origin is the T3 Code stub (dashboard shell)"
  else
    bad "proxied origin is neither the dev server nor the stub"
  fi
fi

if [ "$legacy" = 1 ]; then
  skip "proxy checks (legacy dashboard)"
else
  # The proxy presents a full-scope session on every request, so 400 ("not an
  # upgrade") is the authorized answer. A 401 means that token is missing or
  # rejected, which is what strips Create link and client management from the
  # console. 502 means the proxy could not reach T3 at all.
  ws="$(status_of "$base/ws")"
  case "$ws" in
    400 | 200) ok "/ws proxied and authorized (HTTP $ws)" ;;
    401) bad "/ws returned 401; the proxy has no working session, so the console loses access:write" ;;
    *) bad "/ws returned $ws; the proxy cannot reach T3" ;;
  esac

  upgrade="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$base/ws")"
  case "$upgrade" in
    101) ok "WebSocket upgrade proxied and accepted (HTTP 101)" ;;
    401) bad "WebSocket upgrade rejected as unauthenticated (HTTP 401)" ;;
    # The stub has no WebSocket. But the upgrade got to the stub. This test
    # examines that result.
    501) if grep -q 'name="t3code-stub"' <<<"${framed:-}"; then
           ok "WebSocket upgrade reached the stub, which declines it (HTTP 501)"
         else
           bad "WebSocket upgrade returned 501"
         fi ;;
    *) bad "WebSocket upgrade returned $upgrade" ;;
  esac

  # A build serves hashed /assets/*.js; the dev server serves source modules
  # and its own client. Either proves module requests reach T3 through us.
  asset="$(grep -oE '/(assets/[A-Za-z0-9._-]+\.js|@vite/client|src/[A-Za-z0-9._/-]+\.tsx?)' \
    <<<"${framed:-}" | head -n1)"
  if [ -n "$asset" ]; then
    expect "module proxied ($asset)" "$(status_of "$base$asset")" 200
  else
    skip "no module URL found in the console HTML"
  fi
fi

# ---------------------------------------------------------------------------
note "tailscale serve"
# ---------------------------------------------------------------------------
serve_entry="$(serve_site "$pair_port")"
serve_url="$(cut -f1 <<<"$serve_entry")"
serve_target="$(cut -f2 <<<"$serve_entry")"

if [ -z "$serve_entry" ]; then
  skip "no mapping on HTTPS port $pair_port (this instance is tailnet-address only)"
elif [ "$serve_target" = "http://$host:$dashboard_port" ]; then
  ok "$serve_url proxies the dashboard"
  expect "  and answers" "$(status_of "$serve_url/")" 200
elif [ "$serve_target" = "http://$host:$service_port" ]; then
  bad "$serve_url still proxies T3 directly ($serve_target); reinstall to publish the dashboard"
else
  bad "$serve_url proxies an unrelated target ($serve_target)"
fi

# ---------------------------------------------------------------------------
note "isolation"
# ---------------------------------------------------------------------------
# Prints "<site>\t<target>" for every Serve mapping.
serve_targets() {
  tailscale serve status 2>/dev/null |
    awk '/^https:\/\// { site = $1; next } site && /proxy/ { print site "\t" $NF }'
}

unit_home="$(tr ' ' '\n' <<<"$unit_env" | sed -n 's/^T3CODE_HOME=//p' | head -n1)"

if [ "$instance" = production ]; then
  skip "isolation checks only apply to secondary instances"
else
  if [ "$managed" = 0 ]; then
    skip "no unit environment (dev servers)"
  elif [ -z "$unit_home" ]; then
    skip "could not read T3CODE_HOME from $dashboard_unit"
  elif [ "$unit_home" = "${HOME}/.t3" ]; then
    bad "shares production's T3CODE_HOME ($unit_home); pairings would collide"
  else
    ok "separate T3 home ($unit_home)"
  fi

  # Every Serve port shares one MagicDNS hostname, and cookies ignore ports, so
  # publishing this instance there overwrites production's session cookie and
  # silently strips that browser's scopes.
  clash="$(serve_targets | grep -E "	http://$host:($dashboard_port|$service_port)$" | cut -f1)"
  if [ -n "$clash" ]; then
    bad "published at $clash, which shares production's cookie jar"
    echo "        remove it: tailscale serve --https=<port> off"
  else
    ok "not published on the shared MagicDNS hostname"
  fi
fi

# ---------------------------------------------------------------------------
# Developer mode decides what this machine tracks. A machine that carries the
# parts of the other mode gets a state that nobody reads, and an integration
# machine without them shows "synced" for a branch that it cannot see.
note "developer mode"
if grep -q '"devMode"[[:space:]]*:[[:space:]]*true' "$state_dir/settings.json" 2>/dev/null; then
  dev_mode=1
else
  dev_mode=0
fi
has_upstream() { git -C "$repo_dir" remote get-url upstream >/dev/null 2>&1; }

if [ ! -e "$repo_dir/.git" ]; then
  skip "developer mode checks (no source checkout at $repo_dir)"
elif [ "$dev_mode" = 1 ]; then
  ok "developer mode is on; this machine manages the integration branches"
  if has_upstream; then ok "the upstream remote is configured"
  else bad "developer mode is on, but there is no upstream remote; run ./install.sh"; fi
  if git -C "$repo_dir" show-ref --verify --quiet refs/heads/main; then ok "the local main branch exists"
  else bad "developer mode is on, but there is no local main branch; run ./install.sh"; fi
  if [ -z "$dev_repo" ]; then
    bad "developer mode is on, but the unit gives no development worktree"
    echo "        T3CODE_DEV_MODE=1 ./install.sh"
  elif [ -e "$dev_repo/.git" ]; then
    ok "development worktree at $dev_repo"
  else
    bad "no development worktree at $dev_repo"
    echo "        T3CODE_DEV_MODE=1 ./install.sh"
  fi
else
  ok "developer mode is off; this machine gets the $branch release only"
  if has_upstream; then bad "the upstream remote is still configured; run ./install.sh"
  else ok "no upstream remote"; fi
  if [ -n "$dev_repo" ]; then
    bad "the unit gives a development worktree, but developer mode is off; run ./install.sh"
  else
    ok "no development worktree"
  fi
fi

# ---------------------------------------------------------------------------
note "freshness"
# ---------------------------------------------------------------------------
# A stale process that still passes every check above is the worst failure mode
# in a develop-and-test loop: you end up testing code you already replaced.
if [ "$managed" = 0 ]; then
  skip "dev servers reload on save"
else
dashboard_file="${HOME}/.local/share/$app_name/t3code-dashboard.mjs"
if [ -L "$dashboard_file" ]; then
  ok "dashboard linked to $(readlink "$dashboard_file")"
elif [ -f "$dashboard_file" ]; then
  ok "dashboard installed as a copy (reinstall to update it)"
else
  bad "no dashboard at $dashboard_file"
fi

started="$(systemctl --user show "$dashboard_unit" -p ExecMainStartTimestamp --value 2>/dev/null)"
started_epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
source_epoch="$(stat -Lc %Y "$dashboard_file" 2>/dev/null || echo 0)"
if [ "$started_epoch" -eq 0 ] || [ "$source_epoch" -eq 0 ]; then
  skip "could not compare dashboard source and process times"
elif [ "$source_epoch" -gt "$started_epoch" ]; then
  bad "dashboard source is newer than the running process; restart to apply"
  echo "        systemctl --user restart $dashboard_unit"
else
  ok "running dashboard is current with its source"
fi

if [ -e "$repo_dir/.git" ]; then
  head_sha="$(git -C "$repo_dir" rev-parse --short HEAD 2>/dev/null)"
  built_sha="$(tr -d '[:space:]' <"$state_dir/built-sha" 2>/dev/null)"
  if [ -z "$built_sha" ]; then
    skip "no recorded build revision"
  elif [ "$head_sha" = "$built_sha" ]; then
    ok "deployed build matches $repo_dir ($head_sha)"
  else
    bad "deployed build is $built_sha but the worktree is at $head_sha (rebuild)"
  fi

  # A dirty worktree is normal in development, but the deployed build is only
  # ever of committed state plus whatever was present at build time.
  if [ -n "$(git -C "$repo_dir" status --porcelain 2>/dev/null)" ]; then
    newest="$(find "$repo_dir/apps" "$repo_dir/packages" -type f \
      \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
      -newer "$state_dir/built-sha" -not -path '*/node_modules/*' -not -path '*/dist/*' \
      -print -quit 2>/dev/null)"
    if [ -n "$newest" ]; then
      bad "source edited since the last build (e.g. ${newest#"$repo_dir"/}); rebuild"
      echo "        Use Build in the dashboard."
    else
      ok "worktree is dirty but nothing newer than the build"
    fi
  fi
else
  skip "no source checkout at $repo_dir"
fi
fi

echo
echo "$passed passed, $failed failed, $skipped skipped"
[ "$failed" -eq 0 ]
