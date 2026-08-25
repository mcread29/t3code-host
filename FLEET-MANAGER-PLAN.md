# Fleet Manager Conversion Plan

## Purpose

Convert this project into one fleet manager for multiple T3 Code machines.

Run the fleet manager on the controller machine. Run T3 Code on each client machine.

Show the fleet overview and each connected machine as tabs at the top of the page.

Build T3 Code once for each supported platform target. Send release artifacts to client machines through SSH.

Do not keep a T3 Code source clone on a client machine.

## Target result

The controller machine has these parts:

- The fleet dashboard.
- The T3 Code source clone.
- The integration worktrees.
- The artifact builders.
- The artifact store.
- The fleet inventory.
- The campaign history.
- The SSH client credentials.
- One local T3 Code instance, when configured.

Each client machine has these parts:

- Tailscale.
- SSH access.
- A compatible Node.js runtime.
- A restricted fleet management account.
- A separate T3 Code runtime account.
- A small fleet command helper.
- A T3 Code service.
- A T3 Code data directory.
- The current release.
- The previous release.

Each client machine does not have these parts:

- The fleet dashboard.
- A T3 Code source clone.
- GitHub credentials.
- A build worktree.
- Integration branch controls.
- A dashboard HTTP port.

## Main architecture

```text
                         one tailnet

  browser
     |
     v
  fleet dashboard and controller
     |
     +-- local command transport ------> local T3 Code
     |
     +-- SSH transport ----------------> Linux client
     |                                      |
     |                                      +-- fleet command helper
     |                                      +-- T3 Code service
     |
     +-- SSH and PowerShell transport --> Windows client
                                            |
                                            +-- fleet command helper
                                            +-- T3 Code task
```

The controller owns coordination. Each machine owns its local state and service.

The remote SSH account must enforce the client helper as its forced command.

The controller must send a validated request through standard input. It must not send a remote command string.

The client helper must not run as a daemon. SSH starts it for one operation.

## Core decisions

### Use one dashboard

Run the dashboard on the controller only.

Remove the dashboard service from client installation paths. Keep the dashboard available during the migration.

### Use artifacts instead of clones

Keep the full T3 Code clone on a builder only. Produce one artifact for each platform target.

Send the selected artifact to a client. Do not build from source on a normal client.

### Use SSH as the command transport

Use local execution for the controller machine. Use SSH for a remote Linux machine.

Use standard OpenSSH over Tailscale for a Windows destination. The Tailscale SSH server does not support Windows.

Use standard OpenSSH for each unattended fleet operation. A restricted key must start only the client helper.

Use Tailscale SSH only for approved bootstrap work and manual recovery.

### Preserve one action per job

Keep pull, build, stage, activate, and rollback as separate jobs.

Do not make one job pull source, build artifacts, and restart all machines.

### Keep client safety local

Make the client helper verify every artifact and release path. Make it refuse an incompatible artifact.

Make the client helper hold a local operation lock. Thus two controllers cannot change one machine together.

### Isolate each console origin

Give each machine console a fixed controller proxy origin. Bind that origin to one inventory machine.

Do not use a shared cookie to select a proxy target. A page URL can select only the visible dashboard tab.

Keep browser storage, HTTP requests, and WebSocket connections on the same fixed console origin.

### Use the artifact digest as the release identity

Use the archive SHA-256 digest as the immutable artifact identity.

Record the Git revision as provenance. Do not use it to distinguish two artifact builds.

Pin one artifact digest and one machine identity in each campaign operation.

### Make each change a durable transaction

Write an operation intent before the helper changes a pointer, service, or helper file.

Record each transaction phase. Reconcile an unfinished transaction before the helper accepts another change.

### Separate enrollment from management

Do not let a dashboard job install its own command boundary.

Use a manual client installer to create the restricted account, helper, service, and pinned controller key.

Permit an approved bootstrap session only as a temporary alternative. Remove its authority after enrollment.

### Separate management from the workload

Run T3 Code with a runtime account that cannot change the helper, launcher, release files, or SSH restrictions.

Run the forced helper with a separate fleet management account.

Use a narrow, root-owned service adapter for required service and installation changes.

Do not give either account a general `sudo` rule or an administrator shell.

## User interface plan

### Top fleet tabs

Put the fleet tabs at the top of the application.

Show the overview tab first. Show one tab for each enabled machine after the overview tab.

```text
+--------------------------------------------------------------------------------+
| T3 CODE FLEET   [Overview] [Controller ●] [Studio ● 1] [Server ○] [Laptop !]  ⚙ |
+--------------------------------------------------------------------------------+
| selected machine controls            | selected T3 Code console                  |
|                                      |                                            |
|                                      |                                            |
+--------------------------------------------------------------------------------+
```

Use these tab indicators:

| Indicator | Meaning |
| --- | --- |
| Green dot | The machine and T3 Code answer. |
| Gray dot | The machine is offline or unknown. |
| Amber dot | The machine needs an update. |
| Red mark | The last operation failed. |
| Number | The machine has pending work. |
| Spinner | A machine operation runs. |

Keep tab labels short. Use the configured display name, not the full host name.

Show the full host name in the tab title. Show the platform target in the machine details.

Make the tab row scroll horizontally when it does not fit. Keep the selected tab visible.

Use an overflow menu only after horizontal scrolling becomes difficult. Do not hide offline machines by default.

### Tab behavior

Use `role="tablist"` for the tab row. Use `role="tab"` for each tab.

Use a roving tab index. Support the Left Arrow, Right Arrow, Home, and End keys.

Keep the selected machine in the page URL. Use a stable machine identifier in the URL.

Use a URL such as this example:

```text
/dashboard?machine=studio
```

Restore the selected tab after a page reload. Select the overview when the identifier is invalid.

Do not start an operation when the user selects a tab.

### Overview tab

Show a compact fleet table on the overview tab.

| Column | Contents |
| --- | --- |
| Machine | Display name and host name. |
| Connection | Online, offline, or unknown. |
| Platform | Operating system, architecture, and libc. |
| Service | Active, inactive, or failed. |
| Release | Active artifact digest, revision, and T3 Code version. |
| Desired | Selected fleet artifact digest and revision. |
| Work | Current operation or pending action. |
| Last contact | The last successful status time. |

