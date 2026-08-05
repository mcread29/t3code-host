#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
  pair_port="${T3CODE_TEST_PAIR_PORT:-8443}"
fi

app_name="t3code-host$instance_suffix"
service_unit="t3code$instance_suffix.service"
dashboard_unit="t3code-dashboard$instance_suffix.service"
serve_name="t3code-serve-tailnet$instance_suffix"
bin_dir="${HOME}/.local/bin"
app_dir="${HOME}/.local/share/$app_name"
state_dir="${HOME}/.local/state/$app_name"
unit_dir="${HOME}/.config/systemd/user"
channel="${T3CODE_CHANNEL:-nightly}"
npm_prefix="${T3CODE_NPM_PREFIX:-}"

if [ "$instance" != production ] && [ -z "$npm_prefix" ]; then
  npm_prefix="$app_dir/npm"
fi

if [ "$instance" = production ]; then
  t3_home="${T3CODE_HOME:-${HOME}/.t3}"
else
  t3_home="${T3CODE_TEST_HOME:-$app_dir/t3-home}"
fi

repo_dir="${T3CODE_REPO:-$app_dir/src}"
dev_dir="${T3CODE_DEV_REPO:-$app_dir/dev}"
fork_url="${T3CODE_FORK_URL:-git@github.com:mcread29/t3code.git}"
upstream_url="${T3CODE_UPSTREAM_URL:-git@github.com:pingdotgg/t3code.git}"
branch="${T3CODE_BRANCH:-deploy}"
dev_branch="${T3CODE_DEV_BRANCH:-dev}"

for command_name in node npm pnpm git tailscale systemctl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
done

# The resource monitor is native and optional; T3 runs without it.
if ! command -v cargo >/dev/null 2>&1; then
  echo "Note: cargo not found — the resource monitor will be skipped."
fi

node_bin="$(command -v node)"
npm_bin="${T3CODE_NPM_BIN:-$(command -v npm)}"
# Vite+'s npm shim can create links in its shared bin directory after a global
# install. Use a native npm executable for isolated instances when available.
if [ "$instance" != production ] && [ -z "${T3CODE_NPM_BIN:-}" ]; then
  while IFS= read -r npm_candidate; do
    if [[ "$(readlink -f "$npm_candidate")" != *"/.vite-plus/"* ]]; then
      npm_bin="$npm_candidate"
      break
    fi
  done < <(type -a -p npm | awk '!seen[$0]++')
fi
pnpm_bin="$(command -v pnpm)"
node_dir="$(dirname "$node_bin")"

# Bootstrap from npm first so a working t3 exists even if the source build
# fails below. The source build then installs over it.
echo "Installing t3@$channel as a fallback..."
npm_install_args=(install --global)
if [ -n "$npm_prefix" ]; then
  npm_install_args+=(--prefix "$npm_prefix")
fi
CI=1 "$npm_bin" "${npm_install_args[@]}" "t3@$channel"

echo "Preparing the fork checkout at $repo_dir..."
if [ ! -d "$repo_dir/.git" ]; then
  git clone "$fork_url" "$repo_dir"
fi
if ! git -C "$repo_dir" remote get-url upstream >/dev/null 2>&1; then
  git -C "$repo_dir" remote add upstream "$upstream_url"
fi
git -C "$repo_dir" fetch --prune --multiple origin upstream

# main mirrors upstream; "$branch" is the clean worktree that gets built and deployed.
if ! git -C "$repo_dir" show-ref --verify --quiet "refs/heads/$branch"; then
  if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    git -C "$repo_dir" branch "$branch" "origin/$branch"
  else
    git -C "$repo_dir" branch "$branch" origin/main
    git -C "$repo_dir" push -u origin "$branch"
  fi
fi
git -C "$repo_dir" checkout "$branch"

if [ -n "$(git -C "$repo_dir" status --porcelain)" ]; then
  echo "Deployment worktree is not clean: $repo_dir" >&2
  echo "Move active development to $dev_dir before installation." >&2
  exit 1
fi

# Active development has its own branch and worktree. This keeps generated or
# uncommitted development files out of the dashboard-managed deploy worktree.
if ! git -C "$repo_dir" show-ref --verify --quiet "refs/heads/$dev_branch"; then
  if git -C "$repo_dir" show-ref --verify --quiet "refs/remotes/origin/$dev_branch"; then
    git -C "$repo_dir" branch "$dev_branch" "origin/$dev_branch"
  else
    git -C "$repo_dir" branch "$dev_branch" "$branch"
  fi
fi
if [ ! -e "$dev_dir/.git" ]; then
  if [ -e "$dev_dir" ]; then
    echo "Development worktree path exists but is not a Git worktree: $dev_dir" >&2
    exit 1
  fi
  git -C "$repo_dir" worktree add "$dev_dir" "$dev_branch"
fi

