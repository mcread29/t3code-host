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
// A second listener that always proxies the dev runner, so the dev console
// has an origin of its own and can be mounted beside the deploy console.
const DEV_CONSOLE_PORT = Number(process.env.T3CODE_DEV_CONSOLE_PORT ?? PORT + 1)
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
const DEPLOYED_SHA_PATH = `${STATE_DIR}/deployed-sha`
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

async function deployedSha() {
  try {
    return (await readFile(DEPLOYED_SHA_PATH, 'utf8')).trim() || null
  } catch {
    return null
  }
}

async function forkStatus() {
  if (!REPO) return null

  const [branch, head, dirty, mainBehind, deployBehind, built, deployed, devHead, devDirty, devAhead, devBehind] = await Promise.all([
    gitOrNull('rev-parse', '--abbrev-ref', 'HEAD'),
    gitOrNull('rev-parse', '--short', 'HEAD'),
    gitOrNull('status', '--porcelain'),
    gitOrNull('rev-list', '--count', 'main..upstream/main'),
    gitOrNull('rev-list', '--count', `${BRANCH}..main`),
    builtSha(),
    deployedSha(),
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

  // Whether a build exists to deploy. The recorded revision is not the test: a
  // worktree can hold correct assets and no record, and a deploy of those
  // assets is correct.
  const hasBuild = (await Promise.all(BUILD_ASSETS.map((asset) =>
    readFile(`${REPO}/apps/server/${asset}`).then(() => true).catch(() => false),
  ))).every(Boolean)

  const [tip, worktrees] = await Promise.all([
    gitOrNull('rev-parse', '--short', BRANCH),
    worktreeStatus(),
  ])
  const conflicts = [...new Set([...syncPreview.conflicts, ...deployPreview.conflicts, ...devPreview.conflicts])]

  return {
    repo: REPO,
    branch: BRANCH,
    checkedOut: branch,
    head,
    tip,
    built,
    deployed,
    hasBuild,
    needsRebuild: Boolean(tip && (tip !== built || !hasBuild)),
    needsDeploy: Boolean(hasBuild && built && built !== deployed),
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
    worktrees,
  }
}

// ---------------------------------------------------------------------------
// the dashboard's own source
// ---------------------------------------------------------------------------

// The host repo this dashboard is built from. The installed dashboard is a
// copy of src/t3code-dashboard.mjs, so it can watch its own repo and replace
// itself without touching T3 Code.
const HOST_REPO = process.env.T3CODE_HOST_REPO ?? ''
const DASH_UNIT = process.env.T3CODE_DASH_UNIT ?? ''
const INSTANCE = process.env.T3CODE_INSTANCE ?? 'production'

async function gitHostOrNull(...args) {
  try {
    const { stdout } = await run('git', ['-C', HOST_REPO, ...args], {
      timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    })
    return stdout.trim()
  } catch {
    return null
  }
}

// New commits are not the only way to be stale: the installed dashboard is a
// copy, so the repo can be ahead of the running file with no commits pending.
// Equal files also mean an update would change nothing.
async function selfCopyCurrent() {
  try {
    const [running, source] = await Promise.all([
      readFile(process.argv[1], 'utf8'),
      readFile(`${HOST_REPO}/src/t3code-dashboard.mjs`, 'utf8'),
    ])
    return running === source
  } catch {
    return null
  }
}

async function selfStatus() {
  if (!HOST_REPO) return null
  const [branch, head, dirty, behind, log, copyCurrent] = await Promise.all([
    gitHostOrNull('rev-parse', '--abbrev-ref', 'HEAD'),
    gitHostOrNull('rev-parse', '--short', 'HEAD'),
    gitHostOrNull('status', '--porcelain'),
    gitHostOrNull('rev-list', '--count', 'HEAD..@{upstream}'),
    gitHostOrNull('log', '--oneline', '--no-decorate', '-30', 'HEAD..@{upstream}'),
    selfCopyCurrent(),
  ])
  return {
    repo: HOST_REPO, branch, head,
    dirty: Boolean(dirty),
    behind: Number(behind ?? 0),
    commits: log ? log.split('\n').filter(Boolean) : [],
    copyCurrent,
    managed: Boolean(DASH_UNIT),
    active: activeJob && jobs.get(activeJob)?.state === 'running' ? activeJob : null,
  }
}

// The linked worktrees of the fork, feature worktrees included. The deploy
// checkout itself is not listed: it is the release, served by the installed
// build, and never by the dev runner.
async function listWorktrees() {
  const out = await gitOrNull('worktree', 'list', '--porcelain')
  if (!out) return []
  const items = []
  let current = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) }
      items.push(current)
    } else if (line.startsWith('branch refs/heads/') && current) {
      current.branch = line.slice('branch refs/heads/'.length)
    } else if (line === 'detached' && current) {
      current.detached = true
    }
  }
  return items.filter((w) => w.path !== REPO && w.branch && w.branch !== BRANCH && !w.detached)
}