Let the user select machines from this table. Use the selection for a fleet campaign.

Show fleet warnings above the table. Include incompatible artifacts, failed machines, and unavailable builders.

### Machine tab

Keep the current split view for a selected machine.

Show machine controls in the left panel. Show the selected T3 Code console in the right panel.

Show these sections in the machine panel:

1. Connection and service state.
2. Machine identity and platform target.
3. Active and previous releases.
4. Available artifact and compatibility.
5. Stage, activate, restart, and rollback controls.
6. Recent machine operation output.
7. Machine settings and removal controls.

Disable an action when its preconditions do not pass. Explain the failed precondition beside the action.

Show the local controller machine with the same panel. Use the local transport for its operations.

Make the local transport use the same request validation, transaction journal, and service adapter as remote transport.

Do not let the local transport call an arbitrary executable or bypass helper authorization.

### Console behavior

Route the selected T3 Code console through the controller proxy.

Use the page URL to select the visible machine tab. Do not use this selection to route proxy traffic.

Give each enabled machine a dedicated console origin on the controller.

Bind each console listener to one machine when the listener starts. Resolve its backend through the fleet inventory.

Never accept a proxy target, host, or port from the browser.

Keep one proxy session token for each machine. Store each token in the controller state directory.

Issue or renew a remote token through the client helper. Never send the token to browser code.

Use a token label that includes the controller instance identifier and machine identifier.

Store the token expiry. Renew it before expiry and revoke it during machine removal or controller decommission.

Redact the token before the helper result reaches a job log, campaign log, audit record, or diagnostic message.

Authenticate the console request at the controller. Remove every browser cookie before proxy forwarding.

Remove browser authorization and proxy authorization headers. Add the machine token on the server.

Do not forward an upstream `Set-Cookie` header to the browser.

Rewrite the upstream host and origin headers to the fixed machine backend.

Set a console content security policy that permits framing only from the dashboard origin.

Route a WebSocket to the machine selected when the connection starts. Do not move an active connection between machines.

Reload the console frame when the selected machine changes.

Set the frame source to the machine console origin from the server response. Do not construct this origin from browser input.

Test two browser tabs that select different machines. Verify that all HTTP and WebSocket traffic stays separate.

Keep the existing deploy and development console tabs as secondary tabs. Show them on the controller machine only.

### Add machine flow

Add an **Add machine** action to the fleet settings dialog.

Collect these values:

- A stable machine identifier.
- A display name.
- A Tailscale host name or address.
- An SSH user.
- A transport type.
- A T3 Code port.
- A controller console HTTPS port.
- A platform target override, when necessary.
- Optional tags.

Add a new machine in the `pending-enrollment` state. Do not permit management actions in this state.

Show a client installer command and a single-use enrollment identifier.

Require the operator to verify the SSH host key through a separate trusted channel.

Run the helper probe after the restricted command boundary exists. Show the detected platform and runtime versions.

Require confirmation before an approved bootstrap session changes the remote machine.

Mark the machine as `managed` only after the probe and identity checks pass.

Permit offline inventory creation. Keep the machine in `pending-enrollment` until all checks pass.

### Remove machine flow

Remove a machine from the inventory without uninstalling it by default.

Revoke its proxy session before online removal. Delete the local token even when remote revocation fails.

Record a pending revocation after an offline removal. Show the required recovery action to the operator.

Provide a separate uninstall action. State that this action stops T3 Code and changes the remote machine.

Keep campaign history after inventory removal. Show the former display name in the history.

## Fleet inventory

Store the fleet inventory in the controller state directory. Do not store machine secrets in the repository.

Use a versioned JSON document.

```json
{
  "schemaVersion": 1,
  "generation": 1,
  "controllerId": "controller",
  "machines": [
    {
      "id": "controller",
      "name": "Controller",
      "transport": "local",
      "host": "controller",
      "t3Port": 4123,
      "consoleHttpsPort": 4443,
      "target": "linux-x64-glibc",
      "tags": ["builder", "controller"],
      "enrollmentState": "managed",
      "enabled": true
    },
    {
      "id": "studio",
      "name": "Studio",
      "transport": "ssh",
      "host": "studio.example.ts.net",
      "sshUser": "t3code-fleet",
      "t3Port": 4123,
      "consoleHttpsPort": 4444,
      "target": "windows-x64",
      "tags": ["client"],
      "enrollmentState": "managed",
      "enabled": true
    }
  ]
}
```

Validate the complete file before replacing the active inventory. Use an atomic file replacement.

Sync the new file and parent directory before reporting a successful inventory change.

Use the machine identifier in URLs, logs, jobs, and state paths. Do not use a display name as an identifier.

Give each inventory revision a monotonic generation number.

Store the verified SSH host key fingerprint with each remote machine.

Reject duplicate hosts, console HTTPS ports, controller identities, and enabled machine identifiers.

Do not change a machine identity in place. Remove the old identity and enroll the new identity.

Permit these identifier characters:

```text
a-z  0-9  hyphen
```

Add a schema migration function before adding a second schema version.

## Machine probe and capabilities

Make the client helper return machine facts as JSON.

```json
{
  "protocolVersion": 1,
  "machineInstanceId": "018f2f1d-4cf5-7d39-a97e-45e90f650ef4",
  "platform": "linux",
  "architecture": "x64",
  "libc": "glibc",
  "libcVersion": "2.39",
  "nodeVersion": "24.18.0",
  "serviceManager": "systemd-system",
  "helperVersion": "1",
  "capabilities": [
    "artifact-stage",
    "artifact-activate",
    "artifact-rollback",
    "service-control",
    "session-issue"
  ]
}
```

Use capability checks before each action. Do not infer support from the operating system alone.

Keep the protocol version separate from the dashboard version. Support the current and previous protocol versions.

Keep a minimum permitted helper version. Raise it immediately when an older helper has a security fault.

