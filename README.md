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

- Linux with systemd user services, or Windows 10 or 11 with PowerShell 7.
- Node.js, npm, and pnpm.
- Git.
- Tailscale, connected to a tailnet with MagicDNS.
- Rust and `cargo` for the resource monitor (optional).
- GitHub CLI (`gh`) for the dashboard changelog (optional).

Windows uses limited user tasks. The tasks start after the user signs in.

## Install for the first time

This procedure installs the production instance. It builds T3 Code from the
source. The build takes some minutes.

1. Get the repository:

   ```bash
   git clone <your-repository-url> t3code-host
   cd t3code-host
   ```

2. Install the production instance on Linux:

   ```bash
   T3CODE_INSTANCE=production ./install.sh
   ```

   Install the production instance on Windows:

   ```powershell
   $env:T3CODE_INSTANCE = 'production'
   .\install.ps1
   ```

3. Type `production` when the script asks you.

4. Check the Linux instance with `check.sh`.

   Check the Windows instance with these commands:

   ```powershell
   $env:T3CODE_INSTANCE = 'production'
   .\check.ps1
   ```

You must give the instance name. A command without a name stops with an error.
This prevents accidental changes to the production instance.

### Developer mode at the install

Developer mode is off. The installer then clones one branch of the fork, it
adds no upstream remote, and it makes no development worktree. Thus a release
machine holds only the parts that it uses.

Give the mode for a machine that does the integration:

```bash
T3CODE_DEV_MODE=1 T3CODE_INSTANCE=production ./install.sh
```

The installer writes the mode to `settings.json` in the state directory. It
writes that file again only when you name the mode. Thus a later change in the
settings dialog of the dashboard stays. Read **Developer mode** below.

Run the command again with `T3CODE_DEV_MODE=1` after you turn the mode on in
the dialog. The installer then adds the upstream remote, the `main` branch, and
the development worktree to a machine that did not have them.

The installer does these steps:

1. It installs the global `t3` package. This package is the fallback.
2. It clones the fork. It builds the fork. It installs the build.
3. It removes the loopback service of T3 Code, if this service is present.
4. It installs a systemd service or Windows task. It runs T3 Code on the
   Tailnet IPv4 address at port 4123.
5. It installs the dashboard on the same address at port 4124.
6. It publishes the dashboard with Tailscale Serve on HTTPS port 443.

If the source build fails, the npm package stays. The service continues to run.
Do the build again from the dashboard.

### Windows commands

Each PowerShell script has the same function as its shell script:

| Linux | Windows |
| --- | --- |
| `install.sh` | `install.ps1` |
| `refresh-dashboard.sh` | `refresh-dashboard.ps1` |
| `uninstall.sh` | `uninstall.ps1` |
| `check.sh` | `check.ps1` |
| `dev.sh` | `dev.ps1` |

Set the required variables in the PowerShell process before each command.

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

## Update one machine

The dashboard does each usual update. Use a script for the first install, and
for a machine that you cannot reach through its dashboard.

Each path changes one group of parts, and no other part. Thus you always know
what a command stops.

| Path | It changes | It restarts | It does not |
| --- | --- | --- | --- |
| **Pull deploy**, **Build**, **Deploy** | the branch, the build, the installation | T3 Code, at **Deploy** only | move another branch |
| **Pull & restart** | the dashboard file | the dashboard | touch T3 Code |
| `refresh-dashboard.sh` | the dashboard file | the dashboard | touch T3 Code |
| `install.sh` | each of those, and the build when the build is not current | the dashboard, and T3 Code only after a build | move a branch |

For a usual update after you get new commits:

```bash
git pull
T3CODE_INSTANCE=production ./install.sh
```

Type `production` when the script asks you. This command also does the first
install on a machine with nothing installed.

`install.sh` builds the source only when the worktree moved after the last
build, or when a build asset is absent. It restarts T3 Code only when it built
something. Thus an update that changes the dashboard only takes seconds, and
your sessions in the console continue.

For a change to a file in `systemd/` and no change to T3 Code, leave the build
out:

```bash
T3CODE_SKIP_BUILD=1 T3CODE_INSTANCE=production ./install.sh
```

A change to the T3 Code unit becomes active at the next restart of T3 Code. The
script gives you a message, because that restart stops your sessions. Do the
restart when it suits you:

```bash
systemctl --user restart t3code.service
```

### The path of the units

The units give a PATH to T3 Code and to the dashboard. That PATH must contain
the directory of `mise`, when this machine has `mise`. The npm shim of `mise`
calls `mise reshim` after a global install. Without `mise` on the path, that
call fails with code 127. Two operations then fail after a correct install:

- The deploy job in the dashboard.
- Each update of a provider CLI, for example Codex, in the console.

`install.sh` finds the directory of `mise` and puts it in the units.

## Update the dashboard

The dashboard updates itself. Use **Pull & restart** in the dashboard section.
The update takes some seconds. It does not build T3 Code. It does not stop T3
Code. Thus your sessions continue.

