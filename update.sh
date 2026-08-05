#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
instance="${T3CODE_INSTANCE:-production}"
if [[ ! "$instance" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "T3CODE_INSTANCE must contain only lowercase letters, numbers, and hyphens." >&2
  exit 1
fi

if [ "$instance" = production ]; then
  app_name="t3code-host"
else
  app_name="t3code-host-$instance"
fi

app_dir="${HOME}/.local/share/$app_name"
state_dir="${HOME}/.local/state/$app_name"
repo_dir="${T3CODE_REPO:-$app_dir/src}"
dev_dir="${T3CODE_DEV_REPO:-$app_dir/dev}"
branch="${T3CODE_BRANCH:-deploy}"
dev_branch="${T3CODE_DEV_BRANCH:-dev}"

if [ ! -d "$repo_dir/.git" ]; then
  echo "No managed deployment checkout exists at $repo_dir." >&2
  echo "Run ./install.sh first." >&2
  exit 1
fi

checked_out="$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD)"
if [ "$checked_out" != "$branch" ]; then
  echo "The deployment worktree must have $branch checked out, not $checked_out." >&2
  exit 1
fi

if [ -n "$(git -C "$repo_dir" status --porcelain)" ]; then
  echo "The deployment worktree is not clean: $repo_dir" >&2
  exit 1
fi

echo "Fetching the fork and upstream..."
git -C "$repo_dir" fetch --prune --multiple origin upstream

if ! git -C "$repo_dir" merge-base --is-ancestor main upstream/main; then
  echo "Local main cannot fast-forward to upstream/main. Inspect it manually." >&2
  exit 1
fi

if ! git -C "$repo_dir" merge-tree --write-tree "$branch" upstream/main >/dev/null; then
  echo "Upstream conflicts with $branch. Merge it manually in $dev_dir." >&2
  exit 1
fi

echo "Updating main from upstream..."
git -C "$repo_dir" branch -f main upstream/main
git -C "$repo_dir" push origin main

echo "Merging main into $branch..."
if ! git -C "$repo_dir" merge --no-ff --no-edit main; then
  git -C "$repo_dir" merge --abort 2>/dev/null || true
  echo "The merge changed while it ran and was aborted." >&2
  exit 1
fi

echo "Rebuilding and restarting the $instance instance..."
T3CODE_INSTANCE="$instance" \
T3CODE_REPO="$repo_dir" \
T3CODE_DEV_REPO="$dev_dir" \
T3CODE_BRANCH="$branch" \
T3CODE_DEV_BRANCH="$dev_branch" \
  "$root/install.sh"

expected_sha="$(git -C "$repo_dir" rev-parse --short HEAD)"
built_sha="$(<"$state_dir/built-sha")"
if [ "$built_sha" != "$expected_sha" ]; then
  echo "The source build did not deploy $expected_sha; $branch was not pushed." >&2
  exit 1
fi

git -C "$repo_dir" push origin "$branch"
echo "Updated, rebuilt, and restarted $instance at $expected_sha."