// Per-worktree state for the sidebar: what the branch adds over deploy,
// whether dev already contains it, and whether merging it anywhere would
// conflict. All of it from refs, so a feature worktree's own dirtiness only
// shows as a flag and never blocks reading the rest.
async function worktreeStatus() {
  const worktrees = await listWorktrees()
  return Promise.all(worktrees.map(async (w) => {
    const [head, dirty, ahead, inDev] = await Promise.all([
      gitOrNull('rev-parse', '--short', w.branch),
      gitInOrNull(w.path, 'status', '--porcelain'),
      gitOrNull('rev-list', '--count', `${BRANCH}..${w.branch}`),
      gitOrNull('merge-base', '--is-ancestor', w.branch, DEV_BRANCH).then((r) => r !== null),
    ])
    const isDev = w.branch === DEV_BRANCH
    const preview = !isDev && !inDev
      ? await mergePreview(DEV_BRANCH, w.branch)
      : { clean: true, conflicts: [] }
    return {
      path: w.path, branch: w.branch, head, isDev,
      dirty: Boolean(dirty),
      aheadDeploy: Number(ahead ?? 0),
      inDev: Boolean(inDev),
      clean: preview.clean, conflicts: preview.conflicts,
    }
  }))
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
async function serveUrlFor(proxyTarget) {
  try {
    const { stdout } = await run('/usr/bin/tailscale', ['serve', 'status', '--json'], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const serve = JSON.parse(stdout)
    const match = Object.entries(serve.Web ?? {}).find(([, site]) =>
      Object.values(site.Handlers ?? {}).some((handler) => handler.Proxy === proxyTarget),
    )
    return match ? `https://${match[0]}` : null
  } catch {
    return null
  }
}

const publishedUrl = () => serveUrlFor(`http://${HOST}:${PORT}`)
// The dev console's own published origin; see the dev console listener below.
const devPublishedUrl = () => serveUrlFor(`http://${HOST}:${DEV_CONSOLE_PORT}`)

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
  worktree: null,
  servingBranch: null,
  // Whether the exit about to happen was asked for. Without this, a crash
  // after a successful start reports as a clean stop and no one learns why
  // the dev console just went away.
  stopRequested: false,
}

async function devRunnerStatus() {
  return {
    configured: Boolean(DEV_REPO),
    repo: DEV_REPO || null,
    branch: DEV_BRANCH,
    // Which worktree the runner serves, and the branch checked out there.
    worktree: devRunner.worktree,
    servingBranch: devRunner.servingBranch,
    state: devRunner.state,
    origin: devRunner.origin,
    error: devRunner.error,
    output: stripAnsi(devRunner.output).slice(-8000),
    // Where a browser reaches the dev console: the published HTTPS origin
    // when Serve maps it, else the tailnet address of the listener itself.
    publicUrl: await devPublishedUrl(),
    directUrl: `http://${HOST}:${DEV_CONSOLE_PORT}`,
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

async function startDevRunner(worktree) {
  if (!DEV_REPO) throw new Error('no development worktree is configured')
  if (devRunner.state === 'starting' || devRunner.state === 'running') return devRunnerStatus()

  // The runner serves the dev worktree by default, or any listed feature
  // worktree. Each worktree brings its own data directory and ports, so which
  // one runs changes only what the dev console shows.
  const target = worktree ?? DEV_REPO
  if (target !== DEV_REPO && !(await listWorktrees()).some((w) => w.path === target)) {
    throw new Error(`not a worktree of the fork: ${target}`)
  }
  const servingBranch = await gitInOrNull(target, 'rev-parse', '--abbrev-ref', 'HEAD')

  Object.assign(devRunner, {
    state: 'starting', origin: null, home: null, output: '', error: null,
    stopRequested: false, worktree: target, servingBranch,
  })

  // Nothing of this dashboard's own T3 configuration may leak into the
  // runner: an inherited T3CODE_PORT once made a dev backend bind
  // production's port number, and an inherited T3CODE_HOME is one old branch
  // away from pointing it at the live ~/.t3. The runner resolves its own
  // ports and its worktree-local data directory.
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('T3CODE_') || key === 'PORT') delete env[key]
  }

  // The runner starts the backend and Vite as children. Thus it must have its
  // own process group. If it does not, the stop below cannot reach the
  // children.
  const child = spawn(PNPM_BIN, ['dev'], {
    cwd: target,
    env,
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
    // Only an exit that was asked for is a stop. Everything else is a
    // failure, even after a successful start: a crashed runner silently
    // reported as "stopped" leaves the dev console dead with no explanation.
    const started = Boolean(devRunner.origin)
    const origin = devRunner.origin
    const wanted = devRunner.stopRequested
    Object.assign(devRunner, {
      state: wanted ? 'stopped' : 'failed',
      pid: null, origin: null, child: null,
      worktree: null, servingBranch: null,
      error: wanted ? null
        : started ? `dev runner exited unexpectedly (${signal ?? `code ${code}`})`
        : `dev runner exited with code ${code}`,
    })
    // Remove the dev credentials only. The deploy token stays correct.
    if (origin) sessionTokens.delete(origin)
  })

  return devRunnerStatus()
}

function stopDevRunner() {
  devRunner.stopRequested = true
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
  // The label includes the port. T3 Code revokes the session that has the same
  // label when it issues a new one. With a constant label, a second dashboard
  // on this machine removes the session of the first dashboard, and the console
  // of the first dashboard then gets an HTTP 403.
  const label = `dashboard proxy :${PORT}`
  const args = ['auth', 'session', 'issue', '--ttl', '30d', '--label', label, '--token-only']
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

// Each listener serves exactly one backend. The main origin is always the
// deploy build, so the stable console can never be rerouted; the dev console
// has its own origin on DEV_CONSOLE_PORT. Two origins means both consoles can
// be mounted at once, and switching between them reloads nothing.
async function deployTarget() {
  const origin = await t3Origin()
  return origin ? { name: 'deploy', origin, home: T3_HOME, sessionFile: SESSION_FILE } : null
}

function devTarget() {
  if (devRunner.state === 'running' && devRunner.origin) {
    return { name: 'dev', origin: devRunner.origin, home: devRunner.home, sessionFile: DEV_SESSION_FILE }
  }
  return null
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

async function proxy(req, res, backend) {
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
async function proxyUpgrade(req, clientSocket, head, backend) {
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
  step('record built revision', async (job) => {
    const sha = await git('rev-parse', '--short', 'HEAD')
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(BUILT_SHA_PATH, `${sha}\n`)
    appendOutput(job, `built ${sha}\n`)
  }),
]

// Installing and restarting are deliberately after every build step: a failed
// build leaves the running service exactly as it was.
// Installing and restarting are deliberately separate from the build. A deploy
// makes the assets in the worktree live. It compiles nothing, and it moves no
// branch.
const DEPLOY_STEPS = [
  step('verify a build is present', async (job) => {
    for (const asset of BUILD_ASSETS) {
      await readFile(`${REPO}/apps/server/${asset}`).catch(() => {
        throw new Error(`no build to deploy: apps/server/${asset} is absent. Build first.`)
      })
    }
    appendOutput(job, 'build assets present\n')
  }),
  step('install globally', (job) => exec(job, NPM_BIN, npmInstallArgs(`${REPO}/apps/server`))),
  step('restart service', (job) =>
    exec(job, 'systemctl', ['--user', 'restart', UNIT], { cwd: process.env.HOME }),
  ),
  step('record deployed revision', async (job) => {
    const sha = await builtSha()
    if (!sha) throw new Error('the build revision is not recorded. Build first.')
    await mkdir(STATE_DIR, { recursive: true })
    await writeFile(DEPLOYED_SHA_PATH, `${sha}\n`)
    appendOutput(job, `deployed ${sha}\n`)
  }),
]

// One merge for each pair of branches, and nothing else in the job. Thus a
// conflict between main and deploy leaves dev where it was, and you repeat one
// step and not three.
const guardDeploy = step('guard deploy worktree', async (job) => {
  if (await git('status', '--porcelain')) {
    throw new Error(`${BRANCH} worktree has uncommitted changes`)
  }
  const checkedOut = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (checkedOut !== BRANCH) throw new Error(`deploy worktree must have ${BRANCH} checked out`)
  appendOutput(job, `${BRANCH} worktree clean\n`)
})

const guardDev = step('guard development worktree', async (job) => {
  if (!DEV_REPO || DEV_REPO === REPO) throw new Error('there is no separate development worktree')
  if (await gitIn(DEV_REPO, 'status', '--porcelain')) {
    throw new Error(`${DEV_BRANCH} worktree has uncommitted changes`)
  }
  appendOutput(job, `${DEV_BRANCH} worktree clean\n`)
})

// main is a copy of upstream. A merge that is not a fast-forward means that
// something changed main on this machine, and a person must look at it.
const MAIN_STEPS = [
  step('fetch', (job) => exec(job, 'git', ['-C', REPO, 'fetch', '--prune', '--multiple', 'origin', 'upstream'])),
  step('move main to upstream/main', async (job) => {
    await exec(job, 'git', ['-C', REPO, 'merge-base', '--is-ancestor', 'main', 'upstream/main'])
    await exec(job, 'git', ['-C', REPO, 'branch', '-f', 'main', 'upstream/main'])
  }),
  step('push main', async (job) => {
    const pushed = await gitOrNull('push', 'origin', 'main')
    appendOutput(job, pushed === null ? '[skipped] could not push main\n' : 'pushed main\n')
  }),
]

const MERGE_DEPLOY_STEPS = [
  guardDeploy,
  step(`merge main into ${BRANCH}`, (job) => mergeInto(job, REPO, 'main', BRANCH)),
  step(`push ${BRANCH}`, (job) => exec(job, 'git', ['-C', REPO, 'push', 'origin', BRANCH])),
]

const MERGE_DEV_STEPS = [
  guardDev,
  step(`merge ${BRANCH} into ${DEV_BRANCH}`, (job) => mergeInto(job, DEV_REPO, BRANCH, DEV_BRANCH)),
  step(`push ${DEV_BRANCH}`, async (job) => {
    const pushed = await gitInOrNull(DEV_REPO, 'push', 'origin', DEV_BRANCH)
    appendOutput(job, pushed === null ? `[skipped] could not push ${DEV_BRANCH}\n` : `pushed ${DEV_BRANCH}\n`)
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
  guardDeploy,
  guardDev,
  step(`merge ${DEV_BRANCH} into ${BRANCH}`, (job) => mergeInto(job, REPO, DEV_BRANCH, BRANCH)),
  step(`push ${BRANCH}`, (job) => exec(job, 'git', ['-C', REPO, 'push', 'origin', BRANCH])),
]

// The dashboard updating itself. The pull is ours; the copy-and-restart is
// refresh-dashboard.sh's, handed to systemd so it survives the restart of the
// very process that started it. It never names the T3 Code unit.
const SELF_UPDATE_STEPS = [
  step('guard dashboard repo', async (job) => {
    if (await gitHostOrNull('status', '--porcelain')) {
      throw new Error(`the dashboard repo has uncommitted changes: ${HOST_REPO}`)
    }
    appendOutput(job, 'dashboard repo clean\n')
  }),
  step('pull latest', (job) =>
    exec(job, 'git', ['-C', HOST_REPO, 'pull', '--ff-only'], { cwd: HOST_REPO })),
  step('install and restart dashboard', async (job) => {
    if (!DASH_UNIT) {
      appendOutput(job, '[skipped] no dashboard unit; this instance runs from source. Restart it to apply.\n')
      return
    }
    await exec(job, 'systemd-run', [
      '--user', '--collect',
      '--unit', `${DASH_UNIT.replace(/\.service$/, '')}-refresh`,
      // A transient unit starts with a bare environment; the script needs the
      // same node and git this dashboard was started with.
      '--setenv', `PATH=${process.env.PATH}`,
      '--setenv', `T3CODE_INSTANCE=${INSTANCE}`,
      '--setenv', 'T3CODE_YES=1',
      `${HOST_REPO}/refresh-dashboard.sh`,
    ], { cwd: HOST_REPO })
    appendOutput(job, 'refresh handed to systemd; the dashboard restarts in a moment\n')
  }),
]

// One job moves one thing. Thus you always know what a button changes, and a
// failure gives you one step to repeat.
//
//   main           main <- upstream/main. No merge into another branch.
//   merge-deploy   deploy <- main. No build. No restart.
//   merge-dev      dev <- deploy. No build. No restart.
//   promote        deploy <- dev. No build. No restart.
//   build          the source only. No install. No restart.
//   deploy         the installation and the service only. No git. No compile.
//
// A full upgrade is main, merge-deploy, merge-dev, build, deploy. Each job is
// separate, so a conflict in one leaves the other branches where they were.
const JOBS = {
  main: [...MAIN_STEPS],
  'merge-deploy': [...MERGE_DEPLOY_STEPS],
  'merge-dev': [...MERGE_DEV_STEPS],
  promote: [...PROMOTE_STEPS],
  build: [...BUILD_STEPS],
  deploy: [...DEPLOY_STEPS],
  'self-update': [...SELF_UPDATE_STEPS],
}

// Feature-branch jobs take the branch as a parameter: one merges it into dev
// for staging, the other promotes it straight into deploy. Both work from
// refs, so the feature worktree itself is never touched.
function branchJobSteps(name, branch) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_/.-]*$/.test(branch ?? '')) {
    throw new Error('invalid branch name')
  }
  const verify = step('verify branch', async (job) => {
    await git('rev-parse', '--verify', `refs/heads/${branch}`)
    appendOutput(job, `${branch} exists\n`)
  })
  if (name === 'merge-into-dev') {
    if (branch === DEV_BRANCH) throw new Error(`${DEV_BRANCH} cannot merge into itself`)
    return [
      verify,
      guardDev,
      step(`merge ${branch} into ${DEV_BRANCH}`, (job) => mergeInto(job, DEV_REPO, branch, DEV_BRANCH)),
      step(`push ${DEV_BRANCH}`, async (job) => {
        const pushed = await gitInOrNull(DEV_REPO, 'push', 'origin', DEV_BRANCH)
        appendOutput(job, pushed === null ? `[skipped] could not push ${DEV_BRANCH}\n` : `pushed ${DEV_BRANCH}\n`)
      }),
    ]
  }
  if (name === 'promote-branch') {
    if (branch === BRANCH) throw new Error(`${BRANCH} cannot merge into itself`)
    return [
      verify,
      guardDeploy,
      step(`merge ${branch} into ${BRANCH}`, (job) => mergeInto(job, REPO, branch, BRANCH)),
      step(`push ${BRANCH}`, (job) => exec(job, 'git', ['-C', REPO, 'push', 'origin', BRANCH])),
    ]
  }
  throw new Error(`unknown job: ${name}`)
}

function startJob(name, params = {}) {
  const steps = JOBS[name] ??
    (name === 'merge-into-dev' || name === 'promote-branch'
      ? branchJobSteps(name, params.branch)
      : null)
  if (!steps) throw new Error(`unknown job: ${name}`)
  if (name === 'self-update' ? !HOST_REPO : !REPO) {
    throw new Error(name === 'self-update'
      ? 'T3CODE_HOST_REPO is not configured' : 'T3CODE_REPO is not configured')
  }
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

// ---------------------------------------------------------------------------
// mock mode
// ---------------------------------------------------------------------------

// T3CODE_MOCK=1 replaces every /_dash data source with canned states, so each
// screen of the page can be seen and styled without a clone, a build, or a
// systemd unit. A picker in the console header switches the scenario. The
// proxy is untouched: the frame still shows whatever the proxy origin serves.
const MOCK = process.env.T3CODE_MOCK === '1'

const MOCK_COMMITS = [
  '9f3c2a1 feat(agent): stream tool output into the session view',
  '4d81be0 fix(server): close the websocket on session expiry',
  '7aa90c4 chore: bump vite to 6.3.2',
  '02cd511 fix(web): keep the sidebar scroll position on refresh',
]

// One object per state the page can be in. `fork` overrides the healthy fork,
// `status` overrides the healthy service, `jobOutcome: 'failed'` makes the
// next job fail partway, and `npm: true` hides the fork entirely so the page
// falls back to the npm release sections.
const MOCK_SCENARIOS = {
  synced: {},
  'upstream-behind': { fork: { mainBehind: 4, commits: MOCK_COMMITS } },
  'merge-pending': { fork: { deployBehind: 2 } },
  'build-stale': { fork: { tip: 'ef45ab1', needsRebuild: true } },
  deployable: { fork: { tip: 'ef45ab1', built: 'ef45ab1', needsDeploy: true } },
  'dev-ahead': { fork: { dev: { ahead: 3 } } },
  'dev-behind': { fork: { dev: { behind: 2 } } },
  conflicts: {
    fork: {
      mainBehind: 2, clean: false, commits: MOCK_COMMITS.slice(0, 2),
      conflicts: ['apps/server/src/router.ts', 'packages/core/src/auth.ts'],
    },
  },
  dirty: { fork: { dirty: true, dev: { dirty: true } } },
  'job-fails': { fork: { tip: 'ef45ab1', needsRebuild: true }, jobOutcome: 'failed' },
  'service-stopped': { status: { active: 'inactive', sub: 'dead', pid: null, startedAt: null, origin: null } },
  'service-failed': { status: { active: 'failed', sub: 'failed', pid: null, startedAt: null, origin: null, restarts: '4' } },
  'dashboard-behind': { self: { behind: 2 } },
  'feature-branches': {
    fork: {
      worktrees: [
        { path: '/mock/wt/no-autoscroll', branch: 'fix/no-autoscroll', head: 'ab34cd5', isDev: false,
          dirty: false, aheadDeploy: 2, inDev: false, clean: true, conflicts: [] },
        { path: '/mock/wt/notifications', branch: 'feat/notifications', head: 'ef56ab7', isDev: false,
          dirty: true, aheadDeploy: 5, inDev: true, clean: true, conflicts: [] },
        { path: '/mock/wt/branding', branch: 'fork/branding', head: '9a8b7c6', isDev: false,
          dirty: false, aheadDeploy: 1, inDev: false, clean: false, conflicts: ['apps/web/src/theme.ts'] },
      ],
    },
  },
  'npm-mode': {
    npm: true,
    latest: { installed: '0.0.32-nightly.20260801.990', latest: '0.0.33-nightly.20260806.1010', upToDate: false },
  },
}

const mockState = { scenario: 'synced', service: 'active', runner: 'stopped', job: null }
const mockJobs = new Map()

function mockScenario() {
  return MOCK_SCENARIOS[mockState.scenario] ?? {}
}

function mockFork() {
  const { dev = {}, ...rest } = mockScenario().fork ?? {}
  const commits = rest.commits ?? []
  return {
    repo: '/mock/t3code/src', branch: 'deploy', checkedOut: 'deploy',
    head: 'ab12cd3', tip: 'ab12cd3', built: 'ab12cd3', deployed: 'ab12cd3',
    hasBuild: true, needsRebuild: false, needsDeploy: false, dirty: false,
    mainBehind: 0, deployBehind: 0, clean: true, conflicts: [],
    worktrees: [],
    ...rest,
    commits,
    dev: {
      repo: '/mock/t3code/dev', branch: 'dev', head: 'ab12cd3',
      dirty: false, ahead: 0, behind: 0, clean: true, conflicts: [],
      ...dev,
    },
    active: mockState.job?.state === 'running' ? mockState.job.id : null,
  }
}

function mockStatus() {
  const stopped = mockState.service !== 'active'
  return {
    managed: true, unit: 't3code.service',
    active: mockState.service, sub: stopped ? 'dead' : 'running',
    enabled: 'enabled', pid: stopped ? null : '41214',
    startedAt: stopped ? null : new Date(Date.now() - 2 * 3600_000).toString(),
    restarts: '0',
    installed: '0.0.32-nightly.20260801.990',
    url: null,
    origin: stopped ? null : PROXY_ORIGIN || 'http://localhost:4123',
    ...mockScenario().status,
  }
}

function mockRunnerStatus() {
  const worktree = mockState.runner === 'stopped' || mockState.runner === 'failed'
    ? null : mockState.runnerWorktree ?? '/mock/t3code/dev'
  const branch = worktree
    ? (mockScenario().fork?.worktrees ?? []).find((w) => w.path === worktree)?.branch ?? 'dev'
    : null
  return {
    configured: true, repo: '/mock/t3code/dev', branch: 'dev',
    worktree, servingBranch: branch,
    state: mockState.runner,
    origin: mockState.runner === 'running' ? 'http://localhost:1' : null,
    error: null, output: '',
    // The mock has no real dev console; the direct URL points at this
    // dashboard's own dev listener, whose placeholder page then shows.
    publicUrl: null,
    directUrl: `http://${HOST}:${DEV_CONSOLE_PORT}`,
  }
}

// A fake job streams output on a timer and walks the real step labels, so the
// polling, the running marker, and the failure colours all exercise the same
// paths a real build does -- just in seconds instead of minutes.
function startMockJob(name, branch) {
  if (mockState.job?.state === 'running') {
    const err = new Error('a job is already running')
    err.conflict = true
    throw err
  }
  const labels = JOBS[name]?.map((s) => s.label) ??
    (branch && (name === 'merge-into-dev' || name === 'promote-branch')
      ? ['verify branch', `merge ${branch}`, 'push']
      : [])
  if (!labels.length) throw new Error(`unknown job: ${name}`)
  const outcome = mockScenario().jobOutcome ?? 'ok'

  const id = randomBytes(4).toString('hex')
  const job = { id, name, state: 'running', step: labels[0], output: '', error: null }
  mockJobs.set(id, job)
  mockState.job = job

  let tick = 0
  const timer = setInterval(() => {
    job.output += `[mock] ${job.step}: line ${tick % 3 + 1}\n`
    tick++
    if (tick % 3 !== 0) return
    const next = labels[tick / 3]
    if (next && !(outcome === 'failed' && tick / 3 >= Math.min(2, labels.length - 1))) {
      job.step = next
      job.output += `\n=== ${next} ===\n`
      return
    }
    clearInterval(timer)
    if (outcome === 'failed') {
      job.state = 'failed'
      job.error = `${job.step} exited 1 (mock)`
      job.output += `\nFAILED: ${job.error}\n`
    } else {
      job.state = 'ok'
      job.step = 'done'
      job.output += '\ndone\n'
    }
  }, 400)
  return job
}

function mockChangelog() {
  const scen = mockScenario().latest ?? {}
  return {
    from: scen.installed ?? '0.0.32-nightly.20260801.990',
    to: scen.latest ?? '0.0.33-nightly.20260806.1010',
    releases: [{
      version: scen.latest ?? '0.0.33-nightly.20260806.1010',
      name: 'nightly', url: '#',
      published: new Date(Date.now() - 8 * 3600_000).toISOString(),
      body: "## What's Changed\n* feat(agent): stream tool output by @mock in https://example.invalid/pull/101\n* fix(server): close the websocket on session expiry by @mock in https://example.invalid/pull/102",
      build: 1010,
    }],
  }
}

function mockApi(req, res, url) {
  const post = req.method === 'POST'
  if (post && req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })
  const path = url.pathname

  if (path === '/_dash/mock') {
    if (post) {
      const wanted = url.searchParams.get('scenario')
      if (!MOCK_SCENARIOS[wanted]) return json(res, 400, { error: `unknown scenario: ${wanted}` })
      mockState.scenario = wanted
      mockState.service = MOCK_SCENARIOS[wanted].status?.active ?? 'active'
    }
    return json(res, 200, { scenario: mockState.scenario, scenarios: Object.keys(MOCK_SCENARIOS) })
  }
  if (path === '/_dash/status') return json(res, 200, mockStatus())
  if (path === '/_dash/latest') {
    return json(res, 200, mockScenario().latest ??
      { installed: '0.0.32-nightly.20260801.990', latest: '0.0.32-nightly.20260801.990', upToDate: true })
  }
  if (path === '/_dash/changelog') return json(res, 200, mockChangelog())
  if (path === '/_dash/fork' || path === '/_dash/fork/refresh') {
    if (mockScenario().npm) return json(res, 404, { error: 'source mode is not configured' })
    return json(res, 200, mockFork())
  }
  if (path === '/_dash/self' || path === '/_dash/self/refresh') {
    const behind = mockScenario().self?.behind ?? 0
    return json(res, 200, {
      repo: '/mock/t3code-host', branch: 'main', head: '1a2b3c4',
      dirty: false, behind,
      commits: MOCK_COMMITS.slice(0, behind),
      copyCurrent: behind === 0, managed: true,
      active: mockState.job?.state === 'running' ? mockState.job.id : null,
    })
  }
  if (path === '/_dash/dev-runner') {
    if (post) {
      const action = url.searchParams.get('action')
      if (action === 'start' && mockState.runner === 'stopped') {
        mockState.runnerWorktree = url.searchParams.get('worktree') ?? '/mock/t3code/dev'
        mockState.runner = 'starting'
        setTimeout(() => { if (mockState.runner === 'starting') mockState.runner = 'running' }, 1500).unref()
      } else if (action === 'stop' && mockState.runner === 'running') {
        mockState.runner = 'stopping'
        setTimeout(() => { if (mockState.runner === 'stopping') mockState.runner = 'stopped' }, 1000).unref()
      }
    }
    return json(res, 200, mockRunnerStatus())
  }
  if (post && path === '/_dash/job') {
    try {
      const job = startMockJob(url.searchParams.get('name'), url.searchParams.get('branch'))
      return json(res, 200, { id: job.id, name: job.name })
    } catch (err) {
      return json(res, err.conflict ? 409 : 400, { error: err.message })
    }
  }
  if (path.startsWith('/_dash/job/')) {
    const job = mockJobs.get(path.slice('/_dash/job/'.length))
    if (!job) return json(res, 404, { error: 'no such job' })
    return json(res, 200, job)
  }
  if (post && path === '/_dash/action') {
    const action = url.searchParams.get('name')
    if (action === 'start' || action === 'restart' || action === 'update') mockState.service = 'active'
    else if (action === 'stop') mockState.service = 'inactive'
    else return json(res, 400, { error: `unknown action: ${action}` })
    return json(res, 200, { ok: true, action, output: `(mock) systemctl --user ${action} t3code.service` })
  }
  if (post && path === '/_dash/pair') {
    return json(res, 409, { error: 'mock mode has no real backend to pair with' })
  }
  return json(res, 404, { error: 'not found' })
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
        .replaceAll('__MOCK__', MOCK ? '1' : '')
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      return res.end(html)
    }

    // Anything that is not the dashboard page or its API belongs to the
    // deploy T3. The dev console lives on its own port.
    if (!url.pathname.startsWith(API_PREFIX)) return proxy(req, res, await deployTarget())

    // In mock mode the canned data answers every API route, so no request
    // below this line touches git, systemd, npm, or the t3 binary.
    if (MOCK) return mockApi(req, res, url)

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

    if (req.method === 'GET' && url.pathname === '/_dash/self') {
      const self = await selfStatus()
      if (!self) return json(res, 404, { error: 'the dashboard repo is not configured' })
      return json(res, 200, self)
    }

    // Like /fork/refresh: fetch first, so the counts agree with the remote now.
    if (req.method === 'POST' && url.pathname === '/_dash/self/refresh') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })
      const self = await selfStatus()
      if (!self) return json(res, 404, { error: 'the dashboard repo is not configured' })
      await gitHostOrNull('fetch', '--prune', 'origin')
      return json(res, 200, await selfStatus())
    }

    if (req.method === 'GET' && url.pathname === '/_dash/dev-runner') {
      return json(res, 200, await devRunnerStatus())
    }

    if (req.method === 'POST' && url.pathname === '/_dash/dev-runner') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })
      const action = url.searchParams.get('action')
      try {
        if (action === 'start') {
          return json(res, 200, await startDevRunner(url.searchParams.get('worktree') ?? undefined))
        }
        if (action === 'stop') return json(res, 200, await stopDevRunner())
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
        const job = startJob(url.searchParams.get('name'), {
          branch: url.searchParams.get('branch') ?? undefined,
        })
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

      const backend = await deployTarget()
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
  .card > h2 button.icon.flat { width:20px; height:20px; font-size:.72rem; margin:-2px -4px -2px auto; }
  /* A small real button that sits in a section heading, next to the tag. */
  .card > h2 button.hbtn {
    flex:none; min-width:0; margin:-4px 0; padding:.2rem .6rem;
    font-size:.68rem; letter-spacing:0; text-transform:none;
  }
  .dot.mini { width:7px; height:7px; vertical-align:baseline; }
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
  /* The step that a job is executing right now. It stays readable while every
     job button is disabled, so you can see which one is in flight. */
  button.running, button.running:disabled {
    opacity:1; border-color:#4a3a12; color:var(--amber);
  }
  button.running::after {
    content:''; display:inline-block; vertical-align:-1px; margin-left:.45rem;
    width:9px; height:9px; border-radius:50%;
    border:1.5px solid #4a3a12; border-top-color:var(--amber);
    animation:spin .8s linear infinite;
  }

  /* The service facts are two dim lines under the state, not a label/value
     table: none of them ask for alignment, and the vertical space belongs to
     the sections below. */
  .svc-line {
    color:var(--faint); font-size:.73rem; line-height:1.7; word-break:break-all;
  }
  .svc-line a, .svc-line .val { color:var(--dim); }

  /* The pipeline is a vertical list of steps. Each row is the action, its
     place in the flow (the glyph), and what stands between it and done (the
     meta on the right). One row therefore replaces a button, a chip, and half
     a sentence of the old note. */
  .steps {
    display:flex; flex-direction:column;
    border:1px solid var(--line-soft); border-radius:8px; overflow:hidden;
  }
  .step {
    display:flex; align-items:center; gap:.6rem; width:100%; min-width:0;
    flex:none; background:none; border:0; border-radius:0; padding:.5rem .7rem;
    font-size:.78rem; color:var(--dim); text-align:left;
  }
  .step + .step { border-top:1px solid var(--line-soft); }
  .step:hover:not(:disabled) { background:var(--raised); color:var(--text); border-color:var(--line-soft); border-top-color:var(--line-soft); }
  /* A finished or blocked step is information, not an error: keep it legible
     and let the glyph and meta carry the state instead of a heavy fade. */
  .step:disabled { opacity:1; color:var(--faint); cursor:default; }
  /* Only a step that can actually run reads as a control: it is brighter,
     and it carries a chevron. The rest are status lines. */
  button.step:not(:disabled) { color:var(--text); cursor:pointer; }
  button.step:not(:disabled)::after { content:'›'; flex:none; color:var(--accent); }

  /* A worktree row: the branch is the serve action, and the two icons move
     the branch into dev or deploy. The row itself is a plain container. */
  div.step { cursor:default; }
  .wt-name {
    flex:none; min-width:0; padding:0; border:0; background:none;
    font:inherit; font-size:.78rem; color:var(--text); cursor:pointer;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  .wt-name:hover:not(:disabled) { color:var(--accent); background:none; border:0; }
  .wt-name:disabled { color:var(--faint); cursor:default; }
  div.step .meta { margin-left:auto; }
  div.step button.icon { width:22px; height:22px; font-size:.72rem; margin:-2px 0; }
  div.step.serving .glyph::before { content:'●'; color:var(--green); }
  .step .glyph { flex:none; width:1rem; text-align:center; color:var(--faint); }
  .step .glyph::before { content:'○'; }
  .step.complete .glyph::before { content:'✓'; color:var(--green); }
  .step.current { color:var(--text); background:rgba(125,211,252,.04); }
  .step.current .glyph::before { content:'●'; color:var(--accent); }
  .step .lbl { flex:none; }
  .step .meta { margin-left:auto; color:var(--faint); font-size:.7rem; text-align:right; }
  .step.current .meta { color:var(--accent); }
  .step .meta.warn { color:var(--amber); }
  /* The running job spins in the glyph column; the generic trailing spinner
     of button.running would sit past the meta, in the wrong column. */
  .step.running::after { content:none; }
  .step.running, .step.running:disabled { color:var(--amber); }
  .step.running .glyph::before {
    content:''; display:block; width:9px; height:9px; margin:0 auto;
    border-radius:50%; border:1.5px solid #4a3a12; border-top-color:var(--amber);
    animation:spin .8s linear infinite;
  }

  .dev-empty {
    padding:.8rem; border:1px dashed var(--line); border-radius:7px;
    color:var(--faint); font-size:.75rem; line-height:1.55;
  }
  .dev-line { color:var(--faint); font-size:.72rem; margin:0 0 .6rem; word-break:break-all; }
  .steps + .steps { margin-top:.45rem; }

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
  .note:empty { display:none; }
  .note .bad-text { color:var(--red); }
  .note .warn-text { color:var(--amber); }

  /* log ------------------------------------------------------------------- */
  .log-card { display:flex; flex-direction:column; flex:none; margin-top:auto; }
  .log-head {
    display:flex; align-items:center; gap:.5rem; margin:0 0 .5rem;
    font-size:.66rem; letter-spacing:.13em; text-transform:uppercase; color:var(--faint);
  }
  .log-head .job { text-transform:none; letter-spacing:0; color:var(--dim); margin-left:auto; }
  /* The newest line takes the colour of the outcome, so a failure is visible
     without opening the full log. */
  .log-card[data-state="running"] pre#log { color:#c9c9cf; }
  .log-card[data-state="ok"] pre#log { color:var(--green); }
  .log-card[data-state="failed"] pre#log { color:var(--red); }
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

  /* confirm --------------------------------------------------------------- */
  /* One dialog for every job, in place of the browser's confirm(). The page's
     own styling makes the message readable, and Enter/Esc still work. */
  dialog#confirm {
    width:min(420px, 90vw); padding:0; color:var(--text);
    background:var(--panel); border:1px solid var(--line); border-radius:12px;
    box-shadow:0 24px 60px -20px #000;
  }
  dialog#confirm::backdrop { background:rgba(0,0,0,.6); }
  .confirm-body {
    margin:0; padding:.85rem .95rem .2rem; color:var(--dim);
    font-size:.79rem; line-height:1.65;
  }
  .confirm-actions { display:flex; gap:.5rem; justify-content:flex-end; padding:.8rem .95rem .9rem; }
  .confirm-actions button { flex:0 0 auto; min-width:96px; }

  /* release notes / commits ------------------------------------------------ */
  #notes { margin-top:.8rem; border-top:1px solid var(--line-soft); padding-top:.3rem;
           max-height:24rem; overflow:auto; }
  .rel { padding:.65rem 0; border-bottom:1px solid var(--line-soft); }
  .rel:last-child { border-bottom:0; }
  .rel h3 { font-size:.78rem; margin:0 0 .1rem; font-weight:600; color:#dcdce0; }
  .rel time { color:var(--faint); font-size:.7rem; }
  .rel ul { margin:.4rem 0 0; padding-left:1.05rem; }
  .rel li { color:#a9a9b1; margin:.18rem 0; font-size:.75rem; }
  .sub { color:var(--faint); margin:.55rem 0 .1rem; font-size:.68rem;
         text-transform:uppercase; letter-spacing:.09em; }
  .scope { color:var(--violet); }
  /* Incoming commits: the sha is a column of its own, dim, and the message
     keeps to one line. The list scans as a list, not as a paragraph. */
  .commit { display:flex; align-items:baseline; gap:.55rem; padding:.16rem 0; font-size:.73rem; }
  .commit .sha { flex:none; color:var(--faint); font-size:.68rem; }
  .commit .msg {
    min-width:0; color:#a9a9b1;
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  #self-commits { margin:0 0 .6rem; }

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
  select#mock-picker {
    flex:0 0 auto; background:var(--raised); color:var(--amber);
    border:1px solid #4a3a12; border-radius:6px; font:inherit; font-size:.7rem;
    padding:.2rem .35rem; cursor:pointer;
  }
  .frame-wrap { position:relative; flex:1 1 auto; min-height:0; }
  iframe#frame, iframe#frame-dev { width:100%; height:100%; border:0; background:#0a0a0b; display:block; }
  iframe#frame-dev { position:absolute; inset:0; }
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
        <div id="status"></div>
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
        <h2>release
          <button id="fork-refresh" class="icon flat" title="Check for new upstream changes"
            aria-label="Check for new upstream changes">⟳</button>
        </h2>
        <!-- The pipeline from upstream to the running service, one row per
             step. The glyph gives the position in the flow, the meta gives
             what the step would act on, and the row itself is the action. -->
        <div class="steps" aria-label="Release pipeline">
          <button class="step" id="job-main"><span class="glyph"></span>
            <span class="lbl">Sync main</span><span class="meta" id="meta-main"></span></button>
          <button class="step" id="job-merge-deploy"><span class="glyph"></span>
            <span class="lbl">Merge into deploy</span><span class="meta" id="meta-merge"></span></button>
          <button class="step" id="build-run"><span class="glyph"></span>
            <span class="lbl">Build</span><span class="meta" id="meta-build"></span></button>
          <button class="step" id="build-deploy"><span class="glyph"></span>
            <span class="lbl">Deploy</span><span class="meta" id="meta-deploy"></span></button>
        </div>
        <div id="fork-note" class="note"></div>
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

      <!-- The dev server lives in the heading, mirroring the service line at
           the top: a dot, the state, and the one control that applies. -->
      <section class="card" id="dev-card" hidden>
        <h2>dev
          <span class="tag"><span class="dot mini" id="dev-runner-dot"></span>
            <span id="dev-runner-state">stopped</span></span>
          <button id="dev-runner-toggle" class="hbtn"
            title="Runs the dev worktree from source with hot reload, alongside the deployed build.">Start</button>
        </h2>
        <div class="dev-empty" id="dev-empty" hidden>No development worktree is configured.</div>
        <div id="dev-content">
          <div class="dev-line" id="dev-line">—</div>
          <!-- One row per feature worktree: click the branch to serve it on
               the dev tab; the icons merge it into dev or promote it into
               deploy. Dev itself stays the staging pipeline below. -->
          <div class="steps" id="wt-list" hidden aria-label="Feature worktrees"></div>
          <div class="steps" aria-label="Dev branch actions">
            <button class="step" id="job-merge-dev"><span class="glyph"></span>
              <span class="lbl">dev &larr; deploy</span><span class="meta" id="meta-merge-dev"></span></button>
            <button class="step" id="fork-promote"><span class="glyph"></span>
              <span class="lbl">deploy &larr; dev</span><span class="meta" id="meta-promote"></span></button>
          </div>
          <div id="fork-dev-note" class="note"></div>
          <div id="dev-runner-note" class="note"></div>
        </div>
      </section>

      <!-- The dashboard watching its own repo. The action pulls and restarts
           only the dashboard unit; T3 Code and its sessions are untouched. -->
      <section class="card" id="self-card" hidden>
        <h2>dashboard
          <button id="self-refresh" class="icon flat" title="Check for dashboard updates"
            aria-label="Check for dashboard updates">⟳</button>
        </h2>
        <div id="self-commits" hidden></div>
        <div class="steps">
          <button class="step" id="job-self-update"><span class="glyph"></span>
            <span class="lbl">Pull &amp; restart</span><span class="meta" id="meta-self"></span></button>
        </div>
        <div id="self-note" class="note"></div>
      </section>

      <!-- One line of it: the latest line is the status, and the rest is only
           wanted when something has gone wrong. -->
      <section class="card log-card">
        <div class="log-head">activity <span class="job" id="log-job"></span></div>
        <div class="log-line">
          <pre id="log" aria-live="polite">ready</pre>
          <button id="log-more" class="linkish" hidden>Show more</button>
        </div>
      </section>
    </div>
  </aside>

  <dialog id="confirm">
    <div class="modal-head">
      <span>confirm</span>
      <span class="job" id="confirm-title"></span>
    </div>
    <p class="confirm-body" id="confirm-text"></p>
    <div class="confirm-actions">
      <button id="confirm-cancel">Cancel</button>
      <button id="confirm-ok" class="primary">Proceed</button>
    </div>
  </dialog>

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
      <!-- Mock mode only: switches the canned scenario that every /_dash
           route answers with, so each state of the sidebar can be seen. -->
      <select id="mock-picker" hidden aria-label="Mock scenario"></select>
      <button id="frame-reload" class="icon" title="Reload" aria-label="Reload">⟳</button>
    </div>
    <div class="frame-wrap">
      <iframe id="frame" title="T3 Code" hidden
        allow="clipboard-read; clipboard-write; fullscreen"></iframe>
      <!-- The dev console keeps its own origin and its own frame. Both frames
           stay mounted; the tabs only choose which one is visible, so
           switching reloads neither console. -->
      <iframe id="frame-dev" title="T3 Code (dev)" hidden
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

  // A control that cannot apply is absent, not greyed out. Without systemd
  // there is nothing to control; on a running unit there is no start; on a
  // stopped one no stop. Restart stays: on a stopped unit it is simply a start.
  managed = s.managed !== false
  document.querySelector('.actions.toolbar').hidden = !managed
  if (!managed) {
    $('update').disabled = true
    $('update').textContent = 'Managed by dev server'
  } else {
    const running = s.active === 'active'
    action('start').hidden = running
    action('stop').hidden = !running
  }

  $('state-dot').className = 'dot ' + dotClass(s.active)
  $('state-label').textContent = s.active + (s.sub && s.sub !== s.active ? ' · ' + s.sub : '')
  $('state-meta').textContent = s.active === 'active' ? uptime(s.startedAt) : s.enabled

  // Two dim lines instead of a table: the unit facts, then what is running.
  // The dashboard's own URL is the address of the page you are reading it on.
  $('status').innerHTML =
    '<div class="svc-line">' + [
      esc(s.unit), esc(s.enabled),
      s.pid ? 'pid ' + esc(s.pid) : null,
      Number(s.restarts) > 0 ? esc(s.restarts) + ' restarts' : null,
    ].filter(Boolean).join(' · ') + '</div>' +
    (s.installed && s.installed !== 'unknown'
      ? '<div class="svc-line">v<span class="val">' + esc(s.installed) + '</span></div>' : '') +
    '<div class="svc-line">' + (s.origin
      ? '<span class="val">' + esc(s.origin) + '</span>' : 'not running') + '</div>'

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

// Which console the tabs picked, and what the deploy side wants to show. Both
// frames stay mounted; only visibility changes, so switching reloads nothing.
let shownConsole = 'deploy'
let deployView = 'placeholder'

function applyView() {
  const dev = shownConsole === 'dev'
  $('frame-dev').hidden = !dev
  $('frame').hidden = dev || deployView !== 'frame'
  $('frame-placeholder').hidden = dev || deployView !== 'placeholder'
}

function showPlaceholder(title, hint, showActions) {
  deployView = 'placeholder'
  $('frame-spinner').hidden = Boolean(showActions)
  $('frame-title').textContent = title
  $('frame-hint').textContent = hint
  $('frame-actions').hidden = !showActions
  applyView()
}

function showFrame() {
  deployView = 'frame'
  applyView()
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
  // Do not wait for the frame's load event: a dev-mode console pulls hundreds
  // of unbundled modules through the proxy chain, so that event can be minutes
  // away while the page is already rendering. Show the document once it has
  // had a moment to commit and let it finish loading in view.
  setTimeout(showFrame, 2000)
}

// ?embed=1 makes the root serve the console rather than this page. Only the
// placeholder offers this now: it is the recovery path when the frame will not
// load. It is not a control for a frame that operates correctly.
$('frame-open-2').onclick = () => window.open('/?embed=1', '_blank')
$('frame-retry').onclick = loadFrame
// Reload whichever console is visible; the hidden one is left alone.
$('frame-reload').onclick = () => {
  if (shownConsole === 'dev') {
    if (devConsoleUrl) $('frame-dev').src = devConsoleUrl + '/?embed=1'
  } else {
    loadFrame()
  }
}

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

// Each step's meta states what stands between that step and done, or the fact
// that nothing does. A warning condition takes the meta over, because it is
// what blocks the step.
// One git log --oneline line becomes a sha column and a one-line message
// with the conventional-commit scope highlighted.
function commitRows(list) {
  return list.map((c) => {
    const m = /^(\S+)\s+(.*)$/.exec(c)
    const msg = esc(m ? m[2] : c)
      .replace(/^(\w+(?:\([^)]+\))?!?):/, '<span class="scope">$1</span>:')
    return '<div class="commit"><span class="sha">' + esc(m ? m[1] : '') + '</span>' +
      '<span class="msg" title="' + esc(m ? m[2] : c) + '">' + msg + '</span></div>'
  }).join('')
}

function setStepMeta(id, text, warn) {
  const meta = $(id)
  meta.textContent = text
  meta.classList.toggle('warn', Boolean(warn))
}

function renderFork(f) {
  $('fork-card').hidden = false
  $('dev-card').hidden = false
  // The npm version line shows a release that this build does not come from.
  // Also, the update replaces the build of the fork. Thus remove the
  // section.
  $('version-card').hidden = true
  forkMode = true

  const flag = (text) => ' <span style="color:var(--amber)">(' + text + ')</span>'
  const rows = (items) => items
    .map(([k, v]) => '<div class="row"><dt>' + esc(k) + '</dt><dd>' + v + '</dd></div>').join('')

  $('fork-upstream-status').innerHTML = rows([
    ['worktree', esc(f.repo)],
    [f.branch + ' tip', esc(f.tip ?? '—')],
    ['main behind upstream', String(f.mainBehind)],
    [f.branch + ' behind main', String(f.deployBehind)],
  ])
  const pending = f.mainBehind > 0 || f.deployBehind > 0
  const blocked = f.dirty || !f.clean || !managed
  // Each button states only its own conditions. A sync and a promote move
  // branches, so they need clean worktrees but no systemd unit. A deploy
  // restarts the service, so it needs the unit but no clean worktree.
  const busy = Boolean(f.active)
  const hasDev = Boolean(f.dev.repo && f.dev.repo !== f.repo)
  $('dev-empty').hidden = hasDev
  $('dev-content').hidden = !hasDev
  // The path answers "where do I go to work on this"; the ahead/behind counts
  // already live in the two step metas below.
  $('dev-line').innerHTML = esc(f.dev.repo || '—') + (f.dev.dirty ? flag('dirty') : '')
  lastWorktrees = f.worktrees ?? []
  forkBusy = busy
  renderWorktrees()
  $('job-main').disabled = busy || f.mainBehind === 0
  $('job-merge-deploy').disabled = busy || f.dirty || !f.clean || f.mainBehind > 0 || f.deployBehind === 0
  $('job-merge-dev').disabled = busy || !hasDev || f.dev.dirty || f.dev.behind === 0
  $('fork-promote').disabled = busy || f.dirty || f.dev.dirty || !f.dev.clean || f.dev.ahead === 0
  $('build-run').disabled = busy || !managed || f.dirty || !f.needsRebuild || pending
  $('build-deploy').disabled = busy || !managed || !f.needsDeploy || f.needsRebuild || pending

  const flow = ['job-main', 'job-merge-deploy', 'build-run', 'build-deploy']
  const currentStep = f.mainBehind > 0 ? 0
    : f.deployBehind > 0 ? 1
      : f.needsRebuild ? 2
        : f.needsDeploy ? 3
          : flow.length
  for (const [index, id] of flow.entries()) {
    const button = $(id)
    button.classList.toggle('current', index === currentStep)
    button.classList.toggle('complete', index < currentStep)
    if (index === currentStep) button.setAttribute('aria-current', 'step')
    else button.removeAttribute('aria-current')
  }

  setStepMeta('meta-main', f.mainBehind > 0 ? f.mainBehind + ' upstream' : 'synced')
  setStepMeta('meta-merge',
    !f.clean ? 'conflicts'
      : f.dirty ? 'worktree dirty'
      : f.deployBehind > 0 ? f.deployBehind + ' to merge' : 'merged',
    !f.clean || f.dirty)
  setStepMeta('meta-build',
    f.dirty ? 'worktree dirty'
      : !f.needsRebuild ? 'current'
      : f.hasBuild ? 'stale' : 'no build',
    f.dirty || f.needsRebuild)
  setStepMeta('meta-deploy',
    f.needsDeploy ? 'ready: ' + (f.built ?? '?')
      : f.deployed ? 'live @ ' + f.deployed : '—')
  setStepMeta('meta-merge-dev', f.dev.behind > 0 ? f.dev.behind + ' to merge' : 'up to date')
  setStepMeta('meta-promote',
    !f.dev.clean ? 'conflicts'
      : f.dev.dirty ? 'dev dirty'
      : f.dev.ahead > 0 ? f.dev.ahead + ' to promote' : 'nothing new',
    !f.dev.clean || f.dev.dirty)

  // The pipeline rows already say what is pending; the note speaks only when
  // something blocks them.
  $('fork-note').innerHTML = f.dirty
    ? '<span class="warn-text">Uncommitted changes</span> in ' + esc(f.repo) + '.'
    : !f.clean
      ? '<span class="bad-text">Conflicts:</span> ' + esc(f.conflicts.join(', '))
      : ''

  $('fork-dev-note').innerHTML = f.dev.dirty
    ? '<span class="warn-text">Uncommitted changes</span> in ' + esc(f.dev.repo) + '. Commit before merging.'
    : !f.dev.clean
      ? '<span class="bad-text">Conflicts:</span> ' + esc(f.dev.conflicts.join(', '))
      : ''

  const box = $('fork-commits')
  box.innerHTML = f.commits.length
    ? '<p class="sub">incoming</p>' + commitRows(f.commits)
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
    if (!r.ok) {
      // Source mode can go away (in mock mode, at a scenario switch). Give the
      // npm sections back rather than showing a stale fork.
      if (r.status === 404 && forkMode) {
        forkMode = false
        $('fork-card').hidden = true
        $('dev-card').hidden = true
        $('version-card').hidden = false
        renderVersion()
      }
      return
    }
    const f = await r.json()
    renderFork(f)
    // Re-attach after a page reload so a running build is never orphaned.
    if (f.active && !polling) pollJob(f.active)
  } catch {
    // dashboard stays useful even if the repo is temporarily unreadable
  }
}

