#!/usr/bin/env node
// Small status/control dashboard for the t3code service.
// Binds to the tailnet address, same trust boundary as t3code itself.

import { createServer, request as httpRequest } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

const PORT = Number(process.env.T3CODE_DASH_PORT ?? 4124)
// An empty unit means this instance is not run by systemd -- the no-install
// dev mode, where the fork's own dev runner owns the process. Service control
// and the build jobs do not apply there.
const UNIT = process.env.T3CODE_UNIT ?? 't3code.service'
const MANAGED = UNIT !== ''

// Points the proxy at a running dev server instead of the installed build's
// runtime file. In the fork's dev mode the browser origin is the web dev
// server, which proxies the backend itself.
const PROXY_ORIGIN = process.env.T3CODE_PROXY_ORIGIN ?? ''
const T3_BIN = process.env.T3CODE_BIN ?? 't3'
const NPM_BIN = process.env.NPM_BIN ?? 'npm'
const NPM_PREFIX = process.env.NPM_PREFIX ?? ''
const PNPM_BIN = process.env.PNPM_BIN ?? 'pnpm'
const CHANNEL = process.env.T3CODE_CHANNEL ?? 'nightly'

// Source mode. When T3CODE_REPO is unset the dashboard keeps its original
// npm-only behaviour, so an install that never adopted the fork still works.
const REPO = process.env.T3CODE_REPO ?? ''
const BRANCH = process.env.T3CODE_BRANCH ?? 'deploy'
const DEV_REPO = process.env.T3CODE_DEV_REPO ?? ''
const DEV_BRANCH = process.env.T3CODE_DEV_BRANCH ?? 'dev'
const STATE_DIR = process.env.T3CODE_STATE_DIR ?? `${process.env.HOME}/.local/state/t3code-host`
const BUILT_SHA_PATH = `${STATE_DIR}/built-sha`
const T3_HOME = process.env.T3CODE_HOME ?? `${process.env.HOME}/.t3`

// Serving the page already requires being on the tailnet; this token only
// stops a random page in your browser from POSTing to us.
const TOKEN = randomBytes(16).toString('hex')

// On a reboot this can start before tailscaled has an address. Binding the
// loopback fallback then leaves the dashboard unreachable on the tailnet until
// someone notices, so wait for a real address and let systemd retry the unit
// rather than come up on the wrong one.
async function tailnetHost({ attempts = 30, delayMs = 2000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const { stdout } = await run('/usr/bin/tailscale', ['ip', '-4'])
      const address = stdout.trim().split('\n')[0]
      if (address) return address
    } catch {
      // tailscaled not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return null
}

// Needed before the first request to recognise our own Tailscale Serve mapping.
const HOST = await tailnetHost()
if (!HOST) {
  console.error('no Tailscale IPv4 address after 60s; exiting so systemd retries')
  process.exit(1)
}

async function systemctl(...args) {
  try {
    const { stdout } = await run('systemctl', ['--user', ...args])
    return stdout.trim()
  } catch (err) {
    // is-active/is-enabled exit non-zero for inactive units but still print
    return (err.stdout ?? '').trim() || `error: ${err.message}`
  }
}

async function installedVersion() {
  try {
    const { stdout } = await run(T3_BIN, ['--version'])
    return stdout.trim().replace(/^t3 v?/, '')
  } catch {
    return 'unknown'
  }
}

// Which dist-tag this install tracks. Pinning to `latest` would downgrade a
// nightly install to the stable release, so follow the installed channel.
function channelFor(version) {
  const match = /-([a-z]+)\./.exec(version)
  return match ? match[1] : 'latest'
}

async function latestVersion() {
  const channel = CHANNEL || channelFor(await installedVersion())
  const { stdout } = await run(NPM_BIN, ['view', `t3@${channel}`, 'version'], {
    timeout: 30_000,
  })
  return stdout.trim()
}

function npmInstallArgs(packageName) {
  const args = ['install', '--global']
  if (NPM_PREFIX) args.push('--prefix', NPM_PREFIX)
  args.push(packageName)
  return args
}

// Build number is the only monotonic part of a nightly version
// (0.0.32-nightly.20260804.997 -> 997); stable versions fall back to 0.
function buildNumber(version) {
  const match = /-nightly\.\d+\.(\d+)$/.exec(version)
  return match ? Number(match[1]) : 0
}

// Returns true when the installed build is the registry build or newer. This
// also prevents a temporarily stale/misread stable tag from offering a
// downgrade over a nightly whose base version is already ahead.
function isUpToDate(installed, latest) {
  if (installed === latest) return true

  const parts = (version) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d+)\.(\d+))?$/.exec(version)
    return match ? match.slice(1).map((part) => Number(part ?? 0)) : null
  }
  const a = parts(installed)
  const b = parts(latest)
  if (!a || !b) return false

  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  // A stable release is newer than a nightly of the same base version.
  if (!a[3] && b[3]) return true
  if (a[3] && !b[3]) return false
  return a[3] > b[3] || (a[3] === b[3] && a[4] >= b[4])
}

// Releases strictly newer than `from`, up to and including `to`, oldest first.
async function changelog(from, to) {
  const { stdout } = await run(
    '/usr/bin/gh',
    ['api', '--paginate', 'repos/pingdotgg/t3code/releases?per_page=100'],
    { timeout: 45_000, maxBuffer: 32 * 1024 * 1024 },
  )
  // --paginate concatenates JSON arrays; stitch them into one.
  const releases = JSON.parse(stdout.replace(/\]\s*\[/g, ','))

  const lo = buildNumber(from)
  const hi = buildNumber(to)

  return releases
    .map((r) => ({
      version: r.tag_name.replace(/^v/, ''),
      name: r.name,
      url: r.html_url,
      published: r.published_at,
      body: r.body ?? '',
      build: buildNumber(r.tag_name),
    }))
    .filter((r) => r.build > lo && r.build <= hi)
    .sort((a, b) => a.build - b.build)
}

// ---------------------------------------------------------------------------
// fork state
// ---------------------------------------------------------------------------

// Always -C into the repo so the dashboard's own cwd is never load-bearing.
async function git(...args) {
  const { stdout } = await run('git', ['-C', REPO, ...args], {
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout.trim()
}

async function gitIn(worktree, ...args) {
  const { stdout } = await run('git', ['-C', worktree, ...args], {
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout.trim()
}

async function gitInOrNull(worktree, ...args) {
  try {
    return await gitIn(worktree, ...args)
  } catch {
    return null
  }
}

// A fetch changes the remote-tracking refs only. It does not change the
// worktree or the build. Thus you can do it on demand and on the timer. A job
// owns the repository while it runs, so this function stops during a job.
function fetchRemotes() {
  if (activeJob && jobs.get(activeJob)?.state === 'running') return Promise.resolve(null)
  return gitOrNull('fetch', '--prune', '--multiple', 'origin', 'upstream')
}

async function gitOrNull(...args) {
  try {
    return await git(...args)
  } catch {
    return null
  }
}

// Test-merges in memory and leaves the worktree alone, so the dashboard can
// report conflicts before it has committed to anything. Non-zero exit means
// conflicts; the conflicted paths are on stdout after a blank line.
async function mergePreview(into, from) {
  try {
    await run('git', ['-C', REPO, 'merge-tree', '--write-tree', into, from], {
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    })
    return { clean: true, conflicts: [] }
  } catch (err) {
    // Output is: tree oid, then one "<mode> <oid> <stage>\tpath" line per
    // conflicted stage, then a blank line and human-readable messages. The
    // same path repeats once per stage, hence the Set.
    const [info = ''] = (err.stdout ?? '').split('\n\n')
    const conflicts = [
      ...new Set(
        info
          .split('\n')
          .slice(1)
          .map((line) => /^\d{6} [0-9a-f]+ [123]\t(.+)$/.exec(line)?.[1])
          .filter(Boolean),
      ),
    ]
    return { clean: false, conflicts }
  }
}

async function builtSha() {
  try {
    return (await readFile(BUILT_SHA_PATH, 'utf8')).trim() || null
  } catch {
    return null
  }
}

async function forkStatus() {
  if (!REPO) return null

  const [branch, head, dirty, mainBehind, deployBehind, built, devHead, devDirty, devAhead, devBehind] = await Promise.all([
    gitOrNull('rev-parse', '--abbrev-ref', 'HEAD'),
    gitOrNull('rev-parse', '--short', 'HEAD'),
    gitOrNull('status', '--porcelain'),
    gitOrNull('rev-list', '--count', 'main..upstream/main'),
    gitOrNull('rev-list', '--count', `${BRANCH}..main`),
    builtSha(),
    DEV_REPO ? gitIn(DEV_REPO, 'rev-parse', '--short', 'HEAD').catch(() => null) : null,
    DEV_REPO ? gitIn(DEV_REPO, 'status', '--porcelain').catch(() => null) : null,
    gitOrNull('rev-list', '--count', `${BRANCH}..${DEV_BRANCH}`),
    gitOrNull('rev-list', '--count', `${DEV_BRANCH}..${BRANCH}`),
  ])

  // Preview both merges. The second one is checked against upstream/main
  // rather than main whenever a sync is pending: main is about to become
  // upstream/main, and merging today's main would miss the real conflict.
  const pendingSync = Number(mainBehind) > 0
  const [syncPreview, deployPreview, devPreview] = await Promise.all([
    pendingSync ? mergePreview('main', 'upstream/main') : { clean: true, conflicts: [] },
    pendingSync || Number(deployBehind) > 0
      ? mergePreview(BRANCH, pendingSync ? 'upstream/main' : 'main')
      : { clean: true, conflicts: [] },
    Number(devAhead) > 0
      ? mergePreview(BRANCH, DEV_BRANCH)
      : { clean: true, conflicts: [] },
  ])

  const tip = await gitOrNull('rev-parse', '--short', BRANCH)
  const conflicts = [...new Set([...syncPreview.conflicts, ...deployPreview.conflicts, ...devPreview.conflicts])]

  return {
    repo: REPO,
    branch: BRANCH,
    checkedOut: branch,
    head,
    tip,
    built,
    needsRebuild: Boolean(tip && built && tip !== built),
    dirty: Boolean(dirty),
    mainBehind: Number(mainBehind ?? 0),
    deployBehind: Number(deployBehind ?? 0),
    dev: {
      repo: DEV_REPO,
      branch: DEV_BRANCH,
      head: devHead,
      dirty: Boolean(devDirty),
      ahead: Number(devAhead ?? 0),
      behind: Number(devBehind ?? 0),
      clean: devPreview.clean,
      conflicts: devPreview.conflicts,
    },
    clean: syncPreview.clean && deployPreview.clean,
    conflicts,
  }
}

async function incomingCommits() {
  const log = await gitOrNull('log', '--oneline', '--no-decorate', '-100', 'main..upstream/main')
  return log ? log.split('\n').filter(Boolean) : []
}

async function serviceDetail() {
  const raw = await systemctl(
    'show',
    UNIT,
    '-p',
    'ActiveState',
    '-p',
    'SubState',
    '-p',
    'MainPID',
    '-p',
    'ExecMainStartTimestamp',
    '-p',
    'UnitFileState',
    '-p',
    'NRestarts',
  )
  return Object.fromEntries(
    raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf('=')
        return [line.slice(0, i), line.slice(i + 1)]
      }),
  )
}

// Without systemd there is no unit to interrogate, so liveness is simply
// whether the dev server answers.
async function reachable(origin) {
  if (!origin) return false
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(5000) })
    return response.status > 0
  } catch {
    return false
  }
}

