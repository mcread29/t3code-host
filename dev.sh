#!/usr/bin/env bash
# Development: the dashboard shell alone, with a stub.
#
# This script runs the dashboard only. src/dev-stub-t3.mjs replaces T3 Code.
# The stub is a placeholder that answers the proxy. There is no worktree of the
# fork, no build from the source, and no delay of some minutes. The shell
# starts in seconds. It starts again after you save a file.
#
# To use the real T3 Code, start the dev server from the production dashboard.
# That dashboard runs the dev server of the fork from the development worktree.
# It also puts a deploy/dev switch in the console header.
#
# This script installs nothing. It makes no systemd units. It publishes no
# Tailscale Serve address. The production instance stays unchanged. Ctrl-C
# stops the script.
#
#   ./dev.sh          run the dashboard with the stub
#   ./dev.sh check    test the instance
#   ./dev.sh down     remove an installed dev instance
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/guard.sh
. "$root/lib/guard.sh"

# --dash-only is the only behaviour now. The script accepts the option, because
# you can continue to type it.
args=()
for arg in "$@"; do
  case "$arg" in
    --dash-only) ;;
    *) args+=("$arg") ;;
  esac
done
command_name="${args[0]:-serve}"

instance="${T3CODE_INSTANCE:-dev}"
prod_app_dir="${T3CODE_PROD_APP_DIR:-${HOME}/.local/share/t3code-host}"

repo_dir="${T3CODE_REPO:-$prod_app_dir/dev}"
branch="${T3CODE_BRANCH:-dev}"
dash_port="${T3CODE_TEST_DASH_PORT:-5124}"

# Development must never use the instance or the ports of production. This
# rule applies to all values in the environment.
guard_not_production "$instance" "$dash_port"

# Parse the two parts of the dashboard before you start it. The browser script
# is a template literal in the module. Thus a correct module does not show that
# the page is correct. The server does not see an incorrect page.
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
    verify_dashboard_source
    node --check "$root/src/dev-stub-t3.mjs" ||
      { echo "the T3 Code stub has a syntax error" >&2; exit 1; }

    host="$(tailscale ip -4 2>/dev/null | head -n1)"
    if [ -z "$host" ]; then
      echo "No Tailscale IPv4 address; is tailscaled up?" >&2
      exit 1
    fi

    stub_log="$(mktemp -t t3code-dev-stub.XXXXXX.log)"
    stub_home="$(mktemp -d -t t3code-dev-stub.XXXXXX)"
    dashboard_pid=""
    stub_pid=""
    tail_pid=""
    cleanup() {
      trap - INT TERM EXIT
      # Each step can fail. A process that stopped already must not stop the
      # steps below it. If it does, set -e leaves the temporary files.
      [ -n "$tail_pid" ] && kill "$tail_pid" 2>/dev/null || :
      # node --watch runs the dashboard as a child. That child holds the port.
      # Send the signal to the group. If you do not, the next run gives
      # EADDRINUSE.
      [ -n "$dashboard_pid" ] && kill -- "-$dashboard_pid" 2>/dev/null || :
      [ -n "$stub_pid" ] && kill -- "-$stub_pid" 2>/dev/null || :
      sleep 1
      [ -n "$stub_pid" ] && kill -9 -- "-$stub_pid" 2>/dev/null || :
      rm -f "$stub_log"
      [ -n "$stub_home" ] && rm -rf "$stub_home" || :
      return 0
    }
    trap cleanup INT TERM EXIT

    # Do not use a subshell. The value of $! must be the leader from setsid.
    # The process-group id of that leader is equal to its pid. Without this, the
    # group kill above finds no process.
    env T3CODE_STUB_HOME="$stub_home" setsid \
      node "$root/src/dev-stub-t3.mjs" >"$stub_log" 2>&1 &
    stub_pid=$!

    # The stub prints its port in the format of the dev runner.
    web_port=""
    for _ in $(seq 30); do
      web_port="$(sed -n 's/.*webPort=\([0-9]\{1,\}\).*/\1/p' "$stub_log" | head -n1)"
      [ -n "$web_port" ] && break
      if ! kill -0 "$stub_pid" 2>/dev/null; then
        echo "The stub exited before it reported a port:" >&2
        tail -n 20 "$stub_log" >&2
        exit 1
      fi
      sleep 1
    done
    if [ -z "$web_port" ]; then
      echo "Timed out waiting for the stub to report its port." >&2
      tail -n 20 "$stub_log" >&2
      exit 1
    fi

    # T3CODE_UNIT= shows that systemd does not manage this instance. Thus the
    # dashboard disables the service controls and the build controls. It does
    # not use a unit that does not exist.
    # T3CODE_DEV_REPO= disables the dev runner controls. The runner belongs to
    # the production dashboard, which has a development worktree.
    env \
      T3CODE_DASH_PORT="$dash_port" \
      T3CODE_PROXY_ORIGIN="http://localhost:$web_port" \
      T3CODE_HOME="$stub_home" \
      T3CODE_STATE_DIR="$stub_home/dashboard-state" \
      T3CODE_UNIT= \
      T3CODE_REPO="$repo_dir" \
      T3CODE_DEV_REPO= \
      T3CODE_BRANCH="$branch" \
      T3CODE_DEV_BRANCH="$branch" \
      setsid node --watch "$root/src/t3code-dashboard.mjs" &
    dashboard_pid=$!

    cat <<EOF

  dashboard   http://$host:$dash_port/dashboard   (node --watch, restarts on save)
  T3 Code     http://localhost:$web_port/         (stub placeholder, not the console)

The dashboard reloads on save. Ctrl-C stops it.
EOF
    echo
    tail -f "$stub_log" &
    tail_pid=$!
    wait "$dashboard_pid"
    ;;

  check)
    T3CODE_INSTANCE="$instance" T3CODE_REPO="$repo_dir" "$root/check.sh"
    ;;

  down)
    # Use this command one time, to remove an instance from an earlier version
    # of this script. Development installs nothing.
    T3CODE_INSTANCE="$instance" "$root/uninstall.sh"
    npm_prefix="${HOME}/.local/share/t3code-host-$instance/npm"
    if [ -d "$npm_prefix" ]; then
      echo "Removing the isolated npm prefix at $npm_prefix..."
      rm -rf "$npm_prefix"
    fi
    ;;

  *)
    sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
