# t3code-host

This project runs T3 Code on the Tailnet address of a machine. It also gives you
a dashboard. The dashboard shows the service status. It starts and stops the
service. It installs updates. It makes pairing links.

Tailscale Serve gives the permanent HTTPS address.

The dashboard is a proxy in front of T3 Code. One HTTPS address gives you both.
The dashboard shows T3 Code in a frame in the same page.

This project does not use `t3 service install`. It uses a dashboard-managed
`t3 serve --host <Tailnet IP>` service. A non-loopback address gives T3 Code the
full **Network access**, **Authorized clients**, and **Create link** screens.
The dashboard installs and starts the updates, because this is not the T3 Code
launcher.

## Requirements

- Linux with systemd user services
- Node.js, npm, and pnpm
- Git
- Tailscale, connected to a tailnet with MagicDNS
- Rust and `cargo` for the resource monitor (optional)
- GitHub CLI (`gh`) for the dashboard changelog (optional)

## Install for the first time

This procedure installs the production instance. It builds T3 Code from the
source. The build takes some minutes.

1. Get the repository:

   ```bash
   git clone <your-repository-url> t3code-host
   cd t3code-host
   ```

2. Install the production instance:

   ```bash
   T3CODE_INSTANCE=production ./install.sh
   ```

3. Type `production` when the script asks you.

4. Make sure that the instance is correct:

   ```bash
   T3CODE_INSTANCE=production ./check.sh
   ```

You must give the instance name. A command without a name stops with an error.
This prevents accidental changes to the production instance.

The installer does these steps:

1. It installs the global `t3` package. This package is the fallback.
2. It clones the fork. It builds the fork. It installs the build.
3. It removes the loopback service of T3 Code, if this service is present.
4. It installs a systemd user service. This service runs T3 Code on the Tailnet
   IPv4 address at port 4123.
5. It installs the dashboard on the same address at port 4124.
6. It publishes the dashboard with Tailscale Serve on HTTPS port 443.

If the source build fails, the npm package stays. The service continues to run.
Do the build again from the dashboard.

The default package channel is `nightly`. To use the stable releases, set the
channel:

```bash
T3CODE_CHANNEL=latest T3CODE_INSTANCE=production ./install.sh
```

### Addresses after the installation

```text
Dashboard: https://<tailnet-host>          Tailscale Serve, HTTPS port 443
           http://<tailscale-ip>:4124      the same page, Tailnet address
T3 Code:   http://<tailscale-ip>:4123      also in the dashboard frame
```

The production instance uses HTTPS port 443. Thus its address has no port
number. The installer stops if a different target uses that port.

A top-level visit to `/` shows the dashboard. The frame in that page shows T3
Code. A client that is not a browser gets T3 Code at `/`. Use `/dashboard` to
get the dashboard page directly.

## Update the dashboard

Use this procedure when you change only `src/t3code-dashboard.mjs`. The
procedure takes some seconds. It does not build T3 Code. It does not stop T3
Code. Thus your sessions continue.

1. Update the dashboard:

   ```bash
   T3CODE_INSTANCE=production ./refresh-dashboard.sh
   ```

2. Type `production` when the script asks you.

The script does these steps. It reads the source. It makes sure that the source
is correct. It copies the source. It starts the dashboard service again. It
runs `check.sh`.

The script does not use `install.sh`. The name of the T3 Code service is not in
the script. Thus the script cannot stop T3 Code.

## Update T3 Code

Use this procedure when T3 Code changes. The procedure builds the source again.
It stops T3 Code for a short time.

To build the local `deploy` branch again:

```bash
T3CODE_INSTANCE=production ./install.sh
```

To get the changes from the upstream project first:

```bash
T3CODE_INSTANCE=production ./update.sh
```

`update.sh` gets both remotes. It moves `main` forward to `upstream/main`. It
looks for conflicts. It merges `main` into `deploy`. It builds the source. It
installs the build. It starts the services again. It pushes `main` and `deploy`.
If the build fails, the script does not push `deploy`.

## Test an instance

`check.sh` tests an instance from end to end. The exit code is not 0 if a test
fails. Thus you can use the script as a gate before a release.

```bash
T3CODE_INSTANCE=production ./check.sh
T3CODE_INSTANCE=dev ./check.sh
```

The script adapts to the instance. For an installed instance, it tests the
systemd units. For a development instance, it tests the two dev servers.

The script tests these items:

- The services are active.
- The services use the Tailnet address, and not the loopback address.
- A top-level visit to `/` gets the dashboard.
- A frame at `/` gets T3 Code.
- A client without fetch metadata gets T3 Code.
- The proxy gets to T3 Code with HTTP and with a WebSocket upgrade.
- The proxy has a full-scope session.
- Tailscale Serve sends the traffic to the dashboard.
- The installed build agrees with the worktree.

The script also finds old states. It fails if the dashboard source is newer than
the dashboard process. It fails if the build is older than the worktree. Thus
you cannot test a version that you replaced.

The script waits for the ports before the tests. Thus you can run it
immediately after a restart.

## Development

Development uses two dev servers in your session. The two servers install
nothing. They make no systemd units. They publish no Tailscale Serve address.
The production instance stays unchanged.

```bash
./dev.sh          # start the two dev servers, Ctrl-C stops them
./dev.sh check    # test the dev servers
./dev.sh down     # remove an old installed dev instance
```

`./dev.sh` starts the dev runner of the fork in the development worktree. This
runner serves T3 Code from the source with hot reload. `./dev.sh` also starts
the dashboard with `node --watch` from this repository.

```text
dashboard   http://<tailscale-ip>:5124/   node --watch, starts again after you save
T3 Code     http://localhost:<port>/      hot reload, the dashboard proxies it
```

Both servers reload after you save a file.

The dev runner keeps T3 Code on the loopback address. The dashboard is the only
part on the Tailnet address. There are two results. The service buttons and the
build buttons are off, because there is no systemd unit. The network screens of
T3 Code show less, because the address is a loopback address.

`./dev.sh` cannot use the production instance. It refuses the production
instance name. It refuses the production ports. It refuses the production
worktree.

## Safety

The scripts that make changes need an instance name. `install.sh`,
`uninstall.sh`, `update.sh`, and `refresh-dashboard.sh` stop with an error if
you give no name.

The production instance also needs your approval. Type `production` when the
script asks you. For an automatic procedure, set `T3CODE_YES=1`. Thus an
automatic procedure cannot stop the production instance by accident.

## Pairing and clients

The installer controls the Tailscale Serve address. The address sends the
traffic to the dashboard:

```bash
tailscale serve --bg --https=443 "http://<tailscale-ip>:4124"
```

Do not use `t3 pair --tailscale`. That command sends the traffic to T3 Code.
Then the dashboard has no HTTPS address.

### Scopes

A pairing link gives 5 scopes. `access:write` is not one of them. A client with
5 scopes cannot make links. It cannot manage other clients.

The dashboard proxy uses a different credential. It makes a token with
`t3 auth session issue`. That token has all 8 scopes. The proxy sends the token
with each request. Thus the frame in the dashboard always has full access. You
do not pair the browser. You do not start T3 Code again.

The dashboard keeps the token in the state directory. The dashboard makes a new
token if T3 Code refuses the old one. The Connections screen shows the token
with the name `dashboard proxy`. You can cancel the token there.

Access to the dashboard on the tailnet now controls access to the frame. Direct
access to T3 Code, and not through the proxy, still needs a pairing link.

### Add T3 Code to a different client

1. Open the dashboard.
2. Open the T3 Code frame.
3. Go to **Settings**, then **Connections**.
4. Push **Create link**.
5. Copy the link.
6. Open the different client.
7. Go to **Settings**, then **Connections**.
8. Push **Add environment**.
9. Put the link in the field.

The link uses the address in your browser. Thus the link uses the HTTPS address
of the dashboard. The new client gets 5 scopes.

The dashboard also makes links. Use **Client link** for a usual client. Use
**Administrator link** for full access. The administrator link starts T3 Code
again. It then reads the credential from the start messages.

## Build from a fork

The installer makes two worktrees. The dashboard controls the deployment
worktree at `~/.local/share/t3code-host/src`. You do your work in the
development worktree at `~/.local/share/t3code-host/dev`.

The project uses three branches:

```text
upstream/main  --sync-->  main  --merge-->  deploy  --build-->  the service

                          dev  --merge-->  deploy
```

`main` is a copy of the upstream branch. The deployment worktree always has
`deploy`. That worktree must stay clean. Make your changes in the `dev`
worktree. Commit them there. The dashboard can then merge them into `deploy`.
The dashboard builds them and starts the service again.

Set these variables when you install:

| Variable | Default |
| --- | --- |
| `T3CODE_REPO` | `~/.local/share/t3code-host/src` |
| `T3CODE_DEV_REPO` | `~/.local/share/t3code-host/dev` |
| `T3CODE_FORK_URL` | `git@github.com:mcread29/t3code.git` |
| `T3CODE_UPSTREAM_URL` | `git@github.com:pingdotgg/t3code.git` |
| `T3CODE_BRANCH` | `deploy` |
| `T3CODE_DEV_BRANCH` | `dev` |

The fork card in the dashboard shows the distance of each branch. It tests both
merges with `git merge-tree`. Thus it shows conflicts before it changes files.

**Sync, build & deploy** is on only if both merges are clean. The worktree must
also be clean. The button does these steps:

1. It gets `origin` and `upstream`.
2. It moves `main` forward to `upstream/main`. It pushes `main`.
3. It merges `main` into `deploy` with `--no-ff`.
4. It runs `pnpm install`. It builds the web client. It builds the CLI. It
   builds the resource monitor if `cargo` is available.
5. It runs `npm install -g <repo>/apps/server`.
6. It starts `t3code.service` again. It then pushes `deploy`.

The build does not touch the service until the build is complete. If a merge
has a conflict, the dashboard stops the merge. It does not correct the conflict.

**Rebuild & deploy** does steps 4 to 6 only. **Merge dev, build & deploy**
merges the commits in `dev` into `deploy`. Both worktrees must be clean.

A build takes some minutes. Thus a build is a background job. The page reads the
output. The output stays after you load the page again. Only one job runs at a
time.

## Other instances

You can install a second instance. The production instance stays unchanged:

```bash
T3CODE_INSTANCE=testing ./install.sh
```

```text
Dashboard: https://<tailnet-host>:8446
           http://<tailscale-ip>:5124
T3 Code:   http://<tailscale-ip>:5123
Units:     t3code-testing.service, t3code-dashboard-testing.service
Files:     ~/.local/share/t3code-host-testing
```

The second instance uses different units, worktrees, state, logs, and npm
prefix. It also uses a different `T3CODE_HOME`. Thus its pairing credentials
cannot change the production instance.

Set `T3CODE_TEST_PORT` and `T3CODE_TEST_DASH_PORT` to change the two ports. Set
`T3CODE_TEST_PAIR_PORT` to change the Tailscale Serve port. Set `T3CODE_NPM_BIN`
if the instance needs a different npm program.

To remove one instance:

```bash
T3CODE_INSTANCE=testing ./uninstall.sh
```

The script keeps the worktrees and the npm prefix. Examine them, then remove
them.

## Variables for the installer

| Variable | Function |
| --- | --- |
| `T3CODE_INSTANCE` | The instance name. This variable is necessary. |
| `T3CODE_YES` | Set to `1` to approve a production change automatically. |
| `T3CODE_SKIP_BUILD` | Set to `1` to update only the dashboard and the units. |
| `T3CODE_SKIP_BOOTSTRAP` | Set to `1` to build the worktree, but keep the git state. |
| `T3CODE_SKIP_SERVE` | Set to `1` to publish no Tailscale Serve address. |
| `T3CODE_ALLOW_DIRTY` | Set to `1` to build a worktree with local changes. |
| `T3CODE_LINK_DASHBOARD` | Set to `1` to link the dashboard file to this repository. |
| `T3CODE_CHANNEL` | The npm channel for the fallback package. |

Each Tailscale Serve port uses the same MagicDNS host name. Cookies ignore port
numbers. Thus a second instance on that host name replaces the session cookie of
the production instance. The browser then loses its scopes. Use
`T3CODE_SKIP_SERVE=1` for each instance that is not the production instance.

## Manage the services

```bash
systemctl --user status t3code.service t3code-dashboard.service
systemctl --user restart t3code.service t3code-dashboard.service
journalctl --user -u t3code.service -u t3code-dashboard.service -f
```

T3 Code also writes its messages to this file:

```text
~/.local/state/t3code-host/t3code.log
```

## Files

| Path | Contents |
| --- | --- |
| `install.sh` | Installs or updates one instance. |
| `refresh-dashboard.sh` | Updates the dashboard of one instance only. |
| `update.sh` | Gets the upstream changes, then builds and installs them. |
| `uninstall.sh` | Removes the units of one instance. |
| `check.sh` | Tests one instance. |
| `dev.sh` | Starts the two dev servers. |
| `lib/guard.sh` | Protects the production instance. |
| `src/t3code-dashboard.mjs` | The dashboard and the T3 Code proxy. |
| `src/t3code-serve-tailnet` | Starts T3 Code on the Tailnet address. |
| `systemd/*.in` | The templates for the units. |