async function status() {
  const [detail, installed, url, origin] = await Promise.all([
    MANAGED ? serviceDetail() : {},
    installedVersion(),
    publishedUrl(),
    t3Origin(),
  ])

  if (!MANAGED) {
    const up = await reachable(origin)
    return {
      managed: false,
      unit: 'dev server',
      active: up ? 'active' : 'inactive',
      sub: up ? 'running' : 'not answering',
      enabled: 'not managed',
      pid: null,
      startedAt: null,
      restarts: '0',
      installed,
      url,
      origin,
    }
  }

  return {
    managed: true,
    unit: UNIT,
    active: detail.ActiveState ?? 'unknown',
    sub: detail.SubState ?? '',
    enabled: detail.UnitFileState ?? 'unknown',
    pid: detail.MainPID && detail.MainPID !== '0' ? detail.MainPID : null,
    startedAt: detail.ExecMainStartTimestamp || null,
    restarts: detail.NRestarts ?? '0',
    installed,
    url,
    origin,
  }
}

// Tailscale Serve publishes the dashboard, not T3 directly: T3 is reached
// through the proxy below, so one HTTPS origin covers both and the embedded
// console shares the dashboard's session cookie.
async function publishedUrl() {
  try {
    const { stdout } = await run('/usr/bin/tailscale', ['serve', 'status', '--json'], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const serve = JSON.parse(stdout)
    const self = `http://${HOST}:${PORT}`
    const match = Object.entries(serve.Web ?? {}).find(([, site]) =>
      Object.values(site.Handlers ?? {}).some((handler) => handler.Proxy === self),
    )
    return match ? `https://${match[0]}` : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// T3 proxy
// ---------------------------------------------------------------------------

// T3 is proxied under the dashboard's own origin so the embedded console is
// same-origin: its session cookie is first-party (no third-party cookie
// partitioning), and the page can read a 401 from /ws to tell whether this
// browser is paired.
//
// T3's client is built with BASE_URL "/", so its router only resolves when the
// document is at the root -- it cannot be moved to /t3code. Both therefore
// answer on "/", split by who is asking: a top-level navigation gets the
// dashboard, an embedded one gets T3. Sec-Fetch-Dest carries that, and the
// explicit ?embed=1 the iframe uses covers browsers that omit the header and
// doubles as a way to open the bare console in its own tab.
const DASH_PATH = '/dashboard'
const API_PREFIX = '/_dash/'
const EMBED_PARAM = 'embed'

// Only a top-level document navigation gets the dashboard; everything else at
// "/" is T3's. Defaulting the other way would hand the dashboard's HTML to
// every non-browser client -- the native and headless ones authenticate with a
// bearer token and send no fetch metadata at all, so they must not have to
// opt in to reaching the backend they were pointed at.
function wantsDashboard(req, url) {
  if (url.searchParams.get(EMBED_PARAM) === '1') return false
  return req.headers['sec-fetch-dest'] === 'document'
}

// The origin changes whenever T3 restarts on a different port, so re-read it
// rather than caching for the life of the process.
let originCache = { value: null, at: 0 }
async function t3Origin() {
  if (PROXY_ORIGIN) return PROXY_ORIGIN
  if (Date.now() - originCache.at < 5000) return originCache.value
  let value = null
  try {
    const runtime = JSON.parse(await readFile(`${T3_HOME}/userdata/server-runtime.json`, 'utf8'))
    value = runtime.origin ?? null
  } catch {
    value = null
  }
  originCache = { value, at: Date.now() }
  return value
}

// Per RFC 9110 these describe a single hop and must not be forwarded.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

// A pairing link is capped at five scopes, so a paired browser cannot manage
// clients or mint links -- the two things the console's Connections screen is
// for. `t3 auth session issue` mints all eight without restarting anything, so
// the proxy carries one and presents it on every request.
//
// This makes tailnet access to the dashboard the gate, in place of per-browser
// pairing. That is the boundary the dashboard already sits behind: it can
// already start, stop, and rebuild the service. Reaching T3 directly, outside
// this proxy, still requires pairing as before.
// ---------------------------------------------------------------------------
// dev runner
// ---------------------------------------------------------------------------

// The dev server of the fork. It starts on demand. It serves the development
// worktree from the source with hot reload.
//
// This server is not a systemd unit. Only one build owns the global `t3`
// package, and that build is the deploy build. A second installed service
// causes a conflict. This server is a child of the dashboard. It needs no
// build. It stops when the dashboard stops.
const devRunner = {
  state: 'stopped', // stopped | starting | running | stopping | failed
  pid: null,
  origin: null,
  home: null,
  output: '',
  error: null,
  child: null,
}

function devRunnerStatus() {
  return {
    configured: Boolean(DEV_REPO),
    repo: DEV_REPO || null,
    branch: DEV_BRANCH,
    state: devRunner.state,
    origin: devRunner.origin,
    error: devRunner.error,
    output: stripAnsi(devRunner.output).slice(-8000),
  }
}

// The runner prints its web port and its data directory on one line. The web
// port is the browser origin, because the runner proxies its own backend. The
// data directory holds the credentials. The proxy needs that directory to make
// a session for this backend and not for the deploy backend.
function readRunnerAnnouncements() {
  const text = stripAnsi(devRunner.output)
  const port = /\[dev-runner\][^\n]*webPort=(\d+)/.exec(text)
  const home = /\[dev-runner\][^\n]*baseDir=(\S+)/.exec(text)
  if (home) devRunner.home = home[1]
  if (port && !devRunner.origin) {
    devRunner.origin = `http://localhost:${port[1]}`
    devRunner.state = 'running'
  }
}

function startDevRunner() {
  if (!DEV_REPO) throw new Error('no development worktree is configured')
  if (devRunner.state === 'starting' || devRunner.state === 'running') return devRunnerStatus()

  Object.assign(devRunner, {
    state: 'starting', origin: null, home: null, output: '', error: null,
  })

  // The runner starts the backend and Vite as children. Thus it must have its
  // own process group. If it does not, the stop below cannot reach the
  // children.
  const child = spawn(PNPM_BIN, ['dev'], {
    cwd: DEV_REPO,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  devRunner.child = child
  devRunner.pid = child.pid

  const onData = (chunk) => {
    devRunner.output = (devRunner.output + chunk).slice(-64_000)
    readRunnerAnnouncements()
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  child.on('error', (err) => {
    devRunner.state = 'failed'
    devRunner.error = err.message
  })
  child.on('exit', (code, signal) => {
    // An exit before the port is a failure. Report it. An exit after the port
    // is the stop that the user asked for.
    const started = Boolean(devRunner.origin)
    const origin = devRunner.origin
    Object.assign(devRunner, {
      state: started || signal ? 'stopped' : 'failed',
      pid: null, origin: null, child: null,
      error: started || signal ? null : `dev runner exited with code ${code}`,
    })
    // Remove the dev credentials only. The deploy token stays correct.
    if (origin) sessionTokens.delete(origin)
  })

  return devRunnerStatus()
}

function stopDevRunner() {
  const pid = devRunner.pid
  if (!pid) {
    devRunner.state = 'stopped'
    return devRunnerStatus()
  }
  // The exit handler does the remaining steps. Show the new state now. If you
  // do not, the page shows "running" during the shutdown.
  devRunner.state = 'stopping'
  // Send the signal to the group. The children of the runner hold the ports.
  try { process.kill(-pid, 'SIGTERM') } catch { /* already gone */ }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }, 3000).unref()
  return devRunnerStatus()
}

// A dashboard restart must not leave a runner without a parent. Such a runner
// keeps its ports.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopDevRunner()
    process.exit(0)
  })
}
process.on('exit', () => {
  if (devRunner.pid) {
    try { process.kill(-devRunner.pid, 'SIGTERM') } catch { /* already gone */ }
  }
})

const SESSION_FILE = `${STATE_DIR}/proxy-session`
const DEV_SESSION_FILE = `${STATE_DIR}/proxy-session-dev`
const sessionTokens = new Map()

async function mintSessionToken(home) {
  const args = ['auth', 'session', 'issue', '--ttl', '30d', '--label', 'dashboard proxy', '--token-only']
  if (home) args.push('--base-dir', home)
  const { stdout } = await run(T3_BIN, args, { timeout: 30_000 })
  const token = stripAnsi(stdout).trim().split('\n').filter(Boolean).pop()?.trim()
  if (!token) throw new Error('t3 issued no token')
  return token
}

// 401 means the stored token was revoked or outlived its TTL.
async function tokenWorks(token, origin) {
  try {
    const response = await fetch(new URL('/ws', origin), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
    return response.status !== 401
  } catch {
    return false
  }
}

// The key is the origin. The deploy build and the dev runner are different
// backends. Each backend has its own credentials. If you send the token of one
// backend to the other backend, you get an HTTP 401.
async function proxySession(target) {
  const { origin, home, sessionFile } = target
  if (sessionTokens.has(origin)) return sessionTokens.get(origin)

  const stored = await readFile(sessionFile, 'utf8').catch(() => null)
  if (stored?.trim() && (await tokenWorks(stored.trim(), origin))) {
    sessionTokens.set(origin, stored.trim())
    return stored.trim()
  }
  try {
    const token = await mintSessionToken(home)
    await mkdir(STATE_DIR, { recursive: true }).catch(() => {})
    await writeFile(sessionFile, token, { mode: 0o600 }).catch(() => {})
    sessionTokens.set(origin, token)
    return token
  } catch {
    // Without a token the console still works, just with whatever the browser
    // paired for itself. Better than refusing to proxy at all.
    sessionTokens.set(origin, null)
    return null
  }
}

// This function finds the backend for the request. A cookie on the address of
// the dashboard holds the choice. Thus the choice applies to your browser
// only. Other clients on the tailnet continue to use the deploy build.
const TARGET_COOKIE = 't3code_target'

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

async function targetFor(req) {
  const wanted = cookieValue(req.headers.cookie, TARGET_COOKIE)
  if (wanted === 'dev' && devRunner.state === 'running' && devRunner.origin) {
    return { name: 'dev', origin: devRunner.origin, home: devRunner.home, sessionFile: DEV_SESSION_FILE }
  }
  const origin = await t3Origin()
  return origin ? { name: 'deploy', origin, home: T3_HOME, sessionFile: SESSION_FILE } : null
}

function forwardHeaders(headers, target, token) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out[key] = value
  }
  // T3 sees its own host, so any absolute URL it builds stays self-consistent.
  out.host = target.host
  if (token) {
    out.authorization = `Bearer ${token}`
    // Drop any session cookie the browser paired for itself, so the scopes in
    // the console are always the token's rather than whichever arrived first.
    const cookie = (headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part && !/^t3_session=/.test(part))
      .join('; ')
    if (cookie) out.cookie = cookie
    else delete out.cookie
  }
  return out
}