// The running flow button gets a marker, and the activity line takes the
// colour of the outcome. Thus the sidebar shows which step is in flight, and a
// failure is visible without opening the log.
function setLogState(state) {
  document.querySelector('.log-card').dataset.state = state ?? ''
}

function markRunningJob(name) {
  for (const [id, jobName] of JOB_UI) $(id).classList.toggle('running', jobName === name)
}

function pollJob(id) {
  clearInterval(polling)
  let jobName = null
  polling = setInterval(async () => {
    try {
      const job = await (await fetch('/_dash/job/' + id)).json()
      jobName = job.name
      $('log-job').textContent = job.name + ' · ' + job.state + ' · ' + job.step
      setLogState(job.state === 'running' ? 'running' : job.state)
      markRunningJob(job.state === 'running' ? job.name : null)
      log(job.output)
      if (job.state !== 'running') {
        clearInterval(polling)
        polling = null
        refresh()
        refreshFork()
        refreshSelf()
        // The self-update's last step restarts this server moments after the
        // job reports done. In mock mode nothing restarts.
        if (job.name === 'self-update' && job.state === 'ok' && '__MOCK__' !== '1') waitForRestart()
      }
    } catch {
      clearInterval(polling)
      polling = null
      markRunningJob(null)
      // A dropped poll during a self-update is the restart itself.
      if (jobName === 'self-update') waitForRestart()
    }
  }, 1000)
}