Create the machine instance identifier during client installation. Keep it stable across helper and T3 Code updates.

Compare the identifier and the pinned SSH host key before each change operation.

Treat a changed identifier or host key as a new enrollment. Do not continue a pending operation.

## Client command helper

Create one Node.js entry point for shared command validation and JSON output.

Use platform adapters for service control and release activation.

Support these commands:

| Command | Function |
| --- | --- |
| `probe` | Return platform and helper capabilities. |
| `status` | Return the service and release state. |
| `operation-status` | Return a stored operation phase and result. |
| `upload` | Receive one bounded artifact through standard input. |
| `stage` | Verify and unpack one transferred artifact. |
| `activate` | Select one staged release and restart T3 Code. |
| `rollback` | Select the previous release and restart T3 Code. |
| `restart` | Restart T3 Code without changing a release. |
| `start` | Start the T3 Code service. |
| `stop` | Stop the T3 Code service. |
| `logs` | Return a bounded service log. |
| `session-issue` | Issue one proxy session for the controller. |
| `session-revoke` | Revoke one controller proxy session by its fixed label. |
| `install-service` | Install or update the T3 Code service definition. |
| `update-helper` | Verify and select a signed helper release. |

Return one JSON object on standard output. Send diagnostic text to standard error.

Use a versioned, length-prefixed request on standard input. Do not pass operation values in the remote command.

Give an upload request a declared byte count and SHA-256 digest. Refuse extra bytes and incomplete input.

Return a nonzero exit code after each failed operation. Include a stable error code in the JSON response.

Do not accept an arbitrary command, executable, service name, or destination path.

Resolve all release paths under the configured release directory. Reject a path that leaves this directory.

Use a local operation lock for upload, stage, activate, rollback, and each installation operation.

Store the lock owner and operation identifier. Reconcile an abandoned lock after a verified process check.

Treat `session-issue` output as secret data. Return it through a nonlogging result field.

Keep two helper releases. Make a fixed forced-command launcher select the active verified helper.

Do not let `update-helper` replace the forced-command launcher or SSH restrictions.

Call a fixed, root-owned service adapter for start, stop, restart, and signed service installation.

Give the adapter a fixed service name and fixed file roots. Do not let it accept an executable path.

Permit the fleet management account to run only this adapter with elevated authority.

## Release artifact design

### Build targets

Start with this target on the controller:

```text
linux-x64-glibc
```

Add a target only when a fleet machine needs it.

Expected later targets include these examples:

```text
linux-arm64-glibc
windows-x64
```

Do not send a Linux artifact to Windows. Do not send an x64 artifact to ARM64.

Record the minimum compatible libc version for a Linux artifact.

### Build inputs

Build from a clean deploy worktree. Record the full Git revision before the build.

Record the Node.js, pnpm, operating system, architecture, and libc builder values.

Use the existing source build steps for the server and web client. Keep the resource monitor optional.

Use `pnpm deploy` to make an isolated production directory. Include the production dependencies in the artifact.

Build an artifact on its target platform when native dependencies require that platform.

Treat two builds as different artifacts when their archive digests differ.

### Artifact contents

Include these files:

- The built server files.
- The built web client files.
- The production dependencies.
- The package manifest.
- The release manifest without an archive checksum.
- A payload checksum list that does not include itself.
- The optional resource monitor for the target.

Do not include these files:

- The Git directory.
- Source worktrees.
- Development dependencies.
- Builder credentials.
- Dashboard state.
- T3 Code user data.

Record each payload path, file type, byte count, digest, and executable flag in the checksum list.

Do not preserve archive ownership, set-user-ID bits, set-group-ID bits, or unexpected write permissions.

### Artifact manifest

Put a release manifest inside the archive. Use a manifest similar to this example:

```json
{
  "schemaVersion": 1,
  "revision": "a60b333c4f0a0000000000000000000000000000",
  "shortRevision": "a60b333c4",
  "t3Version": "0.0.33",
  "target": "linux-x64-glibc",
  "platform": "linux",
  "architecture": "x64",
  "libc": "glibc",
  "minimumLibcVersion": "2.39",
  "nodeRange": "^22.16 || ^23.11 || >=24.10",
  "dataSchema": "unchanged",
  "rollbackCompatible": true,
  "createdAt": "2026-08-12T00:00:00Z",
  "builder": "controller"
}
```

Keep the archive checksum outside the archive. Thus the manifest does not contain its own checksum.

Create a detached artifact descriptor after the archive is complete.

```json
{
  "schemaVersion": 1,
  "artifactSha256": "...",
  "archiveBytes": 12345678,
  "manifestSha256": "...",
  "revision": "a60b333c4f0a0000000000000000000000000000",
  "target": "linux-x64-glibc",
  "builder": "controller",
  "signingKeyId": "fleet-artifacts-2026-01",
  "toolchain": {
    "node": "24.18.0",
    "pnpm": "10.0.0"
  }
}
```

Sign the detached descriptor with the controller artifact signing key.

Sign the exact stored descriptor bytes. Do not parse and serialize the descriptor before verification.

Install the matching public key with the client helper. Verify the signature before extraction.

Use the artifact digest as the release identity. Use the revision for provenance and display only.

Do not overwrite an existing digest directory. Compare all existing metadata and fail after a mismatch.

### Artifact store

Store artifacts under the controller state directory.

```text
artifacts/
  <artifact-sha256>/
      artifact.tar.zst
      artifact.json
      artifact.sig
```

Keep artifact metadata after a failed deployment. Thus the operator can inspect the exact failed input.

Keep a configurable number of recent artifacts. Never remove an artifact used by an active machine.

Never remove an artifact used by a previous pointer, staged operation, or unfinished campaign.

Never remove a data backup required by an available rollback or unfinished transaction.

Run retention under the same controller state writer as campaign and inventory changes.

### Builders

Use the controller as the first Linux x64 builder.

Support these builder types later:

- A local builder.
- A remote tailnet builder.
- A continuous integration builder.

Use a Windows builder for a complete Windows artifact. Do not copy Linux native dependencies into that artifact.

