#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${HOME}/.local/bin"
app_dir="${HOME}/.local/share/t3code-host"
state_dir="${HOME}/.local/state/t3code-host"
unit_dir="${HOME}/.config/systemd/user"
channel="${T3CODE_CHANNEL:-nightly}"

for command_name in node npm tailscale systemctl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

node_bin="$(command -v node)"
npm_bin="$(command -v npm)"
node_dir="$(dirname "$node_bin")"

echo "Installing t3@$channel..."
"$npm_bin" install --global "t3@$channel"
t3_bin="$(command -v t3)"

echo "Replacing T3 Code's native service with the Tailnet-bound service..."
"$t3_bin" service uninstall 2>/dev/null || true

install -d "$bin_dir" "$app_dir" "$state_dir" "$unit_dir"
install -m 0755 "$root/src/t3code-serve-tailnet" "$bin_dir/t3code-serve-tailnet"
install -m 0644 "$root/src/t3code-dashboard.mjs" "$app_dir/t3code-dashboard.mjs"

sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@NODE_DIR@|$node_dir|g" \
  -e "s|@T3_BIN@|$t3_bin|g" \
  "$root/systemd/t3code.service.in" >"$unit_dir/t3code.service"
sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@NODE_BIN@|$node_bin|g" \
  -e "s|@NODE_DIR@|$node_dir|g" \
  -e "s|@NPM_BIN@|$npm_bin|g" \
  -e "s|@T3_BIN@|$t3_bin|g" \
  -e "s|@CHANNEL@|$channel|g" \
  "$root/systemd/t3code-dashboard.service.in" >"$unit_dir/t3code-dashboard.service"

systemctl --user daemon-reload
systemctl --user enable t3code.service t3code-dashboard.service
systemctl --user restart t3code.service t3code-dashboard.service

host="$(tailscale ip -4 | head -n1)"
echo "T3 Code:   http://${host}:4123"
echo "Dashboard: http://${host}:4124"
echo "Use the dashboard to publish T3 Code through Tailscale Serve and manage updates."
