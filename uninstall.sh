#!/usr/bin/env bash
set -euo pipefail

systemctl --user disable --now t3code-dashboard.service t3code.service 2>/dev/null || true
rm -f \
  "${HOME}/.config/systemd/user/t3code-dashboard.service" \
  "${HOME}/.config/systemd/user/t3code.service" \
  "${HOME}/.local/bin/t3code-serve-tailnet" \
  "${HOME}/.local/share/t3code-host/t3code-dashboard.mjs"
systemctl --user daemon-reload
echo "Removed the dashboard and Tailnet-bound T3 Code service."
echo "The global t3 package and Tailscale Serve mappings were left installed."