Use a matching builder for Linux ARM64. Do not require a permanent source clone on a normal client.

Permit a temporary client build during early enrollment. Remove the temporary source after artifact creation.

## Client release layout

Use a versioned release directory on every client.

```text
app-directory/
  releases/
    <artifact-sha256>/
  incoming/
  helper/

state-directory/
  active-release.json
  previous-release.json
  operation-lock
  operations/
  data-backups/
```

Do not depend on a symbolic link for activation. Windows has different link behavior and permissions.

Use an atomic pointer file. Make the stable service launcher read that pointer before it starts T3 Code.

Make the fleet management account own the helper, pointer files, incoming files, and release directories.

Give the runtime account read and execute access to active release files. Do not give it write access.

Make the runtime account own only T3 Code user data and runtime files.

Make the stable launcher, service adapter, and service definition root-owned or administrator-owned.

Give the management account only the data access required for verified backup and restore operations.

Keep the previous release after each successful activation. Keep its pointer until a later deployment succeeds.

### Stage operation

1. Transfer the artifact to the incoming directory.
2. Verify the detached descriptor signature.
3. Verify the archive size and checksum.
4. Read and validate the release manifest.
5. Compare the manifest with the machine facts.
6. Extract into a new release directory.
7. Reject links, devices, duplicate paths, and paths outside the release directory.
8. Enforce limits for file count, expanded size, and path length.
9. Verify the payload file checksums.
10. Run a command syntax check.
11. Mark the artifact digest as staged.

The stage operation must not restart T3 Code. It must not change the active release.

### Activate operation

1. Verify that the release is staged.
2. Return success when the requested digest is already active and healthy.
3. Verify the release data compatibility declaration.
4. Write the durable operation intent, old pointer, and old service state.
5. Stop T3 Code when a consistent data backup is required.
6. Create and verify the required data backup.
7. Record the current active release as the previous release.
8. Replace the active pointer atomically.
9. Start or restart T3 Code.
10. Wait for the service port with a fixed deadline.
11. Run a functional T3 Code health check.
12. Commit the transaction only after the health check passes.
13. Restore the previous pointer when the health check fails.
14. Restore compatible data when the policy requires it.
15. Restore the old service state after an automatic restore.
16. Record the final health result and transaction result.

The activate operation stops active sessions. The dashboard must state this result before confirmation.

Refuse unattended activation when the release can make an unknown or irreversible data change.

Use `unknown` when build inputs do not declare data behavior. Do not infer compatibility from the Git revision or version.

Require a tested backup and recovery procedure before an operator permits an irreversible change.

### Rollback operation

1. Verify that a previous release exists.
2. Verify that stored data and backup facts permit rollback.
3. Write a durable rollback intent with both current pointers and the service state.
4. Stop T3 Code when a consistent data restore requires it.
5. Restore the associated verified data backup when required.
6. Change the active pointer to the previous release.
7. Start or restart T3 Code.
8. Run the functional health check.
9. Restore the original pointer and data when the rollback health check fails.
10. Restore the old service state after a failed rollback.
11. Record the final health result and transaction result.
12. Keep both release directories for inspection.

Do not run a source build during rollback.

Do not offer rollback when the stored compatibility facts do not permit it. Show the recovery procedure instead.

Use the same durable phases and restart reconciliation for activation and rollback.

### Transaction recovery

Use these durable activation phases:

```text
received
validated
prepared
service-stopped
data-backed-up
pointer-changed
service-restarted
checking
restoring
complete
failed
```

Write each phase with atomic replacement. Sync the file and parent directory before the next external effect.

On helper start, inspect each unfinished transaction. Compare the service, pointers, release files, and health state.

Complete or restore the transaction from measured state. Do not repeat a pointer change from the request alone.

## SSH transport

### Linux

Use standard OpenSSH over the Tailscale address for unattended fleet operations.

Use a dedicated fleet management user. Give this user no interactive shell and no T3 Code runtime ownership.

Install a dedicated controller key with `restrict` and a forced helper command.

Disable a terminal, agent forwarding, X11 forwarding, user startup files, and all port forwarding for this key.

Use a tailnet policy tag for the controller. Limit its network access to fleet client SSH and T3 Code ports.

Add SSH policy tests before unattended deployment begins.

Keep Tailscale SSH available only for approved enrollment or recovery. Do not use it for dashboard jobs.

### Windows

Use standard Windows OpenSSH over the Tailscale address. Restrict the firewall rule to the Tailscale interface.

Use a dedicated Windows account and an SSH `ForceCommand` rule for unattended fleet operations.

Disable forwarding and interactive sessions for the fleet account.

Run T3 Code with a separate Windows service account. Deny it write access to helper and release control files.

Use a PowerShell adapter for task control and file activation. Keep the shared validation in the Node.js helper.

Use a ZIP artifact for the first Windows implementation. Avoid a compression format that needs another client tool.

### SSH command construction

Use `execFile` or `spawn` with an argument array for the local SSH client.

Send no remote command arguments. Make the SSH server start the fixed helper command.

Send the operation request through standard input. Validate its schema before any effect.

Use noninteractive SSH for dashboard jobs. Set a connection timeout and a keepalive.

Keep host key checks on. Maintain a dedicated known hosts file for the fleet manager.

Do not trust `ssh-keyscan` as identity proof. Verify the first fingerprint through a separate trusted channel.

Use `StrictHostKeyChecking=yes`. Do not use automatic replacement after a host key change.

Do not read a remote host directly from an HTTP parameter. Resolve the machine identifier through the inventory.

Bound all remote output. Store only redacted output in the campaign log.

Set `ClearAllForwardings=yes`, `RequestTTY=no`, and `BatchMode=yes` for each dashboard operation.

### File transfer

Stream an artifact to the helper `upload` operation through standard input.

Do not use `scp` because its remote command bypasses the fixed helper protocol.

Do not replace an active release during transfer. Rename a complete incoming file before stage verification.

Verify the declared byte count and digest before the helper renames the incoming file.

Add resumable transfer only after measurements show a need.

## Dashboard authentication and authority