The job does these steps. It makes sure that the repository is clean. It pulls
the repository. It reads the module and the page of the new file. It gives the
copy and the restart to a transient unit, because a process cannot replace the
file that it runs from. The name of the T3 Code service is in no step. Thus the
update cannot stop T3 Code.

Use the script when the dashboard does not start:

```bash
T3CODE_INSTANCE=production ./refresh-dashboard.sh
```

The script does the same steps from a terminal, and then runs `check.sh`.

## Update T3 Code

`install.sh` builds the `deploy` branch when the build is not current. To do the
build in all conditions, for example after a failed build:

```bash
T3CODE_FORCE_BUILD=1 T3CODE_INSTANCE=production ./install.sh
```

The build stops T3 Code for a short time.

To get the changes from the upstream project, use the dashboard. The dev
section moves `main`, `dev`, and `deploy`. Each button moves one branch.

### The dashboard buttons

Each button moves one thing. The arrow gives the direction.

The release section has the three steps of a release, in order:

```text
1  Pull deploy       pulls the shared deploy branch. It does not push.
2  Build             compiles the source. No install. No restart.
3  Deploy            installs the build and restarts T3 Code. No compile.
```

The dev section has the integration, in order. The label reads from the source
to the target:

```text
1  origin -> dev       pulls the shared dev branch. It does not push.
2  upstream -> main    moves main only. It pushes main.
3  main -> dev         merges main into dev. It pushes dev.
4  dev -> deploy       promotes dev to deploy. It pushes deploy.
```

Do the step that has a count. A step with `current` has nothing to move, and a
step that names a condition, for example `dev dirty`, waits for you to remove
it. Two steps can wait at the same time, so the number gives the order and not
a position in a queue.

Each worktree row has two more controls. The pencil commits each change in that
worktree. The arrow pushes its branch. Each one shows only while it applies.
The deploy worktree has neither, because it holds the release.

No button builds and merges together. No button merges two pairs of branches
together.

A machine updates its release with these steps:

```text
deploy <- origin/deploy   ->   Build   ->   Deploy
```

The DEV buttons need developer mode. Read **Developer mode** below. One
integration machine updates `main` and `dev`. It promotes `dev` to `deploy`.
Other machines pull `deploy`. Only **Deploy** stops your sessions.

### Developer mode

The dashboard has a settings dialog. The gear at the top of the sidebar opens
it. The dialog has one setting, and that setting is developer mode.

Developer mode is off. A machine in this state gets the release only:

```text
Pull deploy   ->   Build   ->   Deploy
```

The machine tracks `origin/deploy` alone. It does not fetch `upstream`, and it
reads neither `main` nor `dev`. The dashboard hides the dev section, and the
server refuses each job that moves an integration branch. Thus two machines
cannot move the shared branches together, and a release machine shows only the
three steps that it uses.

Turn developer mode on for the integration machine. The dashboard then shows
the dev section, the feature worktrees, and the dev server.

The setting belongs to one machine. The dashboard writes it to
`settings.json` in the state directory. Thus an update of the dashboard keeps
it.

The dialog changes what the dashboard shows and what it tracks. It makes no
worktree. Thus you run the installer again after you turn the mode on:

```bash
T3CODE_DEV_MODE=1 T3CODE_INSTANCE=production ./install.sh
```

That command adds the upstream remote, the `main` branch, and the development
worktree. Until it runs, the dev section says that no development worktree
exists.

## Test an instance

`check.sh` tests an instance from end to end. The exit code is not 0 if a test
fails. Thus you can use the script as a gate before a release.

```bash
T3CODE_INSTANCE=production ./check.sh
T3CODE_INSTANCE=dev ./check.sh
```

The script adapts to the instance. For an installed instance, it tests the
systemd units. For a development instance, it tests the dashboard shell.

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

`./dev.sh` runs the dashboard shell alone. It installs nothing. It makes no
systemd units. It publishes no Tailscale Serve address. The production instance
stays unchanged.

```bash
./dev.sh          # start the dashboard shell, Ctrl-C stops it
./dev.sh check    # test the dev instance
./dev.sh down     # remove an old installed dev instance
```

`src/dev-stub-t3.mjs` replaces T3 Code. This stub is a placeholder. It answers
the proxy. It gives its own name on the page. There is no worktree of the fork.
There is no build from the source. There is no delay of some minutes. The
dashboard starts again after you save a file.

```text
dashboard   http://<tailscale-ip>:5124/dashboard   node --watch, starts again after you save
T3 Code     http://localhost:<port>/               the stub, not the console
```

The service buttons and the build buttons are off, because there is no systemd
unit. The dev server buttons are also off, because the shell has no development
worktree.

Use the `/dashboard` path in development. The dashboard and T3 Code use the
same root path. The dashboard divides them with the `Sec-Fetch-Dest` header.
Browsers send this header on HTTPS only. Development uses a plain HTTP address.
Thus the root path gives you T3 Code in development. Production uses an HTTPS
address. Thus the root path gives you the dashboard in production.

`./dev.sh` cannot use the production instance. It refuses the production
instance name. It refuses the production ports. It refuses the production
worktree.