// ---------------------------------------------------------------------------
// the dashboard's own updates
// ---------------------------------------------------------------------------

function renderSelf(s) {
  $('self-card').hidden = false
  const stale = s.behind > 0 || s.copyCurrent === false
  const btn = $('job-self-update')
  btn.classList.toggle('current', stale && !s.dirty)
  btn.classList.toggle('complete', !stale)
  btn.disabled = !stale || s.dirty || Boolean(s.active)
  setStepMeta('meta-self',
    s.dirty ? 'repo dirty'
      : s.behind > 0 ? s.behind + ' new commit(s)'
      : s.copyCurrent === false ? 'restart to apply'
      : 'up to date @ ' + (s.head ?? '—'),
    s.dirty)
  $('self-note').innerHTML = s.dirty
    ? '<span class="warn-text">Uncommitted changes</span> in ' + esc(s.repo) + '.' : ''
  const box = $('self-commits')
  box.innerHTML = s.commits.length ? commitRows(s.commits) : ''
  box.hidden = !s.commits.length
}

async function refreshSelf() {
  try {
    const r = await fetch('/_dash/self')
    if (r.ok) renderSelf(await r.json())
  } catch {
    // keep the last known state on the screen
  }
}

$('self-refresh').onclick = async (e) => {
  const btn = e.currentTarget
  btn.disabled = true
  btn.setAttribute('data-spin', '')
  try {
    const res = await fetch('/_dash/self/refresh', { method: 'POST', headers: { 'x-token': TOKEN } })
    const s = await res.json()
    if (!res.ok) throw new Error(s.error ?? 'refresh failed')
    renderSelf(s)
    log('checked for dashboard updates')
  } catch (err) {
    log('dashboard check failed: ' + err.message)
  } finally {
    btn.disabled = false
    btn.removeAttribute('data-spin')
  }
}

