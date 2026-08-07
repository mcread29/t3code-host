#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/guard.sh
. "$root/lib/guard.sh"

instance="${T3CODE_INSTANCE:-production}"
if [[ ! "$instance" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "T3CODE_INSTANCE must contain only lowercase letters, numbers, and hyphens." >&2
  exit 1
fi

guard_instance "$instance" "install over"

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

# Prints "<site url>\t<proxy target>" for the given HTTPS port, or nothing.
# `tailscale serve status` omits the port when it is 443, so match both forms.
serve_site() {
  tailscale serve status 2>/dev/null |
    awk -v port=":$1" -v bare="$([ "$1" = 443 ] && echo 1 || echo 0)" '
      /^https:\/\// { site = $1; want = (site ~ port) || (bare && site !~ /:[0-9]+$/); next }
      want && /proxy/ { print site "\t" $NF; exit }
    '
}

# Tailscale Serve ports are shared across everything on this machine, so a
# collision would quietly steal someone else's endpoint. Say so now rather than
# after a multi-minute build.
serve_owner="$(serve_site "$pair_port" | cut -f2)"
case "${serve_owner:-}" in
  '' | *":$dashboard_port" | *":$service_port") ;;
  *)
    echo "Tailscale Serve port $pair_port is already proxying to $serve_owner." >&2
    if [ "$instance" = production ]; then
      echo "Free it first: tailscale serve --https=$pair_port off" >&2
    else
      echo "Pick another with T3CODE_TEST_PAIR_PORT, or free it: tailscale serve --https=$pair_port off" >&2
    fi
    exit 1
    ;;
esac

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

# The npm shim of mise calls `mise reshim` after a global install. The unit must
# have mise on its path. If it does not, the deploy job stops with code 127
# after a correct install. Find the directory. Do not guess it.
mise_bin="$(command -v mise 2>/dev/null || true)"
if [ -n "$mise_bin" ]; then
  extra_path="$(dirname "$mise_bin"):"
else
  extra_path=""
fi

npm_install_args=(install --global)
if [ -n "$npm_prefix" ]; then
  npm_install_args+=(--prefix "$npm_prefix")
fi

# Each path has one blast radius:
#
#   units.sh     the units, the launcher, the dashboard, and the Serve mapping.
#                It restarts the dashboard. It does not touch T3 Code.
#   install.sh   each of those, and the source build when the build is not
#                current. It restarts T3 Code only when it built something.
#
# T3CODE_SKIP_BUILD=1 is what units.sh sets to get the first path.
skip_build="${T3CODE_SKIP_BUILD:-0}"

if [ "$skip_build" = 1 ]; then
  echo "Skipping the source build (T3CODE_SKIP_BUILD=1); refreshing the dashboard only."
else

# The npm fallback and the git preparation only matter on a first install. A
# rebuild loop skips them and goes straight to building the worktree as it is.
if [ "${T3CODE_SKIP_BOOTSTRAP:-0}" = 1 ]; then
  echo "Rebuilding $repo_dir as-is (T3CODE_SKIP_BOOTSTRAP=1)."
else

# Bootstrap from npm first so a working t3 exists even if the source build
# fails below. The source build then installs over it.
echo "Installing t3@$channel as a fallback..."
CI=1 "$npm_bin" "${npm_install_args[@]}" "t3@$channel"

echo "Preparing the fork checkout at $repo_dir..."
# -e, not -d: a linked worktree's .git is a file. This lets an instance be
# pointed at an existing worktree (T3CODE_REPO=.../dev) instead of a new clone.
if [ ! -e "$repo_dir/.git" ]; then
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

# A production install builds a pristine deploy worktree, so uncommitted work
# there is a mistake. An instance pointed at a development worktree is expected
# to be dirty -- building exactly what you are editing is the whole point.
if [ -n "$(git -C "$repo_dir" status --porcelain)" ]; then
  if [ "${T3CODE_ALLOW_DIRTY:-0}" != 1 ]; then
    echo "Deployment worktree is not clean: $repo_dir" >&2
    echo "Move active development to $dev_dir, or set T3CODE_ALLOW_DIRTY=1 to build it as-is." >&2
    exit 1
  fi
  echo "Note: $repo_dir has uncommitted changes; building them as-is."
fi

# Active development has its own branch and worktree. This keeps generated or
# uncommitted development files out of the dashboard-managed deploy worktree.
# When the two are the same path the instance already builds development
# directly, and there is no second worktree to create.
if [ "$dev_dir" != "$repo_dir" ]; then
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
fi

fi # skip_bootstrap