Treat the fleet dashboard as a high-authority service. A dashboard compromise can affect all fleet machines.

Bind the production dashboard to loopback. Publish it only through Tailscale Serve with HTTPS.

Restrict dashboard access with the tailnet policy. Restrict each console origin with the same policy.

Add an authenticated operator session before enabling remote changes. Do not rely on tailnet reachability alone.

Use one separate operator credential in the first version. Store only a slow password hash or a passkey public key.

Rate-limit failed authentication attempts. Write each failed attempt to the audit log without storing the supplied credential.

Create one offline recovery credential during controller installation. Never show it again after confirmation.

Require authentication for each dashboard route, console origin, and WebSocket upgrade.

Refuse all remote changes when operator authentication is not configured.

Keep a CSRF token for every change request. Set the session cookie as secure, HTTP only, and strict same site.

Bind each CSRF token to its operator session. Check the request origin for every change request.

Expire an idle operator session. Rotate its identifier after authentication and privilege changes.

Require a new confirmation for these operations:

- Activate a release.
- Roll back a release.
- Stop a service.
- Remove a machine.
- Uninstall a client.
- Change SSH settings.

Require recent operator authentication for activation, rollback, stop, uninstall, and SSH changes.

Show the exact machine names and count in a fleet confirmation.

Never put a proxy token, SSH credential, or session token in browser state.

Write each change to an audit log. Include the operator, machine, action, revision, time, and result.

Write and sync an accepted record before the operation starts. Write and sync its result after completion.

Include the artifact digest, machine instance identifier, operation identifier, and inventory generation.

Redact credentials, session tokens, request cookies, and secret helper fields before any log write.

Send audit records to a separate append-only sink when one is configured.

Document that a local audit file cannot prove activity after a controller compromise.

### Client network boundary

Permit the controller to reach each client T3 Code port through the tailnet policy.

Deny that port from other fleet clients and ordinary tailnet members by default.

Add negative policy tests for SSH, T3 Code, the dashboard, and every console origin.

Do not expose a client T3 Code port to the public network.

## Status collection

Poll machine status through the helper. Use a bounded concurrency limit.

Use separate concurrency limits for status work and change work. Give change work a reserved connection slot.

Use these initial intervals:

- Poll the selected machine frequently.
- Poll visible overview machines at a moderate interval.
- Poll offline machines with an increasing delay.
- Stop polling a disabled machine.

Do not mark a service as failed after one network timeout. Show an unknown state first.

Record the last successful contact time. Record the last error separately.

Cache status briefly to prevent duplicate SSH calls from multiple browser tabs.

Key the cache by machine instance identifier and inventory generation. Do not reuse it after identity changes.

Add server sent events only after the first polling implementation is stable.

## Jobs and campaigns

### Local job

A local job performs one operation on one machine. The controller runs local jobs through the local transport.

### Remote job

A remote job performs one operation on one machine. It connects, runs the helper, and records the result.

### Campaign

A campaign groups the same operation across selected machines.

Support these campaign types:

- Probe machines.
- Stage an artifact.
- Activate a staged release.
- Restart T3 Code.
- Roll back a release.
- Update the client helper.

Do not combine stage and activate in one campaign.

### Campaign states

Use these states:

```text
draft
queued
running
paused
complete
complete-with-errors
failed
canceled
```

Use these machine operation states:

```text
pending
connecting
transferring
verifying
running
checking
cancel-requested
complete
failed
unreachable
canceled
```

Persist each state transition. A controller restart must not repeat a completed operation.

After a controller restart, query each client operation before changing its campaign state.

Reconcile a running or unknown operation from the helper result. Do not infer failure from a lost SSH connection.

Persist each campaign definition before it enters the queue.

Snapshot these values for each machine operation:

- The machine identifier.
- The machine instance identifier.
- The verified SSH host key fingerprint.
- The transport endpoint.
- The platform target.
- The inventory generation.
- The exact artifact digest, when applicable.

Refuse an operation when a current identity value differs from its snapshot.

Permit a display name change during a campaign. Keep the original display name in its history.

Cancel only pending machine operations immediately. Mark an in-progress change as `cancel-requested`.

Do not kill an activation or rollback after its first external effect. Reconcile it, then stop later campaign work.

Pause and cancel stop new machine operations. They do not interrupt an in-progress client transaction.

### Deployment policy

Use one canary machine for an activation campaign. Require its health check before the next machine starts.

Use a default activation concurrency of one. Permit a higher value only through an explicit setting.

Pause the campaign after a canary failure. Keep unreachable machines pending until the operator chooses a result.

Deploy the controller machine last when it is part of the campaign.

Select the canary explicitly when the campaign starts. Persist its identity in the campaign definition.

Define the canary success window. Require health to remain good for that full window.

Do not treat a listening port as sufficient health. Run one authenticated functional request.

### Idempotency

Give each operation a unique identifier. Send that identifier to the client helper.

Store completed operation identifiers on the client. Return the stored result after a repeated request.

Store received and unfinished operation identifiers before the first change.

Bind an operation identifier to its action, artifact digest, and machine instance identifier.

Reject an identifier when a repeated request has different bound values.

Do not start a second change operation while the local operation lock is held.

## Server API plan

Move browser routes under a versioned dashboard API.

Use route groups similar to these examples:

```text
GET    /_dash/api/v1/fleet
GET    /_dash/api/v1/machines
POST   /_dash/api/v1/machines
GET    /_dash/api/v1/machines/:id
POST   /_dash/api/v1/machines/:id/probe
POST   /_dash/api/v1/machines/:id/actions
GET    /_dash/api/v1/artifacts
POST   /_dash/api/v1/builds
GET    /_dash/api/v1/campaigns
POST   /_dash/api/v1/campaigns
GET    /_dash/api/v1/campaigns/:id
POST   /_dash/api/v1/campaigns/:id/pause
POST   /_dash/api/v1/campaigns/:id/resume
POST   /_dash/api/v1/campaigns/:id/cancel
POST   /_dash/api/v1/campaigns/:id/retry
POST   /_dash/api/v1/auth/login
POST   /_dash/api/v1/auth/reauthenticate
POST   /_dash/api/v1/auth/logout
```