// The update restarts this very server. Once the job is under way, wait for
// the restart to finish and load the new page, rather than reporting the
// dropped connection as a failure.
async function waitForRestart() {
  setLogState('running')
  log('dashboard restarting…')
  let sawItGoDown = false
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const r = await fetch('/_dash/status', { cache: 'no-store' })
      if (r.ok && (sawItGoDown || attempt > 20)) return location.reload()
    } catch {
      sawItGoDown = true
    }
  }
  location.reload()
}

// Every job button, so a running job disables all of them and the page cannot
// start a second job on the same repository.
const JOB_BUTTONS = [
  'job-main', 'job-merge-deploy', 'job-merge-dev', 'fork-promote', 'build-run', 'build-deploy',
  'job-self-update',
]

async function startJob(name, branch) {
  for (const id of JOB_BUTTONS) $(id).disabled = true
  try {
    const params = new URLSearchParams({ name })
    if (branch) params.set('branch', branch)
    const res = await fetch('/_dash/job?' + params, { method: 'POST', headers: { 'x-token': TOKEN } })
    const r = await res.json()
    if (!res.ok) throw new Error(r.error ?? 'could not start')
    pollJob(r.id)
  } catch (err) {
    log('failed: ' + err.message)
    refreshFork()
  }
}

// The page's own dialog in place of the browser confirm(): same styling as the
// rest, and the message is set before the dialog opens, so Enter proceeds and
// Esc cancels as before.
function confirmAction(title, message) {
  return new Promise((resolve) => {
    const dlg = $('confirm')
    $('confirm-title').textContent = title
    $('confirm-text').textContent = message
    const done = (ok) => { dlg.close(); resolve(ok) }
    $('confirm-ok').onclick = () => done(true)
    $('confirm-cancel').onclick = () => done(false)
    dlg.oncancel = () => resolve(false)
    dlg.onclick = (e) => { if (e.target === dlg) done(false) }
    dlg.showModal()
    $('confirm-ok').focus()
  })
}