# The source build takes minutes. Do it only when the worktree moved after the
# last build, or when a build asset is absent. T3CODE_FORCE_BUILD=1 always does
# the build.
head_sha="$(git -C "$repo_dir" rev-parse --short HEAD)"
built_sha="$(cat "$state_dir/built-sha" 2>/dev/null || true)"
build_current=0
if [ "${T3CODE_FORCE_BUILD:-0}" != 1 ] && [ -n "$built_sha" ] && [ "$head_sha" = "$built_sha" ]; then
  build_current=1
  for asset in dist/bin.mjs dist/service-launcher.mjs dist/client/index.html; do
    [ -f "$repo_dir/apps/server/$asset" ] || build_current=0
  done
fi

build_ok=1
if [ "$build_current" = 1 ]; then
  # The global install below still runs. It is quick, and it makes sure that
  # the global t3 command points at this worktree.
  echo "The build at $head_sha is current. Skipping the source build."
else
echo "Building T3 Code from $branch..."
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
fi

if [ "$build_ok" = 1 ]; then
  echo "Installing the source build globally..."
  CI=1 "$npm_bin" "${npm_install_args[@]}" "$repo_dir/apps/server"
  install -d "$state_dir"
  git -C "$repo_dir" rev-parse --short HEAD >"$state_dir/built-sha"
else
  echo "Source build failed. Keeping the npm install; use the dashboard to retry." >&2
fi

fi # skip_build

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

# Linking instead of copying lets an instance pick up dashboard edits from this
# checkout on a plain `systemctl --user restart`, with no reinstall.
if [ "${T3CODE_LINK_DASHBOARD:-0}" = 1 ]; then
  ln -sfn "$root/src/t3code-dashboard.mjs" "$app_dir/t3code-dashboard.mjs"
  echo "Dashboard linked to $root/src/t3code-dashboard.mjs (edits apply on restart)."
else
  rm -f "$app_dir/t3code-dashboard.mjs"
  install -m 0644 "$root/src/t3code-dashboard.mjs" "$app_dir/t3code-dashboard.mjs"
fi

# A change to the T3 Code unit becomes active at the next restart of T3 Code.
# This run restarts T3 Code only after a build, so a user who runs units.sh
# gets a message and chooses the moment.
service_unit_before="$(cat "$unit_dir/$service_unit" 2>/dev/null || true)"

sed \
  -e "s|@HOME@|$HOME|g" \
  -e "s|@NODE_DIR@|$node_dir|g" \
  -e "s|@EXTRA_PATH@|$extra_path|g" \
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
  -e "s|@EXTRA_PATH@|$extra_path|g" \
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

# Restart T3 Code only when this run made a new build. A restart drops each
# connected client and stops the work in the console. A run that compiled
# nothing cannot change T3 Code, so it must not stop it.
if [ "$skip_build" = 1 ] || [ "${build_current:-0}" = 1 ]; then
  echo "T3 Code is unchanged; restarting the dashboard only."
  systemctl --user restart "$dashboard_unit"
  if [ "$service_unit_before" != "$(cat "$unit_dir/$service_unit")" ]; then
    echo
    echo "NOTE: $service_unit changed. The change becomes active at the next"
    echo "      restart of T3 Code. That restart stops your sessions, so do it"
    echo "      when it suits you:"
    echo "        systemctl --user restart $service_unit"
  fi
else
  systemctl --user restart "$service_unit" "$dashboard_unit"
fi

host="$(tailscale ip -4 | head -n1)"

# Serve publishes the dashboard rather than T3. The dashboard proxies T3 at "/"
# on the same origin, so one HTTPS endpoint covers both, the embedded console
# shares the dashboard's session cookie, and pairing links can be minted
# locally instead of letting `t3 pair --tailscale` own this mapping.
#
# Every Serve port shares one MagicDNS hostname, and cookies ignore ports. A
# second instance published there would overwrite production's session cookie
# and silently downgrade that browser's scopes, so an instance can opt out and
# stay on its tailnet address.
if [ "${T3CODE_SKIP_SERVE:-0}" = 1 ]; then
  echo "Skipping the Tailscale Serve mapping (T3CODE_SKIP_SERVE=1)."
elif ! tailscale serve --bg --https="$pair_port" "http://${host}:${dashboard_port}" >/dev/null; then
  echo "Tailscale Serve could not publish HTTPS port $pair_port." >&2
  echo "Check: tailscale serve status" >&2
  exit 1
fi

serve_url="$(serve_site "$pair_port" | cut -f1)"

if [ -n "$serve_url" ]; then
  echo "Dashboard ($instance): $serve_url"
  echo "  also on the tailnet address: http://${host}:${dashboard_port}"
else
  echo "Dashboard ($instance): http://${host}:${dashboard_port}"
fi
echo "T3 Code ($instance):   http://${host}:${service_port} (embedded in the dashboard)"
echo "Use the dashboard to create pairing links and manage updates."
