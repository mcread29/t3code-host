#!/usr/bin/env bash
# Development: two dev servers, in this session, nothing installed.
#
#   T3 Code    the fork's own dev runner in the development worktree, serving
#              from source with hot reload
#   dashboard  node --watch on this checkout, restarting on save
#
# Nothing is installed globally, no systemd units are created, and no Tailscale
# Serve mapping is published. Production is untouched. Ctrl-C stops both.
#
#   ./dev.sh          run both dev servers
#   ./dev.sh check    verify what is running
#   ./dev.sh down     remove a previously installed dev instance
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/guard.sh
. "$root/lib/guard.sh"

command_name="${1:-serve}"

instance="${T3CODE_INSTANCE:-dev}"
prod_app_dir="${T3CODE_PROD_APP_DIR:-${HOME}/.local/share/t3code-host}"

# Serve the worktree you actually edit, rather than a separate checkout.
repo_dir="${T3CODE_REPO:-$prod_app_dir/dev}"
branch="${T3CODE_BRANCH:-dev}"
dash_port="${T3CODE_TEST_DASH_PORT:-5124}"

# Development must never resolve to production's instance or ports, whatever
# the environment happens to hold.
guard_not_production "$instance" "$dash_port"

# Nor to production's deployment worktree, which the running service builds from.
if [ "$repo_dir" = "$prod_app_dir/src" ]; then
  echo "$repo_dir is production's deployment worktree; refusing to serve it." >&2
  exit 1
fi

require_worktree() {
  if [ ! -e "$repo_dir/.git" ]; then
    echo "No development worktree at $repo_dir." >&2
    echo "Create one, or point T3CODE_REPO at the checkout to serve." >&2
    exit 1
  fi
  local checked_out
  checked_out="$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD)"
  if [ "$checked_out" != "$branch" ]; then
    echo "$repo_dir has $checked_out checked out, not $branch." >&2
    exit 1
  fi
}

# Parse both halves of the dashboard before starting. The browser script is a
# template literal inside the module, so the module parsing is no evidence that
# the page does, and a broken page is invisible server-side.
verify_dashboard_source() {
  local source="$root/src/t3code-dashboard.mjs"
  node --check "$source" || { echo "dashboard module has a syntax error" >&2; return 1; }
  node -e '
    const fs = require("node:fs")
    const text = fs.readFileSync(process.argv[1], "utf8")
    const open = text.indexOf("<script>")
    const close = text.indexOf("</" + "script>")
    if (open < 0 || close < 0) throw new Error("could not find the browser script")
    const script = text.slice(open + 8, close).replaceAll("__TOKEN__", "x")
    new (require("node:vm").Script)(script, { filename: "dashboard page script" })
  ' "$source" || { echo "dashboard page script has a syntax error" >&2; return 1; }
}

case "$command_name" in
  serve)
    require_worktree
    verify_dashboard_source

    host="$(tailscale ip -4 2>/dev/null | head -n1)"
    if [ -z "$host" ]; then
      echo "No Tailscale IPv4 address; is tailscaled up?" >&2
      exit 1
    fi

    runner_log="$(mktemp -t t3code-dev-runner.XXXXXX.log)"
    dashboard_pid=""
    runner_pid=""
    tail_pid=""
    cleanup() {
      trap - INT TERM EXIT
      [ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null
      [ -n "$dashboard_pid" ] && kill "$dashboard_pid" 2>/dev/null
      # The runner spawns the backend and Vite as children, so signal the whole
      # process group or they survive and keep holding their ports.
      [ -n "$runner_pid" ] && kill -- "-$runner_pid" 2>/dev/null
      sleep 1
      [ -n "$runner_pid" ] && kill -9 -- "-$runner_pid" 2>/dev/null
      rm -f "$runner_log"
      return 0
    }
    trap cleanup INT TERM EXIT

    echo "T3 Code dev runner: $repo_dir"
    # No subshell: $! must be the setsid'd leader itself, whose process-group id
    # equals its pid, or the group kill above targets nothing. env -C supplies
    # the working directory without one.
    env -C "$repo_dir" setsid pnpm dev >"$runner_log" 2>&1 &
    runner_pid=$!

    # The runner picks its own ports and announces them on one line. The web
    # port is the browser origin; it proxies its own backend.
    web_port=""
    for _ in $(seq 120); do
      web_port="$(sed -e 's/\x1b\[[0-9;]*m//g' "$runner_log" |
        sed -n 's/.*\[dev-runner\].*webPort=\([0-9]\{1,\}\).*/\1/p' | head -n1)"
      [ -n "$web_port" ] && break
      if ! kill -0 "$runner_pid" 2>/dev/null; then
        echo "The dev runner exited before it reported a port:" >&2
        tail -n 20 "$runner_log" >&2
        exit 1
      fi
      sleep 1
    done
    if [ -z "$web_port" ]; then
      echo "Timed out waiting for the dev runner to report its port." >&2
      tail -n 20 "$runner_log" >&2
      exit 1
    fi

    # The runner keeps its state in a per-worktree directory. The dashboard
    # needs that same directory to mint its proxy session against the backend it
    # is actually proxying, rather than production's.
    runner_home="$(sed -e 's/\x1b\[[0-9;]*m//g' "$runner_log" |
      sed -n 's/.*\[dev-runner\].*baseDir=\([^ ]*\).*/\1/p' | head -n1)"
    if [ -z "$runner_home" ]; then
      echo "Could not determine the dev runner's data directory." >&2
      exit 1
    fi

    # T3CODE_UNIT= marks the instance unmanaged, so the dashboard disables the
    # service and build controls instead of acting on a unit that is not there.
    # --watch restarts the dashboard on save, the same as the runner does for
    # T3 Code.
    env \
      T3CODE_DASH_PORT="$dash_port" \
      T3CODE_PROXY_ORIGIN="http://localhost:$web_port" \
      T3CODE_HOME="$runner_home" \
      T3CODE_STATE_DIR="$runner_home/dashboard-state" \
      T3CODE_UNIT= \
      T3CODE_REPO="$repo_dir" \
      T3CODE_DEV_REPO="$repo_dir" \
      T3CODE_BRANCH="$branch" \
      T3CODE_DEV_BRANCH="$branch" \
      node --watch "$root/src/t3code-dashboard.mjs" &
    dashboard_pid=$!

    cat <<EOF

  dashboard   http://$host:$dash_port/          (node --watch, restarts on save)
  T3 Code     http://localhost:$web_port/  (hot reload, proxied by the dashboard)

Both reload on save. Ctrl-C stops them.
EOF
    echo "The dashboard presents a full-scope session to the console; no pairing needed."
    echo
    tail -f "$runner_log" &
    tail_pid=$!
    wait "$dashboard_pid"
    ;;

  check)
    T3CODE_INSTANCE="$instance" T3CODE_REPO="$repo_dir" "$root/check.sh"
    ;;

  down)
    # Only needed once, to clear an instance installed by an earlier version of
    # this script. Development itself installs nothing.
    T3CODE_INSTANCE="$instance" "$root/uninstall.sh"
    npm_prefix="${HOME}/.local/share/t3code-host-$instance/npm"
    if [ -d "$npm_prefix" ]; then
      echo "Removing the isolated npm prefix at $npm_prefix..."
      rm -rf "$npm_prefix"
    fi
    ;;

  *)
    sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
