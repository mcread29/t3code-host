#!/usr/bin/env bash
# Make the units, the launcher, the dashboard, and the Serve mapping current.
#
# This path does not touch T3 Code. It compiles nothing. It moves no branch. It
# restarts the dashboard only, so the sessions in the console continue.
#
# Use this command after a change to a file in systemd/, or to the dashboard.
# `refresh-dashboard.sh` is quicker, but it does not render the units again.
#
#   T3CODE_INSTANCE=production ./units.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T3CODE_SKIP_BUILD=1 exec "$root/install.sh" "$@"