echo "Building T3 Code from $branch..."
build_ok=1
(
  cd "$repo_dir"
  "$pnpm_bin" install --frozen-lockfile
  "$pnpm_bin" exec vp run --filter @t3tools/web build
  node apps/server/scripts/cli.ts build --verbose
  if command -v cargo >/dev/null 2>&1; then
    "$pnpm_bin" run build:resource-monitor || echo "Resource monitor build failed; continuing."
    target="apps/server/dist/resource-monitor/linux-x64"
    if [ -f native/resource-monitor/target/release/t3-resource-monitor ]; then
      mkdir -p "$target"
      cp native/resource-monitor/target/release/t3-resource-monitor "$target/"
      chmod +x "$target/t3-resource-monitor"
    fi
  fi
) || build_ok=0

if [ "$build_ok" = 1 ]; then
  echo "Installing the source build globally..."
  CI=1 "$npm_bin" "${npm_install_args[@]}" "$repo_dir/apps/server"
  install -d "$state_dir"
  git -C "$repo_dir" rev-parse --short HEAD >"$state_dir/built-sha"
else
  echo "Source build failed. Keeping the npm install; use the dashboard to retry." >&2
fi

if [ -n "$npm_prefix" ]; then
  t3_bin="$npm_prefix/bin/t3"
else
  t3_bin="$(command -v t3)"
fi

if [ "$instance" = production ]; then
  echo "Replacing T3 Code's native service with the Tailnet-bound service..."
  "$t3_bin" service uninstall 2>/dev/null || true
else
  echo "Installing isolated $instance services; the production service will not be changed."
fi

install -d "$bin_dir" "$app_dir" "$state_dir" "$unit_dir" "$t3_home"
install -m 0755 "$root/src/t3code-serve-tailnet" "$bin_dir/$serve_name"
install -m 0644 "$root/src/t3code-dashboard.mjs" "$app_dir/t3code-dashboard.mjs"

sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@NODE_DIR@|$node_dir|g" \
  -e "s|@T3_BIN@|$t3_bin|g" \
  -e "s|@T3_HOME@|$t3_home|g" \
  -e "s|@PORT@|$service_port|g" \
  -e "s|@SERVE_BIN@|$bin_dir/$serve_name|g" \
  -e "s|@STATE_DIR@|$state_dir|g" \
  "$root/systemd/t3code.service.in" >"$unit_dir/$service_unit"
sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@NODE_BIN@|$node_bin|g" \
  -e "s|@NODE_DIR@|$node_dir|g" \
  -e "s|@NPM_BIN@|$npm_bin|g" \
  -e "s|@PNPM_BIN@|$pnpm_bin|g" \
  -e "s|@T3_BIN@|$t3_bin|g" \
  -e "s|@T3_HOME@|$t3_home|g" \
  -e "s|@CHANNEL@|$channel|g" \
  -e "s|@NPM_PREFIX@|$npm_prefix|g" \
  -e "s|@DASH_PORT@|$dashboard_port|g" \
  -e "s|@PAIR_PORT@|$pair_port|g" \
  -e "s|@SERVICE_UNIT@|$service_unit|g" \
  -e "s|@APP_DIR@|$app_dir|g" \
  -e "s|@STATE_DIR@|$state_dir|g" \
  -e "s|@REPO@|$repo_dir|g" \
  -e "s|@DEV_REPO@|$dev_dir|g" \
  -e "s|@BRANCH@|$branch|g" \
  -e "s|@DEV_BRANCH@|$dev_branch|g" \
  "$root/systemd/t3code-dashboard.service.in" >"$unit_dir/$dashboard_unit"

systemctl --user daemon-reload
systemctl --user enable "$service_unit" "$dashboard_unit"
systemctl --user restart "$service_unit" "$dashboard_unit"

host="$(tailscale ip -4 | head -n1)"

# Pairing owns the Tailscale Serve mapping and refuses to replace an unrelated
# target. The service can take a few seconds to write its runtime state, so
# retry before treating publication as failed. The one-second link is discarded;
# this step only establishes the persistent HTTPS proxy.
serve_ready=0
for _ in {1..20}; do
  if T3CODE_HOME="$t3_home" "$t3_bin" pair \
    --tailscale \
    --ttl 1s \
    --label "$instance installer exposure check" \
    --tailscale-serve-port "$pair_port" \
    >/dev/null 2>&1; then
    serve_ready=1
    break
  fi
  sleep 1
done

if [ "$serve_ready" != 1 ]; then
  echo "T3 Code is running, but Tailscale Serve could not publish HTTPS port $pair_port." >&2
  echo "Check: tailscale serve status" >&2
  exit 1
fi

echo "T3 Code ($instance):   http://${host}:${service_port}"
echo "Dashboard ($instance): http://${host}:${dashboard_port}"
echo "Tailscale Serve:        HTTPS port ${pair_port}"
echo "Use the dashboard to create pairing links and manage updates."