async function proxy(req, res) {
  const backend = await targetFor(req)
  if (!backend) {
    return json(res, 503, { error: 'T3 Code is not running, so there is nothing to proxy.' })
  }
  const token = await proxySession(backend)
  const target = new URL(req.url, backend.origin)
  const upstream = httpRequest(
    { protocol: target.protocol, hostname: target.hostname, port: target.port,
      method: req.method, path: target.pathname + target.search,
      headers: forwardHeaders(req.headers, target, token) },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    if (!res.headersSent) json(res, 502, { error: `proxy to T3 failed: ${err.message}` })
    else res.destroy()
  })
  req.pipe(upstream)
}

// The console is a WebSocket client, so the upgrade has to be proxied too;
// without this the app loads and then hangs retrying its connection.
async function proxyUpgrade(req, clientSocket, head) {
  const backend = await targetFor(req)
  if (!backend) return clientSocket.destroy()

  const token = await proxySession(backend)
  const target = new URL(req.url, backend.origin)
  const upstream = httpRequest({
    protocol: target.protocol, hostname: target.hostname, port: target.port,
    method: req.method, path: target.pathname + target.search,
    headers: {
      ...forwardHeaders(req.headers, target, token),
      connection: 'Upgrade',
      upgrade: req.headers.upgrade,
    },
  })

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = Object.entries(upstreamRes.headers).map(([k, v]) => k + ': ' + v)
    clientSocket.write(
      `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n${lines.join('\r\n')}\r\n\r\n`,
    )
    if (upstreamHead?.length) clientSocket.unshift(upstreamHead)
    upstreamSocket.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.pipe(clientSocket).pipe(upstreamSocket)
  })
  // A refused upgrade (401 when unpaired) arrives as a normal response.
  upstream.on('response', (upstreamRes) => {
    clientSocket.write(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n\r\n`)
    clientSocket.destroy()
  })
  upstream.on('error', () => clientSocket.destroy())

  if (head?.length) upstream.write(head)
  upstream.end()
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

// Tokens live in the URL fragment and are origin-independent, so a link minted
// against T3's local origin can be re-pointed at whichever origin the client
// should actually use. Minting locally also keeps `t3 pair --tailscale` from
// repointing the Serve mapping at T3 and cutting the dashboard off.
async function rebase(pairingUrl, base) {
  const target = new URL('/pair', base ?? (await publishedUrl()) ?? `http://${HOST}:${PORT}`)
  target.hash = new URL(pairingUrl).hash
  return target.toString()
}

// The link must come from the backend that the browser shows. A link from the
// deploy data directory does not give access to the dev runner.
async function createPairingLink({ label, ttl, home }) {
  const args = ['pair', '--ttl', ttl]
  if (label) args.push('--label', label)
  if (home) args.push('--base-dir', home)
  const { stdout } = await run(T3_BIN, args, {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const output = stripAnsi(stdout)
  const pairingUrl = /^Pairing URL:\s*(\S+)/m.exec(output)?.[1]
  const expires = /^Expires:\s*(.+)$/m.exec(output)?.[1]?.trim() ?? null
  if (!pairingUrl) throw new Error('T3 created a link but did not return a pairing URL.')
  return { pairingUrl: await rebase(pairingUrl), expires }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function createAdministrativePairingLink() {
  const logPath = `${STATE_DIR}/t3code.log`
  const before = await readFile(logPath).catch(() => Buffer.alloc(0))
  await run('systemctl', ['--user', 'restart', UNIT], { timeout: 30_000 })

  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const current = await readFile(logPath).catch(() => Buffer.alloc(0))
    const offset = current.length >= before.length ? before.length : 0
    const appended = current.subarray(offset).toString('utf8')
    const localPairingUrl = /^Pairing URL:\s*(\S+)/m.exec(stripAnsi(appended))?.[1]
    if (localPairingUrl) {
      return { pairingUrl: await rebase(localPairingUrl), expires: 'approximately 5 minutes' }
    }
    await sleep(250)
  }
  throw new Error('T3 restarted, but its administrative startup link was not found in time.')
}

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

// A rebuild runs for minutes, far longer than a request should be held open.
// Jobs run detached from the request; the page polls for output. Only one runs
// at a time, so two tabs cannot start competing builds.
const OUTPUT_LIMIT = 256 * 1024
const jobs = new Map()
let activeJob = null

function appendOutput(job, chunk) {
  job.output += chunk
  if (job.output.length > OUTPUT_LIMIT) {
    job.output = job.output.slice(job.output.length - OUTPUT_LIMIT)
  }
}

// spawn, not execFile: the point is to see build progress while it happens.
function exec(job, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    appendOutput(job, `$ ${command} ${args.join(' ')}\n`)
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO,
      env: { ...process.env, CI: '1' },
    })
    child.stdout.on('data', (data) => appendOutput(job, data.toString()))
    child.stderr.on('data', (data) => appendOutput(job, data.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      appendOutput(job, `\n`)
      if (code === 0) return resolve()
      reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

const step = (label, fn) => ({ label, fn })

// The three assets the upstream publish step asserts. If they exist the build
// produced something installable.
const BUILD_ASSETS = ['dist/bin.mjs', 'dist/service-launcher.mjs', 'dist/client/index.html']

const BUILD_STEPS = [
  step('guard deploy worktree', async (job) => {
    if (await git('status', '--porcelain')) {
      throw new Error(`${BRANCH} worktree has uncommitted changes`)
    }
    const checkedOut = await git('rev-parse', '--abbrev-ref', 'HEAD')
    if (checkedOut !== BRANCH) throw new Error(`deploy worktree must have ${BRANCH} checked out`)
    appendOutput(job, `${BRANCH} worktree clean\n`)
  }),
  step('install dependencies', (job) => exec(job, PNPM_BIN, ['install', '--frozen-lockfile'])),
  step('build web client', (job) =>
    exec(job, PNPM_BIN, ['exec', 'vp', 'run', '--filter', '@t3tools/web', 'build']),
  ),
  step('build CLI', (job) =>
    exec(job, 'node', ['apps/server/scripts/cli.ts', 'build', '--verbose']),
  ),
  // Native, needs a Rust toolchain, and T3 runs without it. A missing cargo
  // must not cost you the whole deploy.
  step('build resource monitor (optional)', async (job) => {
    try {
      await exec(job, PNPM_BIN, ['run', 'build:resource-monitor'])
      const target = `${REPO}/apps/server/dist/resource-monitor/linux-x64`
      await mkdir(target, { recursive: true })
      await exec(job, 'cp', [
        `${REPO}/native/resource-monitor/target/release/t3-resource-monitor`,
        `${target}/t3-resource-monitor`,
      ])
      await exec(job, 'chmod', ['+x', `${target}/t3-resource-monitor`])
    } catch (err) {
      appendOutput(job, `\n[skipped] resource monitor: ${err.message}\n`)
    }
  }),
  step('verify build assets', async (job) => {
    for (const asset of BUILD_ASSETS) {
      await readFile(`${REPO}/apps/server/${asset}`).catch(() => {
        throw new Error(`build did not produce apps/server/${asset}`)
      })
      appendOutput(job, `ok ${asset}\n`)
    }
  }),
]

// Installing and restarting are deliberately after every build step: a failed
// build leaves the running service exactly as it was.
const DEPLOY_STEPS = [
  step('install globally', (job) => exec(job, NPM_BIN, npmInstallArgs(`${REPO}/apps/server`))),
  step('restart service', (job) =>
    exec(job, 'systemctl', ['--user', 'restart', UNIT], { cwd: process.env.HOME }),
  ),
  step('record built revision', async (job) => {
    const sha = await git('rev-parse', '--short', 'HEAD')
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(BUILT_SHA_PATH, `${sha}\n`)
    appendOutput(job, `built ${sha}\n`)
  }),
]

const SYNC_STEPS = [
  step('fetch', (job) => exec(job, 'git', ['-C', REPO, 'fetch', '--prune', '--multiple', 'origin', 'upstream'])),
  step('guard deploy worktree', async (job) => {
    if (await git('status', '--porcelain')) {
      throw new Error(`${BRANCH} worktree has uncommitted changes`)
    }
    const checkedOut = await git('rev-parse', '--abbrev-ref', 'HEAD')
    if (checkedOut !== BRANCH) throw new Error(`deploy worktree must have ${BRANCH} checked out`)
    appendOutput(job, `${BRANCH} worktree clean\n`)
  }),
  // main is a pure mirror of upstream, so a non-fast-forward here means
  // something rewrote it locally and a human should look.
  step('sync main from upstream', async (job) => {
    await exec(job, 'git', ['-C', REPO, 'merge-base', '--is-ancestor', 'main', 'upstream/main'])
    await exec(job, 'git', ['-C', REPO, 'branch', '-f', 'main', 'upstream/main'])
    await exec(job, 'git', ['-C', REPO, 'push', 'origin', 'main'])
  }),
  step(`merge main into ${BRANCH}`, (job) => mergeInto(job, REPO, 'main', BRANCH)),
  // If deploy moves forward and dev does not, the two branches become
  // different. Thus this step moves dev forward in the same run. A conflict
  // here is not fatal. The deployed build stays correct. You correct dev by
  // hand.
  step(`merge ${BRANCH} into ${DEV_BRANCH}`, async (job) => {
    if (!DEV_REPO || DEV_REPO === REPO) {
      appendOutput(job, 'no separate development worktree; skipped\n')
      return
    }
    if (await gitIn(DEV_REPO, 'status', '--porcelain')) {
      appendOutput(job, `[skipped] ${DEV_BRANCH} worktree has uncommitted changes\n`)
      return
    }
    try {
      await mergeInto(job, DEV_REPO, BRANCH, DEV_BRANCH)
      // The branch can have no upstream. A push failure here must not fail a
      // deploy that is complete.
      const pushed = await gitInOrNull(DEV_REPO, 'push', 'origin', DEV_BRANCH)
      appendOutput(job, pushed === null ? `[skipped] could not push ${DEV_BRANCH}\n` : `pushed ${DEV_BRANCH}\n`)
    } catch (err) {
      appendOutput(job, `[skipped] ${err.message}\n`)
    }
  }),
]

// Do a fast-forward when the history permits one. Make a merge commit only
// when the history does not permit a fast-forward. The --ff option is the
// default. This code gives the option to show the intention.
async function mergeInto(job, worktree, from, into) {
  const before = await gitIn(worktree, 'rev-parse', 'HEAD')
  try {
    await exec(job, 'git', ['-C', worktree, 'merge', '--ff', '--no-edit', from])
  } catch (err) {
    // Cancel the full merge. Do not leave an incomplete merge in the worktree.
    const conflicts = await gitInOrNull(worktree, 'diff', '--name-only', '--diff-filter=U')
    await gitInOrNull(worktree, 'merge', '--abort')
    throw new Error(`merging ${from} into ${into} conflicted, aborted. Resolve in ${worktree}: ${conflicts || err.message}`)
  }
  const after = await gitIn(worktree, 'rev-parse', 'HEAD')
  if (before === after) appendOutput(job, `${into} already had ${from}\n`)
  return after
}

// A promotion is the only path from dev to deploy. After a sync, deploy is an
// ancestor of dev. Thus a promotion is usually a fast-forward. The build then
// contains the same commit that you tested on the dev runner.
const PROMOTE_STEPS = [
  step('guard worktrees', async (job) => {
    if (await git('status', '--porcelain')) throw new Error(`${BRANCH} worktree has uncommitted changes`)
    if (!DEV_REPO) throw new Error('T3CODE_DEV_REPO is not configured')
    if (await gitIn(DEV_REPO, 'status', '--porcelain')) {
      throw new Error(`${DEV_BRANCH} worktree has uncommitted changes`)
    }
    const checkedOut = await git('rev-parse', '--abbrev-ref', 'HEAD')
    if (checkedOut !== BRANCH) throw new Error(`deploy worktree must have ${BRANCH} checked out`)
    appendOutput(job, 'deploy and development worktrees clean\n')
  }),
  step(`promote ${DEV_BRANCH} to ${BRANCH}`, (job) => mergeInto(job, REPO, DEV_BRANCH, BRANCH)),
]

const PUSH_STEP = [
  step(`push ${BRANCH}`, (job) => exec(job, 'git', ['-C', REPO, 'push', 'origin', BRANCH])),
]

const JOBS = {
  'sync-build-deploy': [...SYNC_STEPS, ...BUILD_STEPS, ...DEPLOY_STEPS, ...PUSH_STEP],
  'promote-dev': [...PROMOTE_STEPS, ...BUILD_STEPS, ...DEPLOY_STEPS, ...PUSH_STEP],
  rebuild: [...BUILD_STEPS, ...DEPLOY_STEPS],
}

function startJob(name) {
  const steps = JOBS[name]
  if (!steps) throw new Error(`unknown job: ${name}`)
  if (!REPO) throw new Error('T3CODE_REPO is not configured')
  if (activeJob && jobs.get(activeJob)?.state === 'running') {
    const err = new Error('a job is already running')
    err.conflict = true
    throw err
  }

  const id = randomBytes(8).toString('hex')
  const job = { id, name, state: 'running', step: steps[0].label, output: '', error: null }
  jobs.set(id, job)
  activeJob = id

  // Deliberately not awaited: the POST returns the id immediately.
  ;(async () => {
    try {
      for (const { label, fn } of steps) {
        job.step = label
        appendOutput(job, `\n=== ${label} ===\n`)
        await fn(job)
      }
      job.state = 'ok'
      job.step = 'done'
    } catch (err) {
      job.state = 'failed'
      job.error = err.message
      appendOutput(job, `\nFAILED: ${err.message}\n`)
    } finally {
      activeJob = null
    }
  })()

  return job
}

const ACTIONS = {
  start: () => systemctl('start', UNIT),
  stop: () => systemctl('stop', UNIT),
  restart: () => systemctl('restart', UNIT),
  update: async () => {
    const channel = CHANNEL || channelFor(await installedVersion())
    const { stdout } = await run(NPM_BIN, npmInstallArgs(`t3@${channel}`), {
      timeout: 300_000,
      env: { ...process.env, CI: '1' },
    })
    const after = await systemctl('restart', UNIT)
    return `${stdout.trim()}\n${after}`.trim()
  },
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  try {
    // An explicit dashboard URL that does not depend on fetch metadata, for
    // bookmarks and for browsers too old to send it.
    const dashboardPath = url.pathname === DASH_PATH || url.pathname === DASH_PATH + '/'

    if (dashboardPath || (url.pathname === '/' && wantsDashboard(req, url))) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'method not allowed' })
      }
      const html = PAGE.replaceAll('__TOKEN__', TOKEN)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      return res.end(html)
    }

    // Anything that is not the dashboard page or its API belongs to T3.
    if (!url.pathname.startsWith(API_PREFIX)) return proxy(req, res)

    if (req.method === 'GET' && url.pathname === '/_dash/status') {
      return json(res, 200, await status())
    }

    if (req.method === 'GET' && url.pathname === '/_dash/latest') {
      const [latest, installed] = await Promise.all([latestVersion(), installedVersion()])
      return json(res, 200, { latest, installed, upToDate: isUpToDate(installed, latest) })
    }

    if (req.method === 'GET' && url.pathname === '/_dash/changelog') {
      const [installed, latest] = await Promise.all([installedVersion(), latestVersion()])
      const from = url.searchParams.get('from') ?? installed
      const to = url.searchParams.get('to') ?? latest
      return json(res, 200, { from, to, releases: await changelog(from, to) })
    }

    if (req.method === 'GET' && url.pathname === '/_dash/fork') {
      const fork = await forkStatus()
      if (!fork) return json(res, 404, { error: 'source mode is not configured' })
      const active = activeJob && jobs.get(activeJob)?.state === 'running' ? activeJob : null
      return json(res, 200, { ...fork, commits: await incomingCommits(), active })
    }

    if (req.method === 'GET' && url.pathname === '/_dash/dev-runner') {
      return json(res, 200, devRunnerStatus())
    }

    if (req.method === 'POST' && url.pathname === '/_dash/dev-runner') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })
      const action = url.searchParams.get('action')
      try {
        if (action === 'start') return json(res, 200, startDevRunner())
        if (action === 'stop') return json(res, 200, stopDevRunner())
      } catch (err) {
        return json(res, 400, { error: err.message })
      }
      return json(res, 400, { error: `unknown action: ${action}` })
    }

    // This route does a fetch first. Thus the counts agree with the remote
    // now, and not with the last timer step. The route changes nothing: it
    // does no merge, no build, and no move.
    if (req.method === 'POST' && url.pathname === '/_dash/fork/refresh') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })
      await fetchRemotes()
      const fork = await forkStatus()
      if (!fork) return json(res, 404, { error: 'source mode is not configured' })
      const active = activeJob && jobs.get(activeJob)?.state === 'running' ? activeJob : null
      return json(res, 200, { ...fork, commits: await incomingCommits(), active })
    }

    if (req.method === 'POST' && url.pathname === '/_dash/job') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })
      try {
        const job = startJob(url.searchParams.get('name'))
        return json(res, 200, { id: job.id, name: job.name })
      } catch (err) {
        return json(res, err.conflict ? 409 : 400, { error: err.message })
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/_dash/job/')) {
      const job = jobs.get(url.pathname.slice('/_dash/job/'.length))
      if (!job) return json(res, 404, { error: 'no such job' })
      return json(res, 200, job)
    }

    if (req.method === 'POST' && url.pathname === '/_dash/action') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })

      if (!MANAGED) {
        return json(res, 409, { error: 'this instance is run by the dev server, not systemd' })
      }
      const action = url.searchParams.get('name')
      const fn = ACTIONS[action]
      if (!fn) return json(res, 400, { error: `unknown action: ${action}` })

      const output = await fn()
      return json(res, 200, { ok: true, action, output: output || '(no output)' })
    }

    if (req.method === 'POST' && url.pathname === '/_dash/pair') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })

      const label = (url.searchParams.get('label') ?? '').trim()
      const ttl = (url.searchParams.get('ttl') ?? '15m').trim()
      if (label.length > 80) return json(res, 400, { error: 'label is too long' })
      if (!/^\d+\s*(?:s|m|h|d|seconds?|minutes?|hours?|days?)$/i.test(ttl)) {
        return json(res, 400, { error: 'invalid TTL; use values such as 15m, 1h, or 2 days' })
      }

      const backend = await targetFor(req)
      if (!backend) return json(res, 503, { error: 'T3 Code is not running.' })

      const administrative = url.searchParams.get('administrative') === 'true'
      // An administrative link starts the systemd unit again and reads the
      // log of that unit. The dev runner has no unit and no log.
      if (administrative && backend.name !== 'deploy') {
        return json(res, 409, { error: 'administrative links apply to the deploy service only' })
      }
      const result = administrative
        ? await createAdministrativePairingLink()
        : await createPairingLink({ label, ttl, home: backend.home })
      return json(res, 200, result)
    }

    return json(res, 404, { error: 'not found' })
  } catch (err) {
    return json(res, 500, { error: err.message })
  }
})

