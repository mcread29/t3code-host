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
- Node.js and npm
- Tailscale, connected to a tailnet with MagicDNS enabled
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

1. Installs the selected global `t3` package.
2. Removes T3's native loopback-only service if it is installed.
3. Installs a systemd user service running T3 in web mode on the machine's
   Tailnet IPv4 address at port 4123.
4. Installs the dashboard on that address at port 4124.

```text
T3 Code:   http://<tailscale-ip>:4123
Dashboard: http://<tailscale-ip>:4124
```

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

## Updates

The dashboard checks the configured npm channel and activates updates with:

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
the global `t3` package, logs, and Tailscale Serve mappings in place. Inspect
or remove mappings with `tailscale serve status` and
`tailscale serve --https=<port> off`.