Use JSON request bodies. Validate every body before starting work.

Require an authenticated session on every route except login and the static login page.

Require a CSRF token and a permitted request origin for every change route.

Use an idempotency key on each change request. Return the stored response after a safe repeat.

Do not expose filesystem paths unless the operator needs them for recovery.

Return stable error codes with readable messages. Keep stack traces in server logs only.

## Source refactor plan

Split the current dashboard module before adding remote changes.

Use a structure similar to this plan:

```text
src/
  dashboard/
    main.mjs
    config.mjs
    auth/
    api/
    fleet/
      inventory.mjs
      status.mjs
      campaigns.mjs
    artifacts/
      builders.mjs
      manifests.mjs
      store.mjs
    jobs/
    proxy/
    transport/
      local.mjs
      ssh.mjs
    platform/
      linux.mjs
      windows.mjs
    ui/
      index.html
      app.js
      styles.css
  client-helper/
    main.mjs
    commands.mjs
    releases.mjs
    platform/
      linux.mjs
      windows.mjs
  t3code-dashboard.mjs
```

Keep `src/t3code-dashboard.mjs` as a compatibility entry point during the migration.

Do not add a frontend framework during the refactor. First separate the current HTML, CSS, and browser JavaScript.

Create small interfaces for the filesystem, command runner, service manager, transport, clock, and identifier generator.

Keep mock data outside production service modules. Reuse the mock data in browser tests.

## Installer refactor plan

Split installation into controller and client paths.

```text
install-controller.sh
install-controller.ps1
install-client.sh
install-client.ps1
```

Keep `install.sh` and `install.ps1` as compatibility wrappers during migration.

The controller installer must install these parts:

- The dashboard.
- The controller state directory.
- The local builder requirements.
- The fleet dashboard service.
- The local T3 Code service, when selected.

The client installer must install these parts:

- The fleet command helper.
- The stable T3 Code launcher.
- The T3 Code service or task.
- The release and state directories.
- An initial compatible artifact.
- The artifact verification public key.
- The fleet management account and its forced-command restriction.
- The separate T3 Code runtime account.
- The root-owned service adapter and narrow elevation rule.
- A stable machine instance identifier.

The client installer must not clone the T3 Code repository. It must not install the fleet dashboard.

Make the client installer the normal enrollment path. Run it locally on the client machine.

Require local administrator authority because the installer creates accounts, service rules, and protected files.

Accept a single-use enrollment file. Do not place a private controller key in this file.

Print the machine instance identifier and SSH host key fingerprint for separate verification.

Keep production approval guards. Add remote machine names to every approval message.

## Persistence plan

Keep all mutable fleet state outside the repository.

Use this initial controller layout:

```text
state-directory/
  settings.json
  fleet.json
  artifacts/
  builds/
  campaigns/
  jobs/
  proxy-sessions/
  audit.jsonl
  known-hosts
  keys/
  backups/
```

Write JSON files with atomic replacement. Write logs as bounded append records.

Sync a durable state transition before its related external effect starts.

Run one controller writer for inventory, jobs, campaigns, and retention changes.

Use directory mode `0700`. Use file mode `0600` for credentials, tokens, and signing keys.

Validate the owner and permissions during controller start. Refuse remote changes after an unsafe result.

Back up inventory, campaign state, audit records, known hosts, and signing key recovery material.

Exclude live proxy tokens and operator sessions from backups.

Encrypt each backup outside the controller state directory. Test restore into an isolated controller instance.

Define signing key rotation. Keep old public keys while a retained artifact or release needs them.

Define SSH controller key rotation. Verify the new path before the old key loses authority.

Put storage behind a small interface. Permit a later database without changing job or API code.

Do not add a database until file storage causes a measured problem.

## Test plan

### Unit tests

Use the Node.js test runner for pure modules.

Test these areas:

- Inventory validation and migration.
- Machine identifier validation.
- Artifact target matching.
- Node.js version matching.
- libc version matching.
- Manifest and checksum validation.
- Detached descriptor signature validation.
- Archive size and extraction limits.
- Archive link, device, duplicate path, and traversal rejection.
- Release path containment.
- Job state transitions.
- Campaign canary selection.
- Campaign concurrency limits.
- Operation idempotency.
- Operation request binding.
- Unfinished transaction reconciliation.
- SSH argument construction.
- Secret output redaction.
- Proxy target selection.
- Fixed console origin selection.
- Tab selection state.

### Transport tests

Test the SSH transport with a fake command runner. Verify every argument and timeout.

Test connection failures, host key failures, timeouts, partial output, and nonzero exits.

Start an isolated OpenSSH server. Verify that the fleet key cannot start a shell or an arbitrary command.

Verify that the fleet key cannot create a terminal, forwarding channel, agent channel, or user startup command.

Run a process as the T3 Code runtime account. Verify that it cannot change helper, launcher, release, pointer, or SSH files.

Verify that the fleet management account can run only the fixed elevated service adapter.

Fuzz each adapter request. Verify that no request changes another service, path, account, or executable.

Test a changed host key. Verify that status and change operations stop.

Test the local transport with temporary directories. Do not use the production state directory.

### Helper tests

Test stage and activation with temporary release directories. Use fake service managers for unit tests.

Test checksum failure, target mismatch, invalid paths, missing releases, and lock conflicts.

Test automatic rollback after a failed health check.

Inject a process stop after each activation and rollback phase. Verify measured recovery after every restart.

Test a repeated activation of the active digest. Verify that the previous pointer does not change.

Test an incompatible data declaration. Verify that activation and rollback remain unavailable.

Test helper update failure. Verify that the fixed launcher selects the previous verified helper.

### API tests

Test each route with valid and invalid bodies. Test authentication, authorization, and CSRF failures.

Test unauthenticated and expired sessions on HTTP and WebSocket routes.

Test recent authentication requirements for each high-risk action.

Test that a browser machine identifier cannot become an SSH host or filesystem path.

