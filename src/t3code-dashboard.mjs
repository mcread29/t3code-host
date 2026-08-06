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
const SESSION_FILE = `${STATE_DIR}/proxy-session`
let sessionToken = null

async function mintSessionToken() {
  const args = ['auth', 'session', 'issue', '--ttl', '30d', '--label', 'dashboard proxy', '--token-only']
  if (T3_HOME) args.push('--base-dir', T3_HOME)
  const { stdout } = await run(T3_BIN, args, { timeout: 30_000 })
  const token = stripAnsi(stdout).trim().split('\n').filter(Boolean).pop()?.trim()
  if (!token) throw new Error('t3 issued no token')
  await mkdir(STATE_DIR, { recursive: true }).catch(() => {})
  await writeFile(SESSION_FILE, token, { mode: 0o600 }).catch(() => {})
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

async function proxySession(origin) {
  if (sessionToken) return sessionToken
  const stored = await readFile(SESSION_FILE, 'utf8').catch(() => null)
  if (stored?.trim() && (await tokenWorks(stored.trim(), origin))) {
    sessionToken = stored.trim()
    return sessionToken
  }
  try {
    sessionToken = await mintSessionToken()
  } catch {
    // Without a token the console still works, just with whatever the browser
    // paired for itself. Better than refusing to proxy at all.
    sessionToken = null
  }
  return sessionToken
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
  const origin = await t3Origin()
  if (!origin) {
    return json(res, 503, { error: 'T3 Code is not running, so there is nothing to proxy.' })
  }
  const token = await proxySession(origin)
  const target = new URL(req.url, origin)
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
  const origin = await t3Origin()
  if (!origin) return clientSocket.destroy()

  const token = await proxySession(origin)
  const target = new URL(req.url, origin)
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

async function createPairingLink({ label, ttl }) {
  const args = ['pair', '--ttl', ttl]
  if (label) args.push('--label', label)
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
  step(`merge main into ${BRANCH}`, async (job) => {
    try {
      await exec(job, 'git', ['-C', REPO, 'merge', '--no-ff', '--no-edit', 'main'])
    } catch (err) {
      // The preview said clean, so reaching here means the tree moved under
      // us. Back out completely rather than leave a half-merged worktree.
      const conflicts = await gitOrNull('diff', '--name-only', '--diff-filter=U')
      await gitOrNull('merge', '--abort')
      throw new Error(`merge conflicted, aborted. Resolve by hand: ${conflicts || err.message}`)
    }
  }),
]

const MERGE_DEV_STEPS = [
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
  step(`merge ${DEV_BRANCH} into ${BRANCH}`, async (job) => {
    try {
      await exec(job, 'git', ['-C', REPO, 'merge', '--no-ff', '--no-edit', DEV_BRANCH])
    } catch (err) {
      const conflicts = await gitOrNull('diff', '--name-only', '--diff-filter=U')
      await gitOrNull('merge', '--abort')
      throw new Error(`merge conflicted, aborted. Resolve in ${DEV_REPO}: ${conflicts || err.message}`)
    }
  }),
]

const PUSH_STEP = [
  step(`push ${BRANCH}`, (job) => exec(job, 'git', ['-C', REPO, 'push', 'origin', BRANCH])),
]

const JOBS = {
  'sync-build-deploy': [...SYNC_STEPS, ...BUILD_STEPS, ...DEPLOY_STEPS, ...PUSH_STEP],
  'merge-dev-deploy': [...MERGE_DEV_STEPS, ...BUILD_STEPS, ...DEPLOY_STEPS, ...PUSH_STEP],
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

      const administrative = url.searchParams.get('administrative') === 'true'
      const result = administrative
        ? await createAdministrativePairingLink()
        : await createPairingLink({ label, ttl })
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

  .side {
    min-width:0; overflow-y:auto; overflow-x:hidden;
    border-right:1px solid var(--line);
    background:linear-gradient(180deg,#0e0e10,#0a0a0b 240px);
    display:flex; flex-direction:column;
    transition:opacity .2s ease;
    scrollbar-width:thin; scrollbar-color:#2a2a2f transparent;
  }
  .side::-webkit-scrollbar { width:9px; }
  .side::-webkit-scrollbar-thumb { background:#25252a; border-radius:9px; border:2px solid var(--bg); }
  .side-body { padding:0 1.1rem 1.1rem; display:flex; flex-direction:column; gap:.85rem; flex:1; }

  .stage { min-width:0; display:flex; flex-direction:column; background:#08080a; }

  /* brand ----------------------------------------------------------------- */
  .brand {
    position:sticky; top:0; z-index:5;
    padding:1.1rem 1.1rem .9rem;
    background:linear-gradient(180deg,#101013 70%,rgba(16,16,19,0));
    display:flex; align-items:center; gap:.6rem;
  }
  .mark {
    width:26px; height:26px; border-radius:7px; flex:none;
    background:linear-gradient(140deg,#1e3a4a,#0f1a20);
    border:1px solid #2b4655; color:var(--accent);
    display:grid; place-items:center; font-size:.72rem; font-weight:700; letter-spacing:-.02em;
  }
  .brand h1 { font-size:.86rem; font-weight:600; letter-spacing:.04em; margin:0; text-transform:uppercase; }
  .brand .sub { font-size:.68rem; color:var(--faint); letter-spacing:.06em; }

  /* cards ----------------------------------------------------------------- */
  .card {
    border:1px solid var(--line); border-radius:12px; background:var(--panel);
    padding:.9rem 1rem 1rem;
    box-shadow:0 1px 0 rgba(255,255,255,.02) inset, 0 8px 24px -18px #000;
  }
  .card > h2 {
    font-size:.68rem; font-weight:600; letter-spacing:.11em; text-transform:uppercase;
    color:var(--faint); margin:0 0 .7rem; display:flex; align-items:center; gap:.5rem;
  }
  .card > h2 .tag { margin-left:auto; text-transform:none; letter-spacing:0; color:var(--dim); font-weight:400; }

  .row { display:flex; justify-content:space-between; gap:1rem; padding:.22rem 0; font-size:.8rem; }
  .row dt { color:var(--dim); white-space:nowrap; }
  .row dd { margin:0; text-align:right; word-break:break-all; color:#d4d4d8; }
  dl { margin:0; }

  /* status ---------------------------------------------------------------- */
  .state {
    display:flex; align-items:center; gap:.6rem; padding:.15rem 0 .75rem;
    margin-bottom:.6rem; border-bottom:1px solid var(--line-soft);
  }
  .state .label { font-size:.95rem; letter-spacing:.01em; }
  .state .meta { margin-left:auto; font-size:.72rem; color:var(--faint); }
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
  button {
    flex:1 1 auto; min-width:104px; background:var(--raised); color:var(--text);
    border:1px solid #2c2c31; border-radius:8px; padding:.5rem .8rem;
    font:inherit; font-size:.78rem; cursor:pointer;
    transition:background .12s ease, border-color .12s ease, color .12s ease, transform .06s ease;
  }
  button:hover:not(:disabled) { background:#1d1d21; border-color:#3d3d44; }
  button:active:not(:disabled) { transform:translateY(1px); }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  button:disabled { opacity:.35; cursor:default; }
  button.primary { background:#12242c; border-color:#2b4a5a; color:#bae6fd; }
  button.primary:hover:not(:disabled) { background:#173039; border-color:#3d6478; }
  button.danger:hover:not(:disabled) { border-color:#5c2a2a; color:var(--red); background:#1d1315; }
  button.icon { flex:0 0 auto; min-width:0; padding:.4rem .6rem; font-size:.75rem; }

  input {
    width:100%; background:#0c0c0e; color:var(--text); border:1px solid #2a2a2f;
    border-radius:8px; padding:.5rem .65rem; font:inherit; font-size:.78rem;
    transition:border-color .12s ease;
  }
  input::placeholder { color:#55555c; }
  input:focus { outline:none; border-color:#3d6478; box-shadow:0 0 0 3px rgba(125,211,252,.08); }
  .fields { display:grid; grid-template-columns:1fr 5rem; gap:.45rem; margin:0 0 .6rem; }

  .muted { color:var(--faint); font-size:.73rem; line-height:1.55; }
  .note { font-size:.75rem; line-height:1.6; margin-top:.65rem; color:var(--dim); }
  .note .bad-text { color:var(--red); }
  .note .warn-text { color:var(--amber); }

  .pair-result { margin-top:.75rem; padding-top:.75rem; border-top:1px solid var(--line-soft); }
  .pair-result a { overflow-wrap:anywhere; font-size:.76rem; }

  /* log ------------------------------------------------------------------- */
  .log-card { padding:0; overflow:hidden; display:flex; flex-direction:column; }
  .log-head {
    display:flex; align-items:center; gap:.5rem; padding:.55rem .8rem;
    border-bottom:1px solid var(--line-soft); background:#0c0c0e;
    font-size:.68rem; letter-spacing:.11em; text-transform:uppercase; color:var(--faint);
  }
  .log-head .job { text-transform:none; letter-spacing:0; color:var(--dim); margin-left:auto; }
  pre#log {
    margin:0; padding:.75rem .8rem; white-space:pre-wrap; word-break:break-word;
    color:#9d9da5; font-size:.73rem; line-height:1.55; max-height:16rem; overflow:auto;
    background:#0b0b0d;
  }
  pre#log::-webkit-scrollbar { width:9px; }
  pre#log::-webkit-scrollbar-thumb { background:#25252a; border-radius:9px; border:2px solid #0b0b0d; }

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
  .bar {
    display:flex; align-items:center; gap:.5rem; padding:.5rem .7rem;
    border-bottom:1px solid var(--line); background:#0d0d0f; flex:none;
  }
  .bar .url {
    flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    font-size:.74rem; color:var(--dim); padding:.3rem .6rem;
    background:#0a0a0b; border:1px solid var(--line-soft); border-radius:7px;
  }
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
      <div class="mark">T3</div>
      <div>
        <h1>t3code</h1>
        <div class="sub">service control</div>
      </div>
    </div>

    <div class="side-body">
      <section class="card">
        <div class="state">
          <span class="dot" id="state-dot"></span>
          <span class="label" id="state-label">loading…</span>
          <span class="meta" id="state-meta"></span>
        </div>
        <dl id="status"></dl>
        <div class="actions" style="margin-top:.8rem">
          <button data-action="start">Start</button>
          <button data-action="restart">Restart</button>
          <button data-action="stop" class="danger">Stop</button>
        </div>
      </section>

      <section class="card">
        <h2>version <span class="tag" id="version">—</span></h2>
        <div class="actions">
          <button id="changelog">What's changed</button>
          <button id="update">Update &amp; restart</button>
        </div>
        <div id="notes" hidden></div>
      </section>

      <section class="card" id="fork-card" hidden>
        <h2>fork <span class="tag" id="fork-branch">—</span></h2>
        <dl id="fork-status"></dl>
        <div class="actions" style="margin-top:.8rem">
          <button id="fork-deploy" class="primary">Sync, build &amp; deploy</button>
          <button id="fork-merge-dev">Merge dev &amp; deploy</button>
          <button id="fork-rebuild">Rebuild &amp; deploy</button>
        </div>
        <div id="fork-note" class="note"></div>
        <div id="fork-dev-note" class="note" style="margin-top:.3rem"></div>
        <div id="fork-commits" hidden></div>
      </section>

      <section class="card">
        <h2>pair a client <span class="tag">Tailscale Serve</span></h2>
        <div class="fields">
          <input id="pair-label" aria-label="Client label" placeholder="client label">
          <input id="pair-ttl" aria-label="Link lifetime" value="15m">
        </div>
        <div class="actions">
          <button id="pair">Client link</button>
          <button id="pair-admin">Administrator link</button>
        </div>
        <div class="muted" style="margin-top:.55rem">Administrator links restart T3 and grant access management.</div>
        <div id="pair-result" class="pair-result" hidden></div>
      </section>

      <section class="card log-card" style="margin-top:auto">
        <div class="log-head">activity <span class="job" id="log-job"></span></div>
        <pre id="log">ready</pre>
      </section>
    </div>
  </aside>

  <main class="stage">
    <div class="bar">
      <button id="collapse" class="icon" title="Toggle sidebar" aria-label="Toggle sidebar">☰</button>
      <span class="url" id="frame-url">not published</span>
      <button id="frame-reload" class="icon" title="Reload">⟳</button>
      <button id="frame-open" class="icon" title="Open in a new tab">↗</button>
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
const log = (msg) => { $('log').textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2) }

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
  const serviceUrl = s.url
    ? '<a href="' + esc(s.url) + '" target="_blank" rel="noreferrer">' + esc(s.url) + '</a>'
    : '<span class="muted">not published</span>'

  managed = s.managed !== false
  if (!managed) {
    for (const b of document.querySelectorAll('[data-action]')) b.disabled = true
    $('update').disabled = true
    $('update').textContent = 'Managed by dev server'
  }

  $('state-dot').className = 'dot ' + dotClass(s.active)
  $('state-label').textContent = s.active + (s.sub && s.sub !== s.active ? ' · ' + s.sub : '')
  $('state-meta').textContent = s.active === 'active' ? uptime(s.startedAt) : s.enabled

  $('status').innerHTML = [
    ['unit', esc(s.unit)],
    ['enabled', esc(s.enabled)],
    ['pid', s.pid ?? '—'],
    ['restarts', esc(s.restarts)],
    ['dashboard', serviceUrl],
    ['t3code', s.origin ? esc(s.origin) : '<span class="muted">not running</span>'],
  ].map(([k, v]) => '<div class="row"><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('')

  setFrameUrl()
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

// The frame is always this origin's root -- T3 is reached through the proxy.
function setFrameUrl() {
  $('frame-url').textContent = location.origin + '/'
}

// ?embed=1 makes the root serve the console rather than this page.
const openFrame = () => window.open('/?embed=1', '_blank')
$('frame-open').onclick = openFrame
$('frame-open-2').onclick = openFrame
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

async function createPairing(administrative = false) {
  const btn = administrative ? $('pair-admin') : $('pair')
  const box = $('pair-result')
  const params = new URLSearchParams({
    label: $('pair-label').value,
    ttl: $('pair-ttl').value,
    administrative: String(administrative),
  })
  btn.disabled = true
  btn.textContent = 'creating…'
  try {
    const response = await fetch('/_dash/pair?' + params, {
      method: 'POST',
      headers: { 'x-token': TOKEN },
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? 'pairing failed')
    box.innerHTML = '<a id="pair-link" href="' + esc(result.pairingUrl) + '">' +
      esc(result.pairingUrl) + '</a>' +
      (result.expires ? '<div class="muted">expires ' + esc(result.expires) + '</div>' : '') +
      '<div class="actions" style="margin-top:.6rem"><button id="copy-pair">Copy link</button></div>'
    box.hidden = false
    $('copy-pair').onclick = async () => {
      try {
        await navigator.clipboard.writeText(result.pairingUrl)
        $('copy-pair').textContent = 'Copied'
      } catch {
        const range = document.createRange()
        range.selectNodeContents($('pair-link'))
        window.getSelection().removeAllRanges()
        window.getSelection().addRange(range)
        $('copy-pair').textContent = 'Selected—copy manually'
      }
    }
    refresh()
  } catch (err) {
    box.textContent = 'failed: ' + err.message
    box.hidden = false
  } finally {
    btn.disabled = false
    btn.textContent = administrative ? 'Create administrator link' : 'Create client link'
  }
}

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
$('pair').onclick = () => createPairing(false)
$('pair-admin').onclick = () => {
  if (confirm('Restart T3 and create a short-lived link with full administrative access?')) {
    createPairing(true)
  }
}

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

function renderFork(f) {
  $('fork-card').hidden = false
  forkMode = true
  // In source mode the npm update would overwrite the build from your fork.
  $('update').disabled = true
  $('update').textContent = 'Managed by fork'

  $('fork-branch').textContent = f.branch + ' @ ' + (f.tip ?? '—')
  const flag = (text) => ' <span style="color:var(--amber)">(' + text + ')</span>'
  $('fork-status').innerHTML = [
    ['checked out', esc(f.checkedOut ?? '—') + (f.dirty ? flag('dirty') : '')],
    ['main behind upstream', String(f.mainBehind)],
    [f.branch + ' behind main', String(f.deployBehind)],
    [f.dev.branch + ' ahead / behind', String(f.dev.ahead) + ' / ' + String(f.dev.behind)],
    ['dev worktree', esc((f.dev.repo || '—').split('/').pop()) + (f.dev.dirty ? flag('dirty') : '')],
    ['built', f.built ? esc(f.built) + (f.needsRebuild ? flag('stale') : '') : '—'],
  ].map(([k, v]) => '<div class="row"><dt>' + esc(k) + '</dt><dd>' + v + '</dd></div>').join('')

  const pending = f.mainBehind > 0 || f.deployBehind > 0
  const blocked = f.dirty || !f.clean || !managed
  $('fork-deploy').disabled = blocked || !pending || Boolean(f.active)
  $('fork-merge-dev').disabled = !managed || f.dirty || f.dev.dirty || !f.dev.clean || f.dev.ahead === 0 || Boolean(f.active)
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
        ? f.dev.ahead + ' committed dev change(s) ready to merge.'
        : 'No committed dev changes to merge.'

  const box = $('fork-commits')
  box.innerHTML = f.commits.length
    ? '<div class="rel"><p class="sub">incoming</p><ul>' +
      f.commits.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul></div>'
    : ''
  box.hidden = !f.commits.length
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
      const pinned = $('log').scrollTop + $('log').clientHeight >= $('log').scrollHeight - 40
      $('log-job').textContent = job.name + ' · ' + job.state + ' · ' + job.step
      $('log').textContent = job.output
      if (pinned) $('log').scrollTop = $('log').scrollHeight
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
  $('fork-merge-dev').disabled = true
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
  if (confirm('Merge upstream, rebuild from source, and restart the service?')) {
    startJob('sync-build-deploy')
  }
}
$('fork-rebuild').onclick = () => {
  if (confirm('Rebuild from the current branch and restart the service?')) startJob('rebuild')
}
$('fork-merge-dev').onclick = () => {
  if (confirm('Merge committed dev changes into deploy, rebuild, and restart the service?')) {
    startJob('merge-dev-deploy')
  }
}

refresh()
checkUpdates()
refreshFork()
loadFrame()
setInterval(refreshFork, 30000)
setInterval(refresh, 5000)
// npm registry lookup is slower and far less volatile than local service state
setInterval(checkUpdates, 15 * 60 * 1000)
</script>`

// Keep the remote-tracking refs warm so the behind-counts mean something
// without every page load paying for a network round trip.
if (REPO) {
  const fetchRemotes = () => {
    if (activeJob && jobs.get(activeJob)?.state === 'running') return
    gitOrNull('fetch', '--prune', '--multiple', 'origin', 'upstream')
  }
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