// Each message names what the job changes, and what it does not change. Only
// the deploy stops T3 Code, so only its message gives that warning. The same
// text is the button's tooltip, so you can read what a step does before you
// click it.
const JOB_UI = [
  ['job-main', 'main', 'main ← upstream',
    'Move main to upstream/main, and push main. No other branch changes.'],
  ['job-merge-deploy', 'merge-deploy', 'deploy ← main',
    'Merge main into deploy, and push deploy. This builds nothing and restarts nothing.'],
  ['job-merge-dev', 'merge-dev', 'dev ← deploy',
    'Merge deploy into dev, and push dev. This builds nothing and restarts nothing.'],
  ['fork-promote', 'promote', 'deploy ← dev',
    'Merge dev into deploy, and push deploy. This builds nothing and restarts nothing.'],
  ['build-run', 'build', 'build',
    'Build the current branch from the source. This changes no branch, and the running service stays as it is.'],
  ['build-deploy', 'deploy', 'deploy',
    'Install the current build and restart T3 Code. This stops your sessions for a short time. It compiles nothing.'],
  ['job-self-update', 'self-update', 'update dashboard',
    'Pull the latest dashboard commits and restart the dashboard. T3 Code and its sessions are not touched.'],
]
for (const [id, name, title, message] of JOB_UI) {
  $(id).title = message
  $(id).onclick = async () => {
    if (await confirmAction(title, message)) startJob(name)
  }
}