Test that a secret helper result never appears in a response, log, audit record, or error.

### Browser tests

Extend mock mode with multiple machines and fleet campaigns.

Test these tab conditions:

- Many online machines.
- Offline machines.
- A running machine operation.
- A failed machine operation.
- A long display name.
- More tabs than the viewport width.
- A removed selected machine.
- A mobile viewport.

Measure `scrollHeight`, `clientHeight`, tab visibility, and computed overflow styles.

Test keyboard tab movement and focus. Test the selected tab after a page reload.

Open two browser tabs with different selected machines. Run concurrent HTTP and WebSocket traffic.

Verify that each request reaches only its fixed machine. Inspect cookies and browser storage for cross-origin leaks.

Make a fake machine request all browser headers and set hostile cookies. Verify that neither direction crosses the proxy boundary.

Verify that a console origin cannot read a dashboard response or submit a change without the bound CSRF token.

### Platform tests

Run Linux tests on the controller platform. Add Windows tests before the first Windows client deployment.

Build and inspect one artifact for each supported target. Test each artifact on its target platform.

Do not approve a target from archive contents alone. Start T3 Code and run the health check.

Test the tailnet policy with positive and negative assertions for every exposed port.

### End to end tests

Keep the current instance checks during migration. Add a fleet test with two isolated fake machines.

Test stage, activate, service health, failure, rollback, and campaign resume.

Change inventory identity fields during a pending campaign. Verify that the campaign refuses the changed machine.

Restart the controller during each campaign phase. Verify that no completed effect repeats.

Restore a controller backup into an isolated instance. Verify inventory, campaigns, known hosts, and artifact trust.

Use temporary values for `T3CODE_HOME` and `T3CODE_STATE_DIR`. Never point a test at production data.

## Documentation plan

Keep the root README as the entry point. Move detailed information into focused documents.

```text
docs/
  architecture.md
  controller-installation.md
  client-installation.md
  fleet-inventory.md
  artifact-builds.md
  deployment-campaigns.md
  ssh-security.md
  linux-clients.md
  windows-clients.md
  recovery.md
  development.md
  api.md
  decisions/
```

Document the blast radius for each control. State what changes, what restarts, and what remains unchanged.

Document a manual recovery command for each automated change. Keep Linux and Windows procedures separate.

Generate the environment variable table from one configuration definition when practical.

## Migration stages

### Stage 0: Record the current behavior

1. Add characterization tests for the current routes and jobs.
2. Record the current service, proxy, build, and update boundaries.
3. Keep the current dashboard and installers unchanged.

Exit when the current behavior has repeatable tests.

### Stage 1: Split the dashboard module

1. Extract configuration and platform adapters.
2. Extract Git and build operations.
3. Extract the HTTP router and proxy.
4. Extract HTML, CSS, and browser JavaScript.
5. Keep the current page behavior.

Exit when the current checks and browser tests pass without behavior changes.

### Stage 2: Add fleet inventory and mock tabs

1. Add the versioned inventory store.
2. Add the overview tab.
3. Add the top machine tabs.
4. Add mock states for online, offline, busy, and failed machines.
5. Keep every remote action disabled.

Exit when tab behavior passes desktop, mobile, and keyboard tests.

### Stage 3: Secure the controller and enrollment boundary

1. Add operator authentication, session expiry, recent authentication, and CSRF checks.
2. Add fixed console origin configuration with all remote targets disabled.
3. Add signing key creation, permission checks, backup, and restore.
4. Add the manual client enrollment contract and machine instance identifier.
5. Add Linux forced-command and tailnet policy test fixtures.
6. Add the management account, runtime account, and root-owned service adapter contract.

Exit when an unauthenticated request cannot reach any dashboard, console, or WebSocket content.

Exit when the fleet SSH key cannot start an arbitrary command, terminal, or forwarding channel.

Exit when the T3 Code runtime account cannot change any management or release control file.

### Stage 4: Add the client helper and local transport

1. Add the versioned standard input protocol.
2. Add probe, status, upload, stage, activate, rollback, and service commands.
3. Add durable operation transactions and restart reconciliation.
4. Add helper update with two verified helper releases.
5. Use the helper for the local controller machine.
6. Keep the current local deployment path as a temporary fallback.

Exit when every transaction crash test restores or completes from measured state.

### Stage 5: Add Linux artifact builds

1. Build the Linux x64 artifact on the controller.
2. Add the release manifest and payload checksum list.
3. Add the signed detached artifact descriptor.
4. Add the digest based controller artifact store.
5. Stage and activate the artifact locally.
6. Test compatible data recovery and incompatible data refusal.

Exit when the controller needs no source path during activation.

Exit when archive validation rejects every unsafe archive test.

### Stage 6: Add one enrolled Linux client

1. Run the client installer locally on the selected client.
2. Verify the machine instance identifier and SSH host key separately.
3. Add the restricted SSH transport and helper upload.
4. Add remote stage, activation, functional health, logs, and rollback.
5. Add positive and negative tailnet policy tests.

Exit when one Linux client runs without a dashboard or source clone.

Exit when the controller cannot run a remote command outside the helper protocol.

### Stage 7: Add the selected machine console

1. Add one fixed controller console origin for each enabled machine.
2. Add per-machine proxy sessions with secret output handling.
3. Add remote session issue through the helper.
4. Add HTTP and WebSocket authentication on every console origin.
5. Reload the console frame when the top tab changes.
6. Test simultaneous browser tabs against different machines.

Exit when each request remains on its fixed machine during concurrent use.

### Stage 8: Add fleet campaigns

1. Add persistent jobs and campaigns.
2. Snapshot machine identity, inventory generation, and artifact digest.
3. Add machine selection and stage campaigns.
4. Add explicit canary activation and a success window.
5. Add pause, resume, retry, and cancel controls.
6. Add controller restart and inventory mutation tests.

Exit when a controller restart does not repeat completed machine effects.

Exit when an identity change stops each affected pending operation.

### Stage 9: Add Windows support when required

