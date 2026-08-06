#!/usr/bin/env bash
# Shared guard for scripts that change a running instance.
#
# Production is where real work happens -- including the agent sessions used to
# develop this repository -- so acting on it must always be a deliberate,
# named choice. Defaulting to it means an unrelated command can interrupt live
# work, which is exactly how this has gone wrong before.

# Refuses to touch production unless the caller named it and confirmed.
#
#   guard_instance <instance> <verb>
#
# Naming it: T3CODE_INSTANCE must be set explicitly in the environment, so a
# bare ./install.sh can never mean production.
# Confirming it: an interactive run prompts; a non-interactive one requires
# T3CODE_YES=1, so automation cannot restart production as a side effect.
guard_instance() {
  local instance="$1"
  local verb="$2"

  [ "$instance" != production ] && return 0

  if [ -z "${T3CODE_INSTANCE+set}" ]; then
    cat >&2 <<EOF
Refusing to $verb production, because no instance was named.

  T3CODE_INSTANCE=production $0    # act on production, deliberately
  T3CODE_INSTANCE=testing    $0    # act on an isolated instance instead

Development needs neither: run ./dev.sh.
EOF
    exit 1
  fi

  [ "${T3CODE_YES:-0}" = 1 ] && return 0

  if [ -t 0 ]; then
    local reply
    read -r -p "This will $verb PRODUCTION. Type 'production' to continue: " reply
    [ "$reply" = production ] && return 0
    echo "Aborted." >&2
    exit 1
  fi

  cat >&2 <<EOF
Refusing to $verb production without a terminal to confirm at.

Re-run it yourself, or pass T3CODE_YES=1 if you intend this to be automatic.
EOF
  exit 1
}

# Development must never resolve to production's instance, ports, or worktree.
#
#   guard_not_production <instance> <port>...
guard_not_production() {
  local instance="$1"
  shift

  if [ "$instance" = production ]; then
    echo "This command is for development instances; it will not act on production." >&2
    exit 1
  fi

  local port
  for port in "$@"; do
    case "$port" in
      "${T3CODE_PORT:-4123}" | "${T3CODE_DASH_PORT:-4124}")
        echo "Port $port belongs to production; refusing to bind it here." >&2
        exit 1
        ;;
    esac
  done
}
