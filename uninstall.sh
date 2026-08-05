#!/usr/bin/env bash
set -euo pipefail

instance="${T3CODE_INSTANCE:-production}"
if [[ ! "$instance" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "T3CODE_INSTANCE must contain only lowercase letters, numbers, and hyphens." >&2
  exit 1
fi

if [ "$instance" = production ]; then
  instance_suffix=""
else
  instance_suffix="-$instance"
fi

app_name="t3code-host$instance_suffix"
service_unit="t3code$instance_suffix.service"
dashboard_unit="t3code-dashboard$instance_suffix.service"
serve_name="t3code-serve-tailnet$instance_suffix"

systemctl --user disable --now "$dashboard_unit" "$service_unit" 2>/dev/null || true
rm -f \
  "${HOME}/.config/systemd/user/$dashboard_unit" \
  "${HOME}/.config/systemd/user/$service_unit" \
  "${HOME}/.local/bin/$serve_name" \
  "${HOME}/.local/share/$app_name/t3code-dashboard.mjs"
systemctl --user daemon-reload
echo "Removed the $instance dashboard and Tailnet-bound T3 Code service."
echo "The npm package and Tailscale Serve mappings were left installed."
echo "The fork checkout at ${T3CODE_REPO:-${HOME}/.local/share/$app_name/src} was kept;"
echo "it may hold local commits. Remove it by hand once you are sure."