// String.raw: the client script below contains regexes and '\n' escapes that a
// plain template literal would eat before the browser ever sees them.
const PAGE = String.raw`<!doctype html>
<meta charset="utf-8">
<title>t3code</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {
    color-scheme: dark;
    --bg:#0a0a0b;
    --panel:#0f0f11;
    --raised:#141417;
    --line:#232327;
    --line-soft:#1a1a1d;
    --text:#e9e9ec;
    --dim:#8b8b93;
    --faint:#63636b;
    --accent:#7dd3fc;
    --green:#34d399;
    --amber:#fbbf24;
    --red:#f87171;
    --violet:#c084fc;
    --mono: ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sidebar: 400px;
    --head: 44px;
  }
  * { box-sizing:border-box; }
  /* Author display rules below outrank the hidden attribute's UA style, and
     several of the toggled elements set one. Keep hidden authoritative. */
  [hidden] { display:none !important; }
  html, body { height:100%; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:13.5px/1.6 var(--mono);
    -webkit-font-smoothing:antialiased;
  }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  ::selection { background:#1e3a4a; }

  /* layout ---------------------------------------------------------------- */
  .app {
    display:grid; grid-template-columns:var(--sidebar) minmax(0,1fr);
    height:100dvh; transition:grid-template-columns .25s ease;
  }
  .app.collapsed { grid-template-columns:0 minmax(0,1fr); }
  .app.collapsed .side { opacity:0; pointer-events:none; }

  /* The sidebar does not scroll. The body below the header scrolls. Thus the
     scrollbar stays with the content that it moves, and it stops at the
     header. */
  .side {
    min-width:0; overflow:hidden;
    border-right:1px solid var(--line);
    background:var(--bg);
    display:flex; flex-direction:column;
    transition:opacity .2s ease;
  }
  /* Nothing here scrolls. Each section shows its data and keeps its position.
     The details of the fork are the only list with an unknown length. That
     list takes the remaining height, and it scrolls in itself. */
  .side-body {
    padding:0 0 1rem; display:flex; flex-direction:column;
    flex:1 1 auto; min-height:0;
    /* This is the alternative, and not the usual condition. Usually the
       sections fit, and the foldout takes the remaining height. This rule
       applies only to a window that is too short for the sections. */
    overflow-y:auto; overflow-x:hidden; scrollbar-gutter:stable;
    scrollbar-width:thin; scrollbar-color:#2c2c33 transparent;
  }
  .side-body::-webkit-scrollbar { width:10px; }
  .side-body::-webkit-scrollbar-track { background:transparent; }
  .side-body::-webkit-scrollbar-thumb {
    background:#2c2c33; border-radius:99px; border:3px solid var(--bg);
  }

  /* The scrollbar has space at the two sides, and you see only the thumb.
     Thus the scrollbar looks like a part of the panel. */
  .scrolls {
    overflow-y:auto; overflow-x:hidden; min-height:0;
    /* Keep the width of the scrollbar at all times. If you do not, the text
       moves to the left when you open a foldout. */
    scrollbar-gutter:stable;
    scrollbar-width:thin; scrollbar-color:#2c2c33 transparent;
  }
  .scrolls::-webkit-scrollbar { width:10px; }
  .scrolls::-webkit-scrollbar-track { background:transparent; }
  .scrolls::-webkit-scrollbar-thumb {
    background:#2c2c33; border-radius:99px; border:3px solid var(--bg);
  }
  .scrolls:hover::-webkit-scrollbar-thumb { background:#3a3a43; }

  .stage { min-width:0; display:flex; flex-direction:column; background:#08080a; }

  /* brand ----------------------------------------------------------------- */
  /* This bar has the same height as the console header. Thus the two headers
     make one line across the top of the page. */
  .brand {
    flex:none; height:var(--head); padding:0 1.1rem;
    border-bottom:1px solid var(--line);
    background:var(--bg);
    display:flex; align-items:center; gap:.55rem;
  }
  .mark { color:var(--accent); font-size:.78rem; font-weight:700; letter-spacing:-.02em; }
  .brand h1 {
    font-size:.78rem; font-weight:600; letter-spacing:.14em; margin:0;
    text-transform:uppercase; color:var(--dim);
  }

  /* sections -------------------------------------------------------------- */
  /* The sections are flat and use the full width. The sidebar is one column of
     content. Thus a thin line divides the sections, and no section has a
     box. */
  .card {
    padding:1.05rem 1.1rem; border-top:1px solid var(--line-soft);
  }
  .card:first-child { border-top:0; padding-top:.35rem; }
  .card > h2 {
    font-size:.66rem; font-weight:600; letter-spacing:.13em; text-transform:uppercase;
    color:var(--faint); margin:0 0 .75rem; display:flex; align-items:center; gap:.5rem;
  }
  .card > h2 .tag { margin-left:auto; text-transform:none; letter-spacing:0; color:var(--dim); font-weight:400; }
  /* This button is in the section heading. Thus it is smaller than a usual
     control. It has no border until you point at it. */
  .card > h2 button.icon.flat { width:20px; height:20px; font-size:.72rem; margin:-2px -4px -2px 0; }
  button.icon.flat[data-spin] { animation:spin .8s linear infinite; }

  .row { display:flex; justify-content:space-between; gap:1rem; padding:.12rem 0; font-size:.78rem; }
  .row dt { color:var(--dim); white-space:nowrap; }
  .row dd { margin:0; text-align:right; word-break:break-all; color:#d4d4d8; }
  dl { margin:0; }

  /* status ---------------------------------------------------------------- */
  .state {
    display:flex; align-items:center; gap:.55rem; padding:0 0 .55rem; min-height:30px;
  }
  .state .label { font-size:.82rem; letter-spacing:.01em; }
  .state .meta { font-size:.72rem; color:var(--faint); }
  .state .actions { margin-left:auto; flex:none; }
  .dot {
    display:inline-block; width:9px; height:9px; border-radius:50%; flex:none; background:#5a5a62;
    position:relative;
  }
  .dot.ok { background:var(--green); box-shadow:0 0 0 0 rgba(52,211,153,.45); animation:pulse 2.4s infinite; }
  .dot.bad { background:var(--red); box-shadow:0 0 8px rgba(248,113,113,.6); }
  .dot.warn { background:var(--amber); }
  @keyframes pulse {
    0% { box-shadow:0 0 0 0 rgba(52,211,153,.4); }
    70% { box-shadow:0 0 0 7px rgba(52,211,153,0); }
    100% { box-shadow:0 0 0 0 rgba(52,211,153,0); }
  }

  /* controls -------------------------------------------------------------- */
  .actions { display:flex; flex-wrap:wrap; gap:.45rem; }
  .actions.toolbar { gap:.25rem; flex-wrap:nowrap; }
  .actions.toolbar button { width:30px; height:30px; font-size:.85rem; border-color:#26262b; }
  button {
    flex:1 1 auto; min-width:104px; background:transparent; color:var(--dim);
    border:1px solid #26262b; border-radius:6px; padding:.45rem .8rem;
    font:inherit; font-size:.78rem; cursor:pointer;
    transition:background .12s ease, border-color .12s ease, color .12s ease, transform .06s ease;
  }
  button:hover:not(:disabled) { background:var(--raised); border-color:#3d3d44; color:var(--text); }
  button:active:not(:disabled) { transform:translateY(1px); }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  button:disabled { opacity:.35; cursor:default; }
  button.primary { background:#12242c; border-color:#2b4a5a; color:#bae6fd; }
  button.primary:hover:not(:disabled) { background:#173039; border-color:#3d6478; }
  button.danger:hover:not(:disabled) { border-color:#5c2a2a; color:var(--red); background:#1d1315; }
  button.icon {
    flex:0 0 auto; min-width:0; width:28px; height:28px; padding:0;
    display:grid; place-items:center; font-size:.8rem; border-color:transparent;
  }
  button.icon:hover:not(:disabled) { border-color:#26262b; }

  /* A count gets a chip only when the count is not zero. Thus the strip is
     empty when there is no work to do. */
  .chips { display:flex; flex-wrap:wrap; gap:.35rem; margin:0 0 .6rem; }
  .chips:empty { display:none; }
  .chip {
    font-size:.7rem; padding:.15rem .45rem; border-radius:5px;
    border:1px solid var(--line); color:var(--dim); background:var(--panel);
  }
  .chip b { font-weight:600; color:#d4d4d8; }
  .chip.warn { border-color:#4a3a12; color:var(--amber); background:#17130a; }
  .chip.warn b { color:var(--amber); }

  /* Each section keeps its natural height. The open foldout takes the
     remaining space. The body of the foldout scrolls, and not the section.
     Each element in this chain needs min-height:0. If an element does not have
     it, the flex item does not become smaller than its content, and the
     sidebar gets the overflow. */
  .card { flex:none; }
  /* The card gives the minimum height. Do not use min-height:auto here. The
     card is not a scroll container. Thus its automatic minimum is all of its
     content, which includes the full list of commits, and the foldout never
     gets a maximum height. With this value, the card becomes as small as the
     fixed rows and a list that you can read. The sidebar then scrolls. */
  #fork-card { display:flex; flex-direction:column; min-height:0; }
  #fork-card.expanded { flex:1 1 auto; min-height:21rem; }
  /* The overflow:hidden rule is a protection. If the chain becomes smaller
     than the minimum height of the card, the list is cut. It does not go
     across the section below it. */
  .more { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; margin-top:.75rem;
          position:relative; overflow:hidden; }
  /* This space keeps the values at the right away from the scrollbar. It also
     keeps the last row away from the bottom edge. */
  .more-body { flex:1 1 auto; min-height:0; padding:0 .7rem .6rem 0; }
  .more-body > * { margin-top:.5rem; }
  .more-body > *:first-child { margin-top:0; }
  /* A cut through a line of text looks like a fault. Thus the last rows become
     less bright. This shows that more content is below. The effect stops when
     you get to the end. */
  .more::after {
    content:''; position:absolute; left:0; right:.7rem; bottom:0; height:2rem;
    background:linear-gradient(180deg, rgba(10,10,11,0), var(--bg) 90%);
    pointer-events:none; transition:opacity .15s ease;
  }
  .more[data-at-end]::after { opacity:0; }


  .foldout {
    flex:none; align-self:flex-start; min-width:0; padding:.2rem 0;
    background:none; border:0; color:var(--faint); font-size:.7rem;
    letter-spacing:.09em; text-transform:uppercase; cursor:pointer;
    display:flex; align-items:center; gap:.35rem;
  }
  .foldout:hover:not(:disabled) { color:var(--dim); background:none; border:0; }
  .foldout::before { content:'▸'; font-size:.6rem; transition:transform .15s ease; }
  .foldout[aria-expanded="true"]::before { transform:rotate(90deg); }

  .muted { color:var(--faint); font-size:.73rem; line-height:1.55; }
  .note { font-size:.75rem; line-height:1.6; margin-top:.65rem; color:var(--dim); }
  .note .bad-text { color:var(--red); }
  .note .warn-text { color:var(--amber); }

  /* log ------------------------------------------------------------------- */
  .log-card { display:flex; flex-direction:column; flex:none; margin-top:auto; }
  .log-head {
    display:flex; align-items:center; gap:.5rem; margin:0 0 .5rem;
    font-size:.66rem; letter-spacing:.13em; text-transform:uppercase; color:var(--faint);
  }
  .log-head .job { text-transform:none; letter-spacing:0; color:var(--dim); margin-left:auto; }
  .log-line { display:flex; align-items:baseline; gap:.6rem; }
  pre#log {
    margin:0; flex:1 1 auto; min-width:0;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    color:#8e8e96; font-size:.73rem; line-height:1.55;
  }
  .linkish {
    flex:0 0 auto; min-width:0; padding:0; border:0; background:none;
    color:var(--dim); font-size:.7rem; text-decoration:underline;
    text-underline-offset:2px; cursor:pointer;
  }
  .linkish:hover { color:var(--accent); background:none; }

  /* modal ----------------------------------------------------------------- */
  dialog#log-modal {
    width:min(760px, 88vw); max-height:78vh; padding:0; color:var(--text);
    background:var(--panel); border:1px solid var(--line); border-radius:12px;
    box-shadow:0 24px 60px -20px #000;
    display:none; flex-direction:column;
  }
  dialog#log-modal[open] { display:flex; }
  dialog#log-modal::backdrop { background:rgba(0,0,0,.6); }
  .modal-head {
    display:flex; align-items:center; gap:.5rem; flex:none;
    padding:.7rem .9rem; border-bottom:1px solid var(--line-soft);
    font-size:.66rem; letter-spacing:.13em; text-transform:uppercase; color:var(--faint);
  }
  .modal-head .job { text-transform:none; letter-spacing:0; color:var(--dim); }
  .modal-head button { margin-left:auto; }
  pre#log-full {
    margin:0; padding:.85rem .9rem; flex:1 1 auto;
    white-space:pre-wrap; word-break:break-word;
    color:#9d9da5; font-size:.74rem; line-height:1.55;
  }

  /* release notes / commits ------------------------------------------------ */
  #notes { margin-top:.8rem; border-top:1px solid var(--line-soft); padding-top:.3rem;
           max-height:24rem; overflow:auto; }
  .rel { padding:.65rem 0; border-bottom:1px solid var(--line-soft); }
  .rel:last-child { border-bottom:0; }
  .rel h3 { font-size:.78rem; margin:0 0 .1rem; font-weight:600; color:#dcdce0; }
  .rel time { color:var(--faint); font-size:.7rem; }
  .rel ul { margin:.4rem 0 0; padding-left:1.05rem; }
  .rel li { color:#a9a9b1; margin:.18rem 0; font-size:.75rem; }
  .rel .sub { color:var(--faint); margin:.55rem 0 .1rem; font-size:.68rem;
              text-transform:uppercase; letter-spacing:.09em; }
  .scope { color:var(--violet); }

  /* stage / iframe --------------------------------------------------------- */
  /* The frame is always this origin's root and the console is one click from
     the sidebar, so the header carries no address and no popout -- only the
     two controls that act on the frame itself. */
  .bar {
    display:flex; align-items:center; gap:.55rem; height:var(--head); padding:0 .55rem 0 .35rem;
    border-bottom:1px solid var(--line); background:var(--bg); flex:none;
  }
  .bar .title {
    font-size:.72rem; letter-spacing:.13em; text-transform:uppercase; color:var(--faint);
    min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .bar .spacer { flex:1 1 auto; }
  .tabs { display:flex; gap:.15rem; margin-left:.35rem; }
  .tab {
    flex:0 0 auto; min-width:0; padding:.25rem .6rem; font-size:.7rem;
    letter-spacing:.06em; text-transform:uppercase; border-radius:6px;
    background:none; border:1px solid transparent; color:var(--faint);
  }
  .tab:hover:not(:disabled) { color:var(--dim); background:var(--raised); border-color:transparent; }
  .tab[aria-selected="true"] { color:var(--accent); background:#12242c; border-color:#2b4a5a; }
  .frame-wrap { position:relative; flex:1 1 auto; min-height:0; }
  iframe#frame { width:100%; height:100%; border:0; background:#0a0a0b; display:block; }
  .placeholder {
    position:absolute; inset:0; display:grid; place-content:center; justify-items:center;
    gap:.9rem; text-align:center; padding:2rem; background:#08080a;
  }
  .placeholder h2 { font-size:.9rem; font-weight:600; margin:0; }
  .placeholder p { margin:0; max-width:34rem; }
  .placeholder .actions { justify-content:center; }
  .spinner {
    width:22px; height:22px; border-radius:50%; border:2px solid #26262c;
    border-top-color:var(--accent); animation:spin .8s linear infinite;
  }
  @keyframes spin { to { transform:rotate(360deg); } }

  @media (max-width: 900px) {
    .app, .app.collapsed { grid-template-columns:1fr; grid-template-rows:auto 70vh; height:auto; }
    .side { border-right:0; border-bottom:1px solid var(--line); opacity:1 !important; pointer-events:auto !important; }
    .stage { height:70vh; }
    #collapse { display:none; }
  }
</style>

<div class="app" id="app">
  <aside class="side">
    <div class="brand">
      <span class="mark">T3</span>
      <h1>service control</h1>
    </div>

    <div class="side-body">
      <section class="card">
        <!-- The controls ride on the status line they act on, rather than
             claiming a row of their own below the readout. -->
        <div class="state">
          <span class="dot" id="state-dot"></span>
          <span class="label" id="state-label">loading…</span>
          <span class="meta" id="state-meta"></span>
          <div class="actions toolbar">
            <button data-action="start" class="icon" title="Start" aria-label="Start">▶</button>
            <button data-action="restart" class="icon" title="Restart" aria-label="Restart">⟳</button>
            <button data-action="stop" class="icon danger" title="Stop" aria-label="Stop">■</button>
          </div>
        </div>
        <dl id="status"></dl>
      </section>

      <!-- Hidden in source mode: the npm release line says nothing about a
           build that comes from the fork. The fork section reports that one. -->
      <section class="card" id="version-card">
        <h2>version <span class="tag" id="version">—</span></h2>
        <div class="actions">
          <button id="changelog">What's changed</button>
          <button id="update">Update &amp; restart</button>
        </div>
        <div id="notes" hidden></div>
      </section>

      <!-- What is true now, then the one action for it. Everything a decision
           does not need sits behind Details. -->
      <section class="card" id="fork-card" hidden>
        <h2>fork
          <span class="tag" id="fork-branch">—</span>
          <button id="fork-refresh" class="icon flat" title="Check for new upstream changes"
            aria-label="Check for new upstream changes">⟳</button>
        </h2>
        <div class="chips" id="fork-chips"></div>
        <div id="fork-note" class="note"></div>
        <div class="actions" style="margin-top:.7rem">
          <button id="fork-deploy" class="primary">Sync, build &amp; deploy</button>
        </div>
        <!-- Not a <details>: that element slots its content into a UA shadow
             tree, so the body is not a flex child of it and cannot be given
             the leftover height to scroll in. A plain button and div can. -->
        <div class="more">
          <button id="fork-details" class="foldout" aria-expanded="false"
            aria-controls="fork-details-body">Details</button>
          <!-- Only the upstream detail folds away: it is the one open-ended
               list. Dev and the build are short and always worth seeing. -->
          <div class="more-body scrolls" id="fork-details-body" hidden>
            <dl id="fork-upstream-status"></dl>
            <div id="fork-commits" hidden></div>
          </div>
        </div>
      </section>

      <section class="card" id="dev-card" hidden>
        <h2>dev <span class="tag" id="dev-runner-state">stopped</span></h2>
        <dl id="fork-dev-status"></dl>
        <div id="fork-dev-note" class="note"></div>
        <div class="actions" style="margin-top:.7rem">
          <button id="dev-runner-toggle">Start dev server</button>
          <button id="fork-promote">Promote to deploy</button>
        </div>
        <div id="dev-runner-note" class="muted" style="margin-top:.55rem"></div>
      </section>

      <section class="card" id="build-card" hidden>
        <h2>build</h2>
        <dl id="fork-build-status"></dl>
        <div class="actions" style="margin-top:.7rem">
          <button id="fork-rebuild">Rebuild</button>
        </div>
      </section>

      <!-- One line of it: the latest line is the status, and the rest is only
           wanted when something has gone wrong. -->
      <section class="card log-card">
        <div class="log-head">activity <span class="job" id="log-job"></span></div>
        <div class="log-line">
          <pre id="log">ready</pre>
          <button id="log-more" class="linkish" hidden>Show more</button>
        </div>
      </section>
    </div>
  </aside>

  <dialog id="log-modal">
    <div class="modal-head">
      <span>activity</span>
      <span class="job" id="log-modal-job"></span>
      <button id="log-close" class="icon" title="Close" aria-label="Close">✕</button>
    </div>
    <pre id="log-full" class="scrolls"></pre>
  </dialog>

  <main class="stage">
    <div class="bar">
      <button id="collapse" class="icon" title="Toggle sidebar" aria-label="Toggle sidebar">☰</button>
      <span class="title">T3 Code</span>
      <!-- These tabs show only while the dev runner operates. With one backend
           there is no second target, and one tab gives no data. -->
      <div class="tabs" id="frame-tabs" role="tablist" hidden>
        <button class="tab" data-target="deploy" role="tab" aria-selected="true">deploy</button>
        <button class="tab" data-target="dev" role="tab" aria-selected="false">dev</button>
      </div>
      <span class="spacer"></span>
      <button id="frame-reload" class="icon" title="Reload" aria-label="Reload">⟳</button>
    </div>
    <div class="frame-wrap">
      <iframe id="frame" title="T3 Code" hidden
        allow="clipboard-read; clipboard-write; fullscreen"></iframe>
      <div class="placeholder" id="frame-placeholder">
        <div class="spinner" id="frame-spinner"></div>
        <h2 id="frame-title">waiting for T3 Code…</h2>
        <p class="muted" id="frame-hint">Looking for the Tailscale Serve URL for this service.</p>
        <div class="actions" id="frame-actions" hidden>
          <button id="frame-retry" class="primary">Retry</button>
          <button id="frame-open-2">Open in a new tab</button>
        </div>
      </div>
    </div>
  </main>
</div>

<script>
const TOKEN = '__TOKEN__'
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
// The sidebar carries the newest line; the whole of it lives in the modal.
let logText = 'ready'

function log(msg) {
  logText = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)
  const lines = logText.split('\n').filter((line) => line.trim())
  $('log').textContent = lines[lines.length - 1] ?? 'ready'
  $('log').title = lines[lines.length - 1] ?? ''
  $('log-more').hidden = lines.length < 2
  if ($('log-modal').open) renderLogModal()
}

// Follows the tail while a job runs, unless you have scrolled up to read.
function renderLogModal() {
  const box = $('log-full')
  const pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 40
  box.textContent = logText
  $('log-modal-job').textContent = $('log-job').textContent
  if (pinned) box.scrollTop = box.scrollHeight
}

function dotClass(active) {
  if (active === 'active') return 'ok'
  if (active === 'failed') return 'bad'
  return 'warn'
}

// "Wed 2026-08-05 16:00:00 PDT" -> "2h 14m", so uptime reads at a glance.
function uptime(stamp) {
  const parsed = Date.parse((stamp || '').replace(/^\w{3} /, ''))
  if (!parsed) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000))
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) return 'up ' + days + 'd ' + hours + 'h'
  if (hours) return 'up ' + hours + 'h ' + minutes + 'm'
  return 'up ' + minutes + 'm'
}

async function refresh() {
  const s = await (await fetch('/_dash/status')).json()
  // Serve publishes the dashboard; T3 itself is the tailnet address it binds to.
  const action = (name) => document.querySelector('[data-action="' + name + '"]')

  managed = s.managed !== false
  if (!managed) {
    for (const b of document.querySelectorAll('[data-action]')) b.disabled = true
    $('update').disabled = true
    $('update').textContent = 'Managed by dev server'
  } else {
    // Starting a running service and stopping a stopped one are both no-ops
    // that come back as an error, so neither is offered. Restart stays live:
    // on a stopped unit it is simply a start.
    const running = s.active === 'active'
    action('start').disabled = running
    action('stop').disabled = !running
    action('restart').disabled = false
  }

  $('state-dot').className = 'dot ' + dotClass(s.active)
  $('state-label').textContent = s.active + (s.sub && s.sub !== s.active ? ' · ' + s.sub : '')
  $('state-meta').textContent = s.active === 'active' ? uptime(s.startedAt) : s.enabled

  $('status').innerHTML = [
    ['unit', esc(s.unit)],
    ['enabled', esc(s.enabled)],
    ['pid', s.pid ?? '—'],
    ['restarts', esc(s.restarts)],
    // The dashboard's own URL is the address of the page you are reading it on.
    ['t3code', s.origin ? esc(s.origin) : '<span class="muted">not running</span>'],
  ].map(([k, v]) => '<div class="row"><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('')

  installed = s.installed
  renderVersion()
}

// ---------------------------------------------------------------------------
// embedded T3 Code
// ---------------------------------------------------------------------------

// T3 is proxied under this origin, so the frame is same-origin: /ws answers
// 401 until this browser holds a session, which is a precise "are we paired?"
// signal that no cross-origin embed could give us.
let pairing = false

function showPlaceholder(title, hint, showActions) {
  $('frame').hidden = true
  $('frame-placeholder').hidden = false
  $('frame-spinner').hidden = Boolean(showActions)
  $('frame-title').textContent = title
  $('frame-hint').textContent = hint
  $('frame-actions').hidden = !showActions
}

function showFrame() {
  $('frame').hidden = false
  $('frame-placeholder').hidden = true
}

// A plain GET on the socket endpoint answers auth_invalid (401) without a
// session, and 400 "not an upgrade" once the credential is accepted -- so the
// error payload, not the status, is the reliable signal.
async function isPaired() {
  try {
    const res = await fetch('/ws', { cache: 'no-store' })
    if (res.status === 401) return false
    if (res.ok) return true
    const body = await res.json().catch(() => null)
    return body?.code !== 'auth_invalid'
  } catch {
    return false
  }
}

// Mint a link and consume it in the frame. The token lives in the fragment, so
// it is re-pointed at this origin rather than the Tailscale Serve one: that way
// the cookie is set first-party and the embedded console can use it.
async function pairFrame() {
  if (pairing) return
  pairing = true
  showPlaceholder('pairing this browser…', 'Creating a short-lived link and completing it in place.', false)
  try {
    const params = new URLSearchParams({ label: 'dashboard embed', ttl: '15m' })
    const res = await fetch('/_dash/pair?' + params, { method: 'POST', headers: { 'x-token': TOKEN } })
    const result = await res.json()
    if (!res.ok) throw new Error(result.error ?? 'pairing failed')

    const local = new URL('/pair', location.origin)
    local.hash = new URL(result.pairingUrl).hash
    await new Promise((resolve) => {
      $('frame').addEventListener('load', resolve, { once: true })
      $('frame').src = local.toString()
    })
    // The pair page exchanges the token after it loads; wait for the session.
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 500))
      if (await isPaired()) {
        log('paired this browser with T3 Code')
        return loadFrame()
      }
    }
    showPlaceholder('pairing did not complete', 'The link was created but no session appeared. Open T3 Code in its own tab and pair there.', true)
  } catch (err) {
    showPlaceholder('could not pair', err.message, true)
  } finally {
    pairing = false
  }
}

async function loadFrame() {
  if (!(await isPaired())) return pairFrame()
  showPlaceholder('loading T3 Code…', location.origin, false)
  $('frame').addEventListener('load', showFrame, { once: true })
  $('frame').src = '/?embed=1'
}

// ?embed=1 makes the root serve the console rather than this page. Only the
// placeholder offers this now: it is the recovery path when the frame will not
// load. It is not a control for a frame that operates correctly.
$('frame-open-2').onclick = () => window.open('/?embed=1', '_blank')
$('frame-retry').onclick = loadFrame
$('frame-reload').onclick = loadFrame

$('collapse').onclick = () => {
  const collapsed = $('app').classList.toggle('collapsed')
  try { localStorage.setItem('t3code-sidebar', collapsed ? 'collapsed' : 'open') } catch {}
}
try {
  if (localStorage.getItem('t3code-sidebar') === 'collapsed') $('app').classList.add('collapsed')
} catch {}

let installed = null, latest = null, upToDate = null, managed = true

function renderVersion() {
  if (!installed) return
  if (!latest) { $('version').textContent = installed; return }
  const current = upToDate ?? latest === installed
  $('version').innerHTML = current
    ? esc(installed) + ' <span style="color:var(--faint)">(latest)</span>'
    : esc(installed) + ' <span style="color:var(--amber)">&rarr; ' + esc(latest) + '</span>'
  // Source mode owns the installed binary; the npm button stays out of it.
  if (forkMode) return
  $('update').disabled = current
  $('update').textContent = current ? 'Up to date' : 'Update & restart'
}

async function checkUpdates() {
  try {
    const r = await (await fetch('/_dash/latest')).json()
    installed = r.installed
    latest = r.latest
    upToDate = r.upToDate
    renderVersion()
  } catch {
    // offline or npm unreachable -- keep showing the installed version
  }
}

// You make pairing links on the Connections screen of T3 Code, in the frame.
// The /_dash/pair route stays, because pairFrame() above uses it to pair this
// browser.
async function act(name, btn) {
  const buttons = [...document.querySelectorAll('.side-body button')]
  buttons.forEach((b) => (b.disabled = true))
  const label = btn.textContent
  btn.textContent = '…'
  try {
    const res = await fetch('/_dash/action?name=' + name, { method: 'POST', headers: { 'x-token': TOKEN } })
    log(await res.json())
  } catch (err) {
    log('failed: ' + err.message)
  } finally {
    btn.textContent = label
    buttons.forEach((b) => (b.disabled = false))
    refresh()
    if (name === 'update') checkUpdates()
  }
}

for (const btn of document.querySelectorAll('[data-action]')) {
  btn.onclick = () => act(btn.dataset.action, btn)
}

$('update').onclick = (e) => act('update', e.target)

// The <dialog> element supplies the Esc key and the background. The click
// handler closes the dialog when you click the background, because the browser
// gives the dialog as the target.
// The dialog opens at the newest line. The sidebar shows that same line.
$('log-more').onclick = () => {
  renderLogModal()
  $('log-modal').showModal()
  $('log-full').scrollTop = $('log-full').scrollHeight
}
$('log-close').onclick = () => $('log-modal').close()
$('log-modal').onclick = (e) => { if (e.target === $('log-modal')) $('log-modal').close() }

// The release bodies are generated notes: '## Heading' plus '* item by @who in <url>'.
// Render just that shape rather than pulling in a markdown parser.
function renderBody(body) {
  let html = '', list = []
  const flush = () => { if (list.length) { html += '<ul>' + list.join('') + '</ul>'; list = [] } }

  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      if (!/what's changed/i.test(heading[1])) html += '<p class="sub">' + esc(heading[1]) + '</p>'
      continue
    }
    const item = /^[*-]\s+(.*)$/.exec(line)
    if (item) {
      let text = item[1].replace(/\s*by @[\w-]+ in (\S+)/, (_, url) => ' <a href="' + esc(url) + '">#' + (url.split('/').pop()) + '</a>')
      text = text.replace(/^(\w+(?:\([^)]+\))?):/, '<span class="scope">$1</span>:')
      list.push('<li>' + text + '</li>')
      continue
    }
    if (/^\*\*Full Changelog\*\*/.test(line)) continue
    flush()
    html += '<p class="sub">' + esc(line.replace(/\*\*/g, '')) + '</p>'
  }
  flush()
  return html || '<p class="sub">no notes</p>'
}

$('changelog').onclick = async (e) => {
  const btn = e.target, label = btn.textContent, box = $('notes')
  if (!box.hidden) { box.hidden = true; return }
  btn.disabled = true; btn.textContent = 'loading…'
  try {
    const r = await (await fetch('/_dash/changelog')).json()
    box.innerHTML = r.releases.length
      ? r.releases.reverse().map((rel) =>
          '<div class="rel"><h3>' + esc(rel.version) + '</h3>' +
          '<time>' + new Date(rel.published).toLocaleString() + '</time>' +
          renderBody(rel.body) + '</div>').join('')
      : '<div class="rel"><p class="sub">nothing between ' + esc(r.from) + ' and ' + esc(r.to) + '</p></div>'
    box.hidden = false
    log(r.releases.length + ' release(s) between ' + r.from + ' and ' + r.to)
  } catch (err) {
    log('changelog failed: ' + err.message)
  } finally {
    btn.disabled = false; btn.textContent = label
  }
}

let forkMode = false, polling = null

// Use the counts that are not zero. Thus the strip shows the necessary work,
// and it does not show a correct state six times.
function forkChips(f) {
  const chips = []
  const add = (label, value, warn) =>
    chips.push('<span class="chip' + (warn ? ' warn' : '') + '"><b>' + esc(String(value)) +
      '</b> ' + esc(label) + '</span>')

  if (f.mainBehind > 0) add('upstream', f.mainBehind)
  if (f.deployBehind > 0) add('behind main', f.deployBehind)
  if (f.dev.ahead > 0) add('dev ahead', f.dev.ahead)
  if (f.dirty) chips.push('<span class="chip warn">worktree dirty</span>')
  if (f.dev.dirty) chips.push('<span class="chip warn">dev dirty</span>')
  if (f.needsRebuild) chips.push('<span class="chip warn">build stale</span>')
  return chips.join('')
}

function renderFork(f) {
  $('fork-card').hidden = false
  $('dev-card').hidden = false
  $('build-card').hidden = false
  // The npm version line shows a release that this build does not come from.
  // Also, the update replaces the build of the fork. Thus remove the
  // section.
  $('version-card').hidden = true
  forkMode = true

  $('fork-branch').textContent = f.branch + ' @ ' + (f.tip ?? '—')
  $('fork-chips').innerHTML = forkChips(f)
  const flag = (text) => ' <span style="color:var(--amber)">(' + text + ')</span>'
  const rows = (items) => items
    .map(([k, v]) => '<div class="row"><dt>' + esc(k) + '</dt><dd>' + v + '</dd></div>').join('')

  $('fork-upstream-status').innerHTML = rows([
    ['main behind upstream', String(f.mainBehind)],
    [f.branch + ' behind main', String(f.deployBehind)],
  ])
  $('fork-dev-status').innerHTML = rows([
    ['ahead / behind ' + f.branch, String(f.dev.ahead) + ' / ' + String(f.dev.behind)],
    ['worktree', esc((f.dev.repo || '—').split('/').pop()) + (f.dev.dirty ? flag('dirty') : '')],
  ])
  $('fork-build-status').innerHTML = rows([
    ['checked out', esc(f.checkedOut ?? '—') + (f.dirty ? flag('dirty') : '')],
    ['built', f.built ? esc(f.built) + (f.needsRebuild ? flag('stale') : '') : '—'],
  ])

  const pending = f.mainBehind > 0 || f.deployBehind > 0
  const blocked = f.dirty || !f.clean || !managed
  $('fork-deploy').disabled = blocked || !pending || Boolean(f.active)
  $('fork-promote').disabled = !managed || f.dirty || f.dev.dirty || !f.dev.clean || f.dev.ahead === 0 || Boolean(f.active)
  $('fork-rebuild').disabled = !managed || f.dirty || Boolean(f.active)

  $('fork-note').innerHTML = f.dirty
    ? 'Worktree has uncommitted changes. Resolve them in ' + esc(f.repo) + ' first.'
    : !f.clean
      ? '<span class="bad-text">Conflicts — merge by hand:</span> ' + esc(f.conflicts.join(', '))
      : pending
        ? f.mainBehind + ' upstream commit(s) ready to merge and deploy.'
        : f.needsRebuild
          ? 'Up to date with upstream, but the deployed build is older than the branch tip.'
          : 'Up to date with upstream.'

  $('fork-dev-note').innerHTML = f.dev.dirty
    ? 'Development changes are safe in ' + esc(f.dev.repo) + '. Commit them before merging into ' + esc(f.branch) + '.'
    : !f.dev.clean
      ? '<span class="bad-text">Dev merge conflicts — resolve in the dev worktree:</span> ' + esc(f.dev.conflicts.join(', '))
      : f.dev.ahead > 0
        ? f.dev.ahead + ' committed dev change(s) ready to promote.'
        : 'Nothing to promote; dev matches ' + esc(f.branch) + '.'

  const box = $('fork-commits')
  box.innerHTML = f.commits.length
    ? '<div class="rel"><p class="sub">incoming</p><ul>' +
      f.commits.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul></div>'
    : ''
  box.hidden = !f.commits.length
  // New commits change the quantity of content. Thus calculate the effect
  // again.
  markScrollEnd()
}

// When you open the foldout, it takes the remaining height of the sidebar.
// Thus the body of the foldout scrolls, and no other element scrolls.
$('fork-details').onclick = () => {
  const body = $('fork-details-body')
  const expanded = body.hidden
  body.hidden = !expanded
  $('fork-details').setAttribute('aria-expanded', String(expanded))
  $('fork-card').classList.toggle('expanded', expanded)
  markScrollEnd()
}

// This function controls the effect at the bottom. The effect applies only
// while more content is below.
function markScrollEnd() {
  const body = $('fork-details-body')
  const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 4
  body.parentElement.toggleAttribute('data-at-end', atEnd)
}
$('fork-details-body').addEventListener('scroll', markScrollEnd)
addEventListener('resize', markScrollEnd)

// This button does a fetch from the remotes, and then reads the status again.
// The periodic refresh does not do the fetch.
$('fork-refresh').onclick = async (e) => {
  const btn = e.currentTarget
  btn.disabled = true
  btn.setAttribute('data-spin', '')
  try {
    const res = await fetch('/_dash/fork/refresh', { method: 'POST', headers: { 'x-token': TOKEN } })
    const f = await res.json()
    if (!res.ok) throw new Error(f.error ?? 'refresh failed')
    renderFork(f)
    log('checked the remotes for new changes')
  } catch (err) {
    log('refresh failed: ' + err.message)
  } finally {
    btn.disabled = false
    btn.removeAttribute('data-spin')
  }
}

async function refreshFork() {
  try {
    const r = await fetch('/_dash/fork')
    if (!r.ok) return
    const f = await r.json()
    renderFork(f)
    // Re-attach after a page reload so a running build is never orphaned.
    if (f.active && !polling) pollJob(f.active)
  } catch {
    // dashboard stays useful even if the repo is temporarily unreadable
  }
}

function pollJob(id) {
  clearInterval(polling)
  polling = setInterval(async () => {
    try {
      const job = await (await fetch('/_dash/job/' + id)).json()
      $('log-job').textContent = job.name + ' · ' + job.state + ' · ' + job.step
      log(job.output)
      if (job.state !== 'running') {
        clearInterval(polling)
        polling = null
        refresh()
        refreshFork()
      }
    } catch {
      clearInterval(polling)
      polling = null
    }
  }, 1000)
}

async function startJob(name) {
  $('fork-deploy').disabled = true
  $('fork-promote').disabled = true
  $('fork-rebuild').disabled = true
  try {
    const res = await fetch('/_dash/job?name=' + name, { method: 'POST', headers: { 'x-token': TOKEN } })
    const r = await res.json()
    if (!res.ok) throw new Error(r.error ?? 'could not start')
    pollJob(r.id)
  } catch (err) {
    log('failed: ' + err.message)
    refreshFork()
  }
}

$('fork-deploy').onclick = () => {
  if (confirm('Merge upstream into deploy and deploy into dev, rebuild, and restart the service?')) {
    startJob('sync-build-deploy')
  }
}
$('fork-rebuild').onclick = () => {
  if (confirm('Rebuild from the current branch and restart the service?')) startJob('rebuild')
}
$('fork-promote').onclick = () => {
  if (confirm('Promote dev to deploy, rebuild, and restart the service?')) {
    startJob('promote-dev')
  }
}

// ---------------------------------------------------------------------------
// dev runner and the console tabs
// ---------------------------------------------------------------------------

// This function gives the backend that this browser shows. A cookie on this
// address holds the choice. Thus each request from the console in the frame
// carries the choice, and no other client on the tailnet changes.
function frameTarget() {
  const match = /(?:^|;\s*)t3code_target=([^;]*)/.exec(document.cookie)
  return match?.[1] === 'dev' ? 'dev' : 'deploy'
}

function setFrameTarget(name) {
  document.cookie = 't3code_target=' + name + '; path=/; SameSite=Lax; max-age=' + 60 * 60 * 24 * 30
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.target === name))
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    if (frameTarget() === tab.dataset.target) return
    setFrameTarget(tab.dataset.target)
    // Each backend has different credentials. Thus load the frame again
    // through the pairing steps. Do not change the src of a console that
    // operates.
    loadFrame()
  }
}

let devRunnerState = 'stopped'

function renderDevRunner(r) {
  devRunnerState = r.state
  const running = r.state === 'running'
  const busy = r.state === 'starting' || r.state === 'stopping'

  $('dev-runner-state').textContent = r.configured ? r.state : 'no worktree'
  $('dev-runner-toggle').disabled = !r.configured || busy
  $('dev-runner-toggle').textContent = r.state === 'starting' ? 'starting…'
    : r.state === 'stopping' ? 'stopping…'
    : running ? 'Stop dev server' : 'Start dev server'

  // A tab for a backend that does not operate gives an HTTP 503 in the
  // frame.
  $('frame-tabs').hidden = !running
  if (!running && frameTarget() === 'dev') {
    setFrameTarget('deploy')
    loadFrame()
  }

  $('dev-runner-note').textContent = !r.configured
    ? 'No development worktree is configured for this instance.'
    : r.error ? r.error
    : running ? 'Serving ' + r.branch + ' from source with hot reload. Switch with the tabs above the console.'
    : busy ? 'Starting the fork dev server; the first build takes a moment.'
    : 'Runs the ' + r.branch + ' worktree from source, alongside the deployed build.'
}

async function refreshDevRunner() {
  try {
    renderDevRunner(await (await fetch('/_dash/dev-runner')).json())
  } catch {
    // Keep the last known state on the screen.
  }
}

$('dev-runner-toggle').onclick = async (e) => {
  const btn = e.currentTarget
  const action = devRunnerState === 'running' ? 'stop' : 'start'
  btn.disabled = true
  try {
    const res = await fetch('/_dash/dev-runner?action=' + action, {
      method: 'POST', headers: { 'x-token': TOKEN },
    })
    const r = await res.json()
    if (!res.ok) throw new Error(r.error ?? 'could not ' + action)
    renderDevRunner(r)
    log('dev server: ' + action)
    // Both transitions take seconds. Poll until the state settles.
    for (let attempt = 0; attempt < 60; attempt++) {
      if (devRunnerState !== 'starting' && devRunnerState !== 'stopping') break
      await new Promise((settle) => setTimeout(settle, 1000))
      await refreshDevRunner()
    }
  } catch (err) {
    log('dev server failed: ' + err.message)
  } finally {
    btn.disabled = false
  }
}

setFrameTarget(frameTarget())
refresh()
checkUpdates()
refreshFork()
refreshDevRunner()
loadFrame()
setInterval(refreshFork, 30000)
setInterval(refreshDevRunner, 10000)
setInterval(refresh, 5000)
// npm registry lookup is slower and far less volatile than local service state
setInterval(checkUpdates, 15 * 60 * 1000)
</script>`

// Keep the remote-tracking refs warm so the behind-counts mean something
// without every page load paying for a network round trip.
if (REPO) {
  fetchRemotes()
  setInterval(fetchRemotes, 15 * 60 * 1000).unref()
}

server.on('upgrade', (req, socket, head) => {
  proxyUpgrade(req, socket, head).catch(() => socket.destroy())
})

server.listen(PORT, HOST, () => {
  console.log(`t3code dashboard on http://${HOST}:${PORT}/`)
  if (REPO) console.log(`source mode: ${REPO} (${BRANCH})`)
})