// ---------------------------------------------------------------------------
// feature worktrees
// ---------------------------------------------------------------------------

// One row per feature worktree. The branch name serves that worktree on the
// dev tab; the icons merge it into dev (staging) or promote it into deploy.
// Dev itself stays out of this list: its pipeline is the two rows below.
let lastWorktrees = []
let forkBusy = false
let servingWorktree = null

function renderWorktrees() {
  const rows = lastWorktrees.filter((w) => !w.isDev)
  const list = $('wt-list')
  list.hidden = !rows.length
  list.innerHTML = rows.map((w) => {
    const serving = servingWorktree === w.path
    const meta = [
      w.aheadDeploy + ' ahead',
      w.inDev ? 'in dev' : null,
      w.dirty ? 'dirty' : null,
      !w.clean ? 'conflicts' : null,
    ].filter(Boolean).join(' · ')
    const warn = w.dirty || !w.clean
    return '<div class="step wt' + (serving ? ' serving' : '') + '">' +
      '<span class="glyph"></span>' +
      '<button class="wt-name" data-path="' + esc(w.path) + '" data-branch="' + esc(w.branch) + '"' +
      ' title="Serve ' + esc(w.branch) + ' on the dev tab">' + esc(w.branch) + '</button>' +
      '<span class="meta' + (warn ? ' warn' : '') + '">' + esc(meta) + '</span>' +
      '<button class="icon wt-merge" data-branch="' + esc(w.branch) + '" title="Merge into dev"' +
      (forkBusy || w.inDev || !w.clean ? ' disabled' : '') + '>⇣</button>' +
      '<button class="icon wt-promote" data-branch="' + esc(w.branch) + '" title="Promote into deploy"' +
      (forkBusy || w.aheadDeploy === 0 ? ' disabled' : '') + '>⇡</button>' +
      '</div>'
  }).join('')
}

async function serveWorktree(path, branch) {
  if (devRunnerState === 'running' || devRunnerState === 'starting') {
    if (servingWorktree === path) return
    if (!(await confirmAction('dev server', 'Stop the dev server and serve ' + branch + ' instead? The dev tab reloads.'))) return
    try { await runnerAction('stop') } catch (err) { return log('dev server failed: ' + err.message) }
    await settleRunner()
  }
  try {
    await runnerAction('start', path)
    log('dev server: starting ' + branch)
  } catch (err) {
    return log('dev server failed: ' + err.message)
  }
  settleRunner()
}

