# t3code-host

Runs T3 Code on a machine's Tailnet address and provides a small Tailnet-only
dashboard for service control, updates, and pairing-link creation. Tailscale
Serve supplies the persistent HTTPS endpoint.

This deliberately uses a dashboard-managed `t3 serve --host <Tailnet IP>`
service instead of `t3 service install`. Binding T3 to a non-loopback address
enables its full **Network access**, **Authorized clients**, and **Create link**
interface. Because this is not T3's native launcher, package updates are
installed and activated by the dashboard.

## Requirements

- Linux with systemd user services
- Node.js, npm, and pnpm
- Git
- Tailscale, connected to a tailnet with MagicDNS enabled
- Rust/`cargo` for the native resource monitor (optional)
- GitHub CLI (`gh`) for dashboard changelogs (optional)

## Install

```bash
git clone <your-repository-url> t3code-host
cd t3code-host
./install.sh
```

The default package channel is `nightly`. To track stable releases:

```bash
T3CODE_CHANNEL=latest ./install.sh
```

The installer:

1. Installs the selected global `t3` package as a fallback.
2. Clones the fork, builds it, and installs that build over the fallback.
3. Removes T3's native loopback-only service if it is installed.
4. Installs a systemd user service running T3 in web mode on the machine's
   Tailnet IPv4 address at port 4123.
5. Installs the dashboard on that address at port 4124.
6. Publishes T3 through Tailscale Serve on HTTPS port 443.

If the source build fails, the npm package stays installed and the service
keeps running. Retry the build from the dashboard.

```text
T3 Code:   http://<tailscale-ip>:4123
Dashboard: http://<tailscale-ip>:4124
```

The installer creates the Tailscale Serve mapping by requesting a one-second
pairing link and discarding it. This uses T3's mapping validation, so the
installer will not overwrite an HTTPS port that serves an unrelated target.

### Isolated testing instance

Install a second instance without changing or restarting production:

```bash
T3CODE_INSTANCE=testing ./install.sh
```

The testing instance uses separate service units, worktrees, state, logs, and
an isolated npm prefix. It also publishes its own Tailscale Serve mapping:

```text
T3 Code:   http://<tailscale-ip>:5123
Dashboard: http://<tailscale-ip>:5124
Pairing:   HTTPS port 8443
Units:     t3code-testing.service, t3code-dashboard-testing.service
Files:     ~/.local/share/t3code-host-testing
```

Override the two testing ports with `T3CODE_TEST_PORT` and
`T3CODE_TEST_DASH_PORT`, and override the testing Tailscale Serve port with
`T3CODE_TEST_PAIR_PORT`. The testing instance also uses an isolated
`T3CODE_HOME`, so pairing credentials and runtime discovery cannot affect
production. These variables are separate from production configuration. Remove
only the testing services with `T3CODE_INSTANCE=testing ./uninstall.sh`. The
testing worktrees and npm prefix are kept for inspection. Set `T3CODE_NPM_BIN`
if the testing instance must use a specific npm executable.

## Tailscale Serve and pairing

Use the dashboard's pairing section to publish T3 through Tailscale Serve and
create links. Port 443 is the default. The equivalent terminal command is:

```bash
t3 pair --tailscale --ttl 15m --label "client name"
```

Once configured, T3 is available at a persistent HTTPS MagicDNS URL such as:

```text
https://outpost.example-tailnet.ts.net
```

**Create client link** grants T3's standard five scopes. **Create administrator
link** restarts T3 and captures its short-lived startup credential, granting
the trusted browser all eight scopes including `access:write`. Once an
administrator browser is established, further links can be created inside T3
Code's own Connections screen.

## Building from a fork

The installer creates two worktrees. The dashboard owns the clean deployment
worktree at `~/.local/share/t3code-host/src`. Active development happens in
`~/.local/share/t3code-host/dev`.

Three branches are involved:

```text
upstream/main  --sync-->  main  --merge-->  deploy  --build-->  running service
                                      ^
                                      |
                          dev  --merge+
```

`main` is a pure mirror of upstream. `deploy` is always checked out in the
dashboard-owned worktree and must stay clean. Make and commit local changes in
the separate `dev` worktree. The dashboard can merge those commits into
`deploy`, build them, and restart the service.

Configure with environment variables at install time:

| Variable | Default |
| --- | --- |
| `T3CODE_REPO` | `~/.local/share/t3code-host/src` |
| `T3CODE_DEV_REPO` | `~/.local/share/t3code-host/dev` |
| `T3CODE_FORK_URL` | `git@github.com:mcread29/t3code.git` |
| `T3CODE_UPSTREAM_URL` | `git@github.com:pingdotgg/t3code.git` |
| `T3CODE_BRANCH` | `deploy` |
| `T3CODE_DEV_BRANCH` | `dev` |

The dashboard's fork card shows how far each branch has fallen behind and
pre-checks both merges with `git merge-tree`, so conflicts are reported before
anything is modified. **Sync, build & deploy** is enabled only when both merges
are conflict-free and the worktree is clean. It runs:

1. Fetch `origin` and `upstream`
2. Fast-forward `main` to `upstream/main`, push
3. Merge `main` into `deploy` (`--no-ff`)
4. `pnpm install`, build the web client, build the CLI, build the resource
   monitor if `cargo` is present
5. `npm install -g <repo>/apps/server`
6. Restart `t3code.service`, then push `deploy`

The build never touches the running service until it has succeeded. A merge
that unexpectedly conflicts is aborted, never auto-resolved. **Rebuild &
deploy** repeats steps 4-6 without any git changes. **Merge dev, build &
deploy** requires both worktrees to be clean, merges committed `dev` changes
into `deploy`, builds, restarts, and pushes `deploy`.

Builds take minutes, so they run as a background job that the page polls; the
output streams into the log pane and survives a browser refresh. Only one job
runs at a time.

## Updates

Update the source deployment from upstream with:

```bash
./update.sh
```

This requires the managed `deploy` worktree to be clean. It fetches both
remotes, fast-forwards `main` to `upstream/main`, checks for conflicts, merges
`main` into `deploy`, rebuilds and installs the source package, restarts the
services, restores Tailscale Serve, and pushes `main` and `deploy`. It does not
merge the development worktree automatically.

Update an isolated instance with:

```bash
T3CODE_INSTANCE=testing ./update.sh
```

If the build fails, the script does not push `deploy`.

Leaving `T3CODE_REPO` unset keeps the original npm-only behaviour, where the
dashboard tracks the configured channel and updates with:

```bash
npm install -g t3@<configured-channel>
systemctl --user restart t3code.service
```

## Manage

```bash
systemctl --user status t3code.service t3code-dashboard.service
systemctl --user restart t3code.service t3code-dashboard.service
journalctl --user -u t3code.service -u t3code-dashboard.service -f
```

T3's combined output is also retained at:

```text
~/.local/state/t3code-host/t3code.log
```

## Remove

```bash
./uninstall.sh
```

This removes both user services and their installed runtime files. It leaves
the global `t3` package, logs, both worktrees, and Tailscale Serve mappings in
place. The worktrees are kept because they may hold local commits. Inspect
or remove mappings with `tailscale serve status` and
`tailscale serve --https=<port> off`.