## The dev server

To use the real T3 Code, open the production dashboard. The **dev** section has
a **Start** button. This button starts the dev runner of the fork in the
development worktree. The runner serves that worktree from the source with hot
reload.

The dev section needs developer mode. A machine with developer mode off shows
no dev section and starts no dev runner.

The dev server is not a systemd unit. Only one build owns the global `t3`
package. That build is the deploy build. The dev server is a child of the
dashboard. It needs no build. It stops when the dashboard stops.

While the dev server runs, the console header shows two tabs:

```text
DEPLOY   the installed build, from the deploy worktree
DEV      the dev runner, from the dev worktree
```

The tab writes a cookie on the address of the dashboard. Thus the choice
applies to your browser only. Other clients on the tailnet continue to use the
deploy build. Each backend has its own credentials. Thus the dashboard makes a
new session when you change the tab.

## The branch workflow

There are three branches. `main` is a copy of upstream. The production service
builds `deploy`. You do your work on `dev`.

The release controls move changes in this direction:

```text
origin/deploy  ->  deploy  ->  build  ->  restart
```

Use **Pull deploy** on each release machine. The pull permits a fast-forward
only. Thus the pull does not overwrite local commits.

Use the integration controls on the integration machine. These controls move
changes from `upstream` to `main`, then `dev`, and then `deploy`.

Nobody commits to `main`, because `main` is a copy. Thus the dashboard moves
`main` to `origin/main` by itself after each fetch. It permits a fast-forward
only. If `main` has a commit of its own, the dashboard moves nothing and the
dev section tells you.

`dev` has a worktree, and a person works in it. Thus the dashboard does not
move `dev` by itself. **dev &larr; origin** pulls what another machine pushed,
and it permits a fast-forward only.

Each merge does a fast-forward when the history permits one. It makes a merge
commit only when the history does not permit a fast-forward.

**Promote to deploy** moves the changes in the opposite direction:

```text
dev  ->  deploy  ->  build  ->  restart
```

After a sync, `deploy` is an ancestor of `dev`. Thus a promotion is usually a
fast-forward. The build then contains the same commit that you tested on the
dev server. The two worktrees must have no uncommitted changes.

## Safety

The scripts that make changes need an instance name. `install.sh`,
`uninstall.sh`, and `refresh-dashboard.sh` stop with an error if you give no
name.

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
origin/deploy  --pull-->  deploy  --build-->  the service

upstream/main  --sync-->  main  --merge-->  dev  --promote-->  deploy
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
| `T3CODE_DEV_MODE` | `0`, the mode before the first change in the dialog |

The release card shows the distance from `origin/deploy`. **Pull deploy**
requires a clean worktree and a fast-forward. **Build** compiles the source.
**Deploy** installs the build and restarts T3 Code.

The dev section contains the integration controls. It also shows merge
conflicts before a merge changes a worktree. Developer mode gives this section.
A machine that only runs the release does not show it.

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
| `T3CODE_DEV_MODE` | Set to `1` for an integration machine, or `0` for a release machine. |
| `T3CODE_CHANNEL` | The npm channel for the fallback package. |

Each Tailscale Serve port uses the same MagicDNS host name. Cookies ignore port
numbers. Thus a second instance on that host name replaces the session cookie of
the production instance. The browser then loses its scopes. Use
`T3CODE_SKIP_SERVE=1` for each instance that is not the production instance.

## Manage the services

Use systemd on Linux:

```bash
systemctl --user status t3code.service t3code-dashboard.service
systemctl --user restart t3code.service t3code-dashboard.service
journalctl --user -u t3code.service -u t3code-dashboard.service -f
```

Use Task Scheduler on Windows:

```powershell
Get-ScheduledTask -TaskName 'T3CodeHost-*'
Start-ScheduledTask -TaskName 'T3CodeHost-t3code'
Stop-ScheduledTask -TaskName 'T3CodeHost-t3code'
```

T3 Code also writes its messages to this file:

```text
~/.local/state/t3code-host/t3code.log
```

## Files

| Path | Contents |
| --- | --- |
| `install.sh`, `install.ps1` | Install or update one instance. |
| `refresh-dashboard.sh`, `refresh-dashboard.ps1` | Update one dashboard only. |
| `uninstall.sh`, `uninstall.ps1` | Remove one instance. |
| `check.sh`, `check.ps1` | Test one instance. |
| `dev.sh`, `dev.ps1` | Run the dashboard shell with the stub. |
| `AGENTS.md` | Give the rules for an agent that works here. |
| `lib/guard.sh`, `lib/Guard.ps1` | Protect the production instance. |
| `lib/Windows.ps1` | Give shared Windows functions. |
| `windows/` | Run the Windows tasks. |
| `src/t3code-dashboard.mjs` | The dashboard and the T3 Code proxy. |
| `src/dev-stub-t3.mjs` | The substitute for T3 Code, for `./dev.sh`. |
| `src/t3code-serve-tailnet` | Starts T3 Code on the Tailnet address. |
| `systemd/*.in` | The templates for the units. |