$('wt-list').onclick = async (e) => {
  const serve = e.target.closest('.wt-name')
  const merge = e.target.closest('.wt-merge')
  const promote = e.target.closest('.wt-promote')
  if (serve && !serve.disabled) return serveWorktree(serve.dataset.path, serve.dataset.branch)
  if (merge && !merge.disabled) {
    const branch = merge.dataset.branch
    if (await confirmAction('dev ← ' + branch,
      'Merge ' + branch + ' into dev, and push dev. This builds nothing and restarts nothing.')) {
      startJob('merge-into-dev', branch)
    }
    return
  }
  if (promote && !promote.disabled) {
    const branch = promote.dataset.branch
    if (await confirmAction('deploy ← ' + branch,
      'Merge ' + branch + ' into deploy, and push deploy. This builds nothing and restarts nothing.')) {
      startJob('promote-branch', branch)
    }
  }
}

// ---------------------------------------------------------------------------
// dev runner and the console tabs
// ---------------------------------------------------------------------------

// The tabs choose which mounted frame is visible. The deploy console lives on
// this origin; the dev console on its own origin (its listener proxies the
// runner and nothing else), so both can be alive at once and switching is
// instant.
let devConsoleUrl = null

function showConsole(name) {
  shownConsole = name
  for (const tab of document.querySelectorAll('.tab')) {
    tab.setAttribute('aria-selected', String(tab.dataset.target === name))
  }
  applyView()
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    if (shownConsole === tab.dataset.target) return
    if (tab.dataset.target === 'dev' && !devConsoleUrl) {
      return log('the dev console has no published origin; re-run install.sh to add its Serve mapping')
    }
    showConsole(tab.dataset.target)
  }
}

let devRunnerState = 'stopped'

function renderDevRunner(r) {
  // A runner that dies before announcing its port fails silently otherwise:
  // put its output in the activity log, where Show more reveals the reason.
  if (r.state === 'failed' && devRunnerState !== 'failed' && r.error) {
    $('log-job').textContent = 'dev server · failed'
    setLogState('failed')
    log((r.output ? r.output + '\n' : '') + 'FAILED: ' + r.error)
  }
  devRunnerState = r.state
  const running = r.state === 'running'
  const busy = r.state === 'starting' || r.state === 'stopping'

  // Mark the served worktree in the list, and name the branch on the tab so
  // "DEV" always says what it is showing.
  if ((r.worktree ?? null) !== servingWorktree) {
    servingWorktree = r.worktree ?? null
    renderWorktrees()
  }
  const devTab = document.querySelector('.tab[data-target="dev"]')
  devTab.textContent = r.servingBranch && r.servingBranch !== r.branch
    ? 'dev · ' + r.servingBranch
    : 'dev'

  $('dev-runner-state').textContent = r.configured ? r.state : 'no worktree'
  $('dev-runner-dot').className = 'dot mini' +
    (running ? ' ok' : busy ? ' warn' : r.error ? ' bad' : '')
  $('dev-empty').hidden = r.configured
  $('dev-content').hidden = !r.configured
  const toggle = $('dev-runner-toggle')
  toggle.hidden = !r.configured
  toggle.disabled = busy
  toggle.textContent = r.state === 'starting' ? 'starting…'
    : r.state === 'stopping' ? 'stopping…'
    : running ? 'Stop' : 'Start'

  // While the runner operates, mount the dev console in its frame right away
  // so it loads in the background and the first switch to it is instant. The
  // page picks the origin that matches its own scheme: the published HTTPS
  // one behind Serve, or the listener's tailnet address over plain http.
  $('frame-tabs').hidden = !running
  if (running) {
    const url = location.protocol === 'https:' ? r.publicUrl : r.directUrl
    if (url && devConsoleUrl !== url) {
      devConsoleUrl = url
      $('frame-dev').src = url + '/?embed=1'
    }
  } else {
    if (shownConsole === 'dev') showConsole('deploy')
    if (devConsoleUrl) {
      devConsoleUrl = null
      $('frame-dev').src = 'about:blank'
    }
  }

  // Only a failure earns a line of text; every other state is in the heading.
  $('dev-runner-note').innerHTML = r.error
    ? '<span class="bad-text">' + esc(r.error) + '</span>' : ''
}

async function refreshDevRunner() {
  try {
    renderDevRunner(await (await fetch('/_dash/dev-runner')).json())
  } catch {
    // Keep the last known state on the screen.
  }
}

async function runnerAction(action, worktree) {
  const params = new URLSearchParams({ action })
  if (worktree) params.set('worktree', worktree)
  const res = await fetch('/_dash/dev-runner?' + params, {
    method: 'POST', headers: { 'x-token': TOKEN },
  })
  const r = await res.json()
  if (!res.ok) throw new Error(r.error ?? 'could not ' + action)
  renderDevRunner(r)
  return r
}

// Both transitions take seconds. Poll until the state settles.
async function settleRunner() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (devRunnerState !== 'starting' && devRunnerState !== 'stopping') break
    await new Promise((settle) => setTimeout(settle, 1000))
    await refreshDevRunner()
  }
}

$('dev-runner-toggle').onclick = async (e) => {
  const btn = e.currentTarget
  const action = devRunnerState === 'running' ? 'stop' : 'start'
  btn.disabled = true
  try {
    await runnerAction(action)
    log('dev server: ' + action)
    await settleRunner()
  } catch (err) {
    log('dev server failed: ' + err.message)
  } finally {
    btn.disabled = false
  }
}

// Mock mode: a scenario picker in the header switches the canned state that
// the whole page renders from. The '__MOCK__' token is filled by the server.
async function initMock() {
  if ('__MOCK__' !== '1') return
  try {
    const r = await (await fetch('/_dash/mock')).json()
    const sel = $('mock-picker')
    sel.hidden = false
    sel.innerHTML = r.scenarios.map((s) =>
      '<option' + (s === r.scenario ? ' selected' : '') + '>' + esc(s) + '</option>').join('')
    sel.onchange = async () => {
      await fetch('/_dash/mock?scenario=' + encodeURIComponent(sel.value), {
        method: 'POST', headers: { 'x-token': TOKEN },
      })
      log('mock scenario: ' + sel.value)
      refresh(); refreshFork(); refreshDevRunner(); checkUpdates()
    }
  } catch {
    // not fatal; the page still works on whatever scenario is active
  }
}
initMock()

refresh()
checkUpdates()
refreshFork()
refreshSelf()
refreshDevRunner()
loadFrame()
setInterval(refreshFork, 30000)
setInterval(refreshSelf, 60000)
setInterval(refreshDevRunner, 10000)
setInterval(refresh, 5000)
// npm registry lookup is slower and far less volatile than local service state
setInterval(checkUpdates, 15 * 60 * 1000)
</script>`

// Keep the remote-tracking refs warm so the behind-counts mean something
// without every page load paying for a network round trip.
if (REPO && !MOCK) {
  fetchRemotes()
  setInterval(fetchRemotes, 15 * 60 * 1000).unref()
}
if (HOST_REPO && !MOCK) {
  setInterval(() => gitHostOrNull('fetch', '--prune', 'origin'), 15 * 60 * 1000).unref()
}

server.on('upgrade', async (req, socket, head) => {
  proxyUpgrade(req, socket, head, await deployTarget()).catch(() => socket.destroy())
})

// The dev console's own origin. Everything here goes to the dev runner; when
// it is not running, a document gets a small page saying so instead of a
// silent fallback to the deploy build, which once served the deploy SPA's
// index.html for dev module paths and broke both consoles at once.
const DEV_UNAVAILABLE = `<!doctype html>
<meta charset="utf-8"><title>t3code dev</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin:0; height:100dvh; display:grid; place-content:center; text-align:center;
         background:#08080a; color:#8b8b93; font:13.5px/1.6 ui-monospace,Menlo,Consolas,monospace; }
  h1 { font-size:.9rem; color:#e9e9ec; margin:0 0 .5rem; }
</style>
<h1>dev server is not running</h1>
<p>Start it from the dashboard sidebar.</p>`

const devConsole = createServer((req, res) => {
  const backend = devTarget()
  if (!backend) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(DEV_UNAVAILABLE)
    }
    return json(res, 503, { error: 'the dev server is not running' })
  }
  return proxy(req, res, backend)
})
devConsole.on('upgrade', (req, socket, head) => {
  proxyUpgrade(req, socket, head, devTarget()).catch(() => socket.destroy())
})
devConsole.on('error', (err) => {
  console.error(`dev console listener failed: ${err.message}`)
})

server.listen(PORT, HOST, () => {
  console.log(`t3code dashboard on http://${HOST}:${PORT}/`)
  if (REPO) console.log(`source mode: ${REPO} (${BRANCH})`)
})
if (DEV_REPO) {
  devConsole.listen(DEV_CONSOLE_PORT, HOST, () => {
    console.log(`dev console on http://${HOST}:${DEV_CONSOLE_PORT}/`)
  })
}
