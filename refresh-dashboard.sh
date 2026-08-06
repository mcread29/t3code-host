#!/usr/bin/env bash
# Replace one instance's dashboard and restart only its dashboard unit.
#
#   T3CODE_INSTANCE=production ./refresh-dashboard.sh
#
# This exists so a dashboard change never goes through install.sh. It does not
# build, does not install packages, does not touch Tailscale Serve, and never
# names the T3 Code unit -- so it cannot interrupt a running session, whatever
# else goes wrong.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/guard.sh
. "$root/lib/guard.sh"

instance="${T3CODE_INSTANCE:-production}"
if [[ ! "$instance" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "T3CODE_INSTANCE must contain only lowercase letters, numbers, and hyphens." >&2
  exit 1
fi

guard_instance "$instance" "refresh the dashboard of"

if [ "$instance" = production ]; then
  instance_suffix=""
else
  instance_suffix="-$instance"
fi

app_dir="${HOME}/.local/share/t3code-host$instance_suffix"
dashboard_unit="t3code-dashboard$instance_suffix.service"
source_file="$root/src/t3code-dashboard.mjs"
target_file="$app_dir/t3code-dashboard.mjs"

if ! systemctl --user cat "$dashboard_unit" >/dev/null 2>&1; then
  echo "No $dashboard_unit installed; nothing to refresh." >&2
  echo "Install the instance first with T3CODE_INSTANCE=$instance ./install.sh." >&2
  exit 1
fi

# Parse both halves before replacing anything. The browser script is a template
# literal inside the module, so the module parsing is no evidence that the page
# does, and a broken page is invisible server-side.
node --check "$source_file"
node -e '
  const fs = require("node:fs")
  const text = fs.readFileSync(process.argv[1], "utf8")
  const open = text.indexOf("<script>")
  const close = text.indexOf("</" + "script>")
  if (open < 0 || close < 0) throw new Error("could not find the browser script")
  const script = text.slice(open + 8, close).replaceAll("__TOKEN__", "x")
  new (require("node:vm").Script)(script, { filename: "dashboard page script" })
' "$source_file"

# Keep a symlinked dashboard linked; only a copied one is replaced.
if [ -L "$target_file" ]; then
  echo "$target_file is a symlink to $(readlink "$target_file"); leaving it in place."
else
  install -d "$app_dir"
  install -m 0644 "$source_file" "$target_file"
  echo "Installed $source_file -> $target_file"
fi

systemctl --user restart "$dashboard_unit"
echo "Restarted $dashboard_unit."

T3CODE_INSTANCE="$instance" "$root/check.sh"