1. Add the Windows client helper adapter.
2. Add the Windows service task adapter.
3. Add OpenSSH `ForceCommand` enrollment checks.
4. Add a Windows artifact builder.
5. Add ZIP safety, activation, health, and rollback tests.

Exit when one Windows client passes the same security and release tests as Linux.

### Stage 10: Remove client dashboards

1. Migrate each existing client through the normal enrollment path.
2. Verify its fixed console origin and central proxy session.
3. Verify stage, activate, health, transaction recovery, and rollback.
4. Stop and remove its dashboard service.
5. Remove its dashboard Serve mapping.

Exit when all client machines run T3 Code without a local dashboard.

### Stage 11: Harden and simplify

1. Remove obsolete local dashboard paths.
2. Remove compatibility wrappers after one stable release.
3. Add retention, signing key rotation, SSH key rotation, and audit maintenance.
4. Test controller backup and isolated restore.
5. Review all remote command and network permissions.
6. Complete operator and recovery documentation.

Exit when the fleet manager is the only supported dashboard mode.

## Delivery sequence

Use small changes with one primary purpose.

1. Add current behavior tests.
2. Extract configuration and adapters.
3. Extract server and browser files.
4. Add the inventory store.
5. Add top machine tabs in mock mode.
6. Add operator authentication and fixed console origins.
7. Add enrollment and forced-command test fixtures.
8. Add the durable client helper.
9. Add signed local artifact deployment.
10. Enroll one Linux client manually.
11. Add restricted Linux SSH deployment.
12. Add selected machine proxying.
13. Add identity-pinned fleet campaigns.
14. Add Windows support when the fleet needs it.
15. Remove per-machine dashboards.
16. Complete recovery, rotation, and audit work.

Do not combine a source refactor with the first remote deployment change.

## Risks and controls

| Risk | Control |
| --- | --- |
| A dashboard compromise affects the fleet. | Add operator authentication, a forced helper command, narrow network access, and audit logs. |
| The wrong artifact reaches a machine. | Pin its digest, verify its signed descriptor, and match the complete target. |
| A newer glibc breaks an older client. | Record a minimum version and build on a compatible baseline. |
| A controller restart repeats deployment. | Persist the intent and each transaction phase before an external effect. |
| Two actions change one client together. | Hold a client operation lock. |
| A bad release stops T3 Code. | Keep the previous release and restore it after a failed functional health check. |
| A release changes incompatible user data. | Require a compatibility declaration, a tested backup, or explicit refusal. |
| A Windows client receives Linux files. | Use separate target builders and strict target matching. |
| An SSH value becomes a shell command. | Enforce a forced command and send a validated request through standard input. |
| A fleet key starts another SSH feature. | Disable terminals, forwarding, agents, user startup files, and arbitrary commands. |
| A compromised T3 Code process changes management. | Separate accounts and deny runtime writes to all management control files. |
| An elevated service adapter changes another service. | Fix its service name, roots, actions, executable, and request schema. |
| A browser chooses an arbitrary proxy. | Give each machine a fixed controller console origin. |
| Two browser tabs mix machine traffic. | Isolate their console origins and test concurrent HTTP and WebSocket traffic. |
| A compromised client reads or changes operator cookies. | Strip all cookies in both proxy directions and require CSRF checks. |
| A host name points to a replacement machine. | Pin the SSH host key and machine instance identifier in each operation. |
| A token enters a campaign log. | Mark secret result fields and redact before every response or log write. |
| A hostile archive escapes staging. | Reject unsafe entries and enforce count, size, and path limits. |
| Many machines restart together. | Use a canary and a default concurrency of one. |
| An offline machine blocks the fleet. | Keep it pending and permit an operator decision. |
| A client helper is older than the controller. | Use protocol versions and capability checks. |
| A helper update breaks management. | Keep two signed helper releases behind a fixed launcher. |
| The controller state is lost. | Back up durable state and test restore in isolation. |
| A local audit log changes after compromise. | Support a separate append-only audit sink and document the local limit. |

## Completion criteria

The conversion is complete when all these conditions pass:

- The fleet dashboard runs on one controller.
- Connected machines appear as top tabs.
- The overview shows every enabled machine.
- Each machine tab shows correct local or remote status.
- Each machine tab opens the correct T3 Code console.
- A normal client has no dashboard service.
- A normal client has no T3 Code source clone.
- The controller builds one artifact for each required target.
- Each artifact has a verified signed descriptor and immutable digest identity.
- The controller refuses an incompatible artifact.
- Stage does not restart T3 Code.
- Activate warns that it stops sessions.
- A failed health check restores the previous release.
- Each activation and rollback crash point has a tested recovery result.
- An incompatible data change blocks unattended activation and rollback.
- A campaign uses a canary before later machines.
- A controller restart does not repeat completed work.
- A changed machine identity stops its pending campaign operation.
- Each supported operating system uses its own service adapter.
- Remote commands use an allowlisted client helper.
- The SSH server enforces the helper as a forced command.
- The fleet SSH key cannot start a terminal, forwarding channel, or arbitrary command.
- The T3 Code runtime account cannot change helper, launcher, release, pointer, service, or SSH files.
- The management account has no general elevation rule or administrator shell.
- Operator authentication protects dashboard, console, API, and WebSocket routes.
- Two browser tabs cannot mix traffic between machines.
- Secret helper results do not appear in any response or log.
- Tailnet policy tests deny unintended SSH, T3 Code, dashboard, and console access.
- Fleet actions appear in the audit log.
- An isolated controller restore passes from a current backup.
- Browser layout measurements pass at supported viewport sizes.
- Production data remains outside every test environment.

## Initial scope

Implement Linux x64 support first. Run the dashboard and first client on the controller machine.

Use one separate Linux machine for the first remote enrollment and deployment milestone.

Add the second platform only after the next client machine is selected.

Keep Windows in the design. Do not build Windows support before a Windows client exists.

Do not add automatic tailnet discovery in the first version. Use explicit enrollment and a reviewed inventory.

Do not add a database in the first version. Use versioned files and atomic writes.

Do not add a frontend framework in the first version. Preserve the current direct browser implementation.
