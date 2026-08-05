#!/usr/bin/env node
// Small status/control dashboard for the t3code service.
// Binds to the tailnet address, same trust boundary as t3code itself.

import { createServer } from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

const PORT = Number(process.env.T3CODE_DASH_PORT ?? 4124)
const PAIR_PORT = Number(process.env.T3CODE_PAIR_PORT ?? 443)
const UNIT = process.env.T3CODE_UNIT ?? 't3code.service'
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

async function tailnetHost() {
  try {
    const { stdout } = await run('/usr/bin/tailscale', ['ip', '-4'])
    return stdout.trim().split('\n')[0]
  } catch {
    return '127.0.0.1'
  }
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

async function status() {
  const [detail, installed, url] = await Promise.all([
    serviceDetail(),
    installedVersion(),
    publishedUrl(),
  ])
  return {
    unit: UNIT,
    active: detail.ActiveState ?? 'unknown',
    sub: detail.SubState ?? '',
    enabled: detail.UnitFileState ?? 'unknown',
    pid: detail.MainPID && detail.MainPID !== '0' ? detail.MainPID : null,
    startedAt: detail.ExecMainStartTimestamp || null,
    restarts: detail.NRestarts ?? '0',
    installed,
    url,
  }
}

async function publishedUrl() {
  try {
    const runtime = JSON.parse(
      await readFile(`${T3_HOME}/userdata/server-runtime.json`, 'utf8'),
    )
    const { stdout } = await run('/usr/bin/tailscale', ['serve', 'status', '--json'], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    const serve = JSON.parse(stdout)
    const match = Object.entries(serve.Web ?? {}).find(([, site]) =>
      Object.values(site.Handlers ?? {}).some((handler) => handler.Proxy === runtime.origin),
    )
    return match ? `https://${match[0]}` : null
  } catch {
    return null
  }
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

async function createPairingLink({ label, ttl, port }) {
  const args = ['pair', '--tailscale', '--ttl', ttl, '--tailscale-serve-port', String(port)]
  if (label) args.push('--label', label)
  const { stdout } = await run(T3_BIN, args, {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const output = stripAnsi(stdout)
  const pairingUrl = /^Pairing URL:\s*(\S+)/m.exec(output)?.[1]
  const expires = /^Expires:\s*(.+)$/m.exec(output)?.[1]?.trim() ?? null
  if (!pairingUrl) throw new Error('T3 created a link but did not return a pairing URL.')
  return { pairingUrl, expires }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function createAdministrativePairingLink({ port }) {
  // Ensure the requested public endpoint exists. This creates a one-second
  // standard link which expires before the administrative link is displayed.
  await createPairingLink({ label: 'dashboard exposure check', ttl: '1s', port })

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
      const publicBase = await publishedUrl()
      if (!publicBase) throw new Error('T3 restarted, but its Tailscale Serve URL was not found.')
      const publicUrl = new URL('/pair', publicBase)
      publicUrl.hash = new URL(localPairingUrl).hash
      return { pairingUrl: publicUrl.toString(), expires: 'approximately 5 minutes' }
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
    if (req.method === 'GET' && url.pathname === '/') {
      const html = PAGE.replace('__TOKEN__', TOKEN).replace('__PAIR_PORT__', String(PAIR_PORT))
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      })
      return res.end(html)
    }

    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204).end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, await status())
    }

    if (req.method === 'GET' && url.pathname === '/api/latest') {
      const [latest, installed] = await Promise.all([latestVersion(), installedVersion()])
      return json(res, 200, { latest, installed, upToDate: isUpToDate(installed, latest) })
    }

    if (req.method === 'GET' && url.pathname === '/api/changelog') {
      const [installed, latest] = await Promise.all([installedVersion(), latestVersion()])
      const from = url.searchParams.get('from') ?? installed
      const to = url.searchParams.get('to') ?? latest
      return json(res, 200, { from, to, releases: await changelog(from, to) })
    }

    if (req.method === 'GET' && url.pathname === '/api/fork') {
      const fork = await forkStatus()
      if (!fork) return json(res, 404, { error: 'source mode is not configured' })
      const active = activeJob && jobs.get(activeJob)?.state === 'running' ? activeJob : null
      return json(res, 200, { ...fork, commits: await incomingCommits(), active })
    }

    if (req.method === 'POST' && url.pathname === '/api/job') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })
      try {
        const job = startJob(url.searchParams.get('name'))
        return json(res, 200, { id: job.id, name: job.name })
      } catch (err) {
        return json(res, err.conflict ? 409 : 400, { error: err.message })
      }
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/job/')) {
      const job = jobs.get(url.pathname.slice('/api/job/'.length))
      if (!job) return json(res, 404, { error: 'no such job' })
      return json(res, 200, job)
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })

      const action = url.searchParams.get('name')
      const fn = ACTIONS[action]
      if (!fn) return json(res, 400, { error: `unknown action: ${action}` })

      const output = await fn()
      return json(res, 200, { ok: true, action, output: output || '(no output)' })
    }

    if (req.method === 'POST' && url.pathname === '/api/pair') {
      if (req.headers['x-token'] !== TOKEN) return json(res, 403, { error: 'bad token' })

      const label = (url.searchParams.get('label') ?? '').trim()
      const ttl = (url.searchParams.get('ttl') ?? '15m').trim()
      const port = Number(url.searchParams.get('port') ?? 443)
      if (label.length > 80) return json(res, 400, { error: 'label is too long' })
      if (!/^\d+\s*(?:s|m|h|d|seconds?|minutes?|hours?|days?)$/i.test(ttl)) {
        return json(res, 400, { error: 'invalid TTL; use values such as 15m, 1h, or 2 days' })
      }
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        return json(res, 400, { error: 'port must be between 1 and 65535' })
      }

      const administrative = url.searchParams.get('administrative') === 'true'
      const result = administrative
        ? await createAdministrativePairingLink({ port })
        : await createPairingLink({ label, ttl, port })
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
<title>t3code service</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d0d0d; color:#e8e8e8; font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
         margin:0; padding:2.5rem 1.5rem; display:flex; justify-content:center; }
  main { width:100%; max-width:640px; }
  h1 { font-size:1rem; font-weight:600; letter-spacing:.02em; margin:0 0 1.5rem; }
  .card { border:1px solid #262626; border-radius:10px; padding:1.1rem 1.25rem; margin-bottom:1rem; }
  .row { display:flex; justify-content:space-between; gap:1rem; padding:.3rem 0; }
  .row dt { color:#8a8a8a; }
  .row dd { margin:0; text-align:right; word-break:break-all; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:.5rem;
         vertical-align:middle; background:#666; }
  .ok { background:#22c55e; } .bad { background:#ef4444; } .warn { background:#f59e0b; }
  .actions { display:flex; flex-wrap:wrap; gap:.5rem; }
  button { flex:1 1 auto; min-width:110px; background:#1a1a1a; color:#e8e8e8; border:1px solid #333;
           border-radius:7px; padding:.55rem .9rem; font:inherit; cursor:pointer; }
  button:hover:not(:disabled) { background:#242424; border-color:#444; }
  button:disabled { opacity:.45; cursor:default; }
  button.danger:hover:not(:disabled) { border-color:#ef4444; color:#ef4444; }
  input { box-sizing:border-box; width:100%; background:#141414; color:#e8e8e8; border:1px solid #333;
          border-radius:7px; padding:.55rem .7rem; font:inherit; }
  .fields { display:grid; grid-template-columns:1fr 5rem 5rem; gap:.5rem; margin:.75rem 0; }
  .pair-result { margin-top:.8rem; padding-top:.8rem; border-top:1px solid #262626; }
  .pair-result a { overflow-wrap:anywhere; }
  .muted { color:#7a7a7a; font-size:.78rem; }
  pre { background:#141414; border:1px solid #232323; border-radius:7px; padding:.8rem;
        white-space:pre-wrap; word-break:break-all; color:#9a9a9a; margin:1rem 0 0; max-height:15rem;
        overflow:auto; }
  a { color:#60a5fa; }
  #notes { margin-top:1rem; border-top:1px solid #262626; padding-top:.5rem;
           max-height:22rem; overflow:auto; }
  .rel { padding:.75rem 0; border-bottom:1px solid #1c1c1c; }
  .rel:last-child { border-bottom:0; }
  .rel h3 { font-size:.82rem; margin:0 0 .15rem; font-weight:600; }
  .rel time { color:#6e6e6e; font-size:.75rem; }
  .rel ul { margin:.5rem 0 0; padding-left:1.1rem; }
  .rel li { color:#b4b4b4; margin:.2rem 0; }
  .rel .sub { color:#7a7a7a; margin:.6rem 0 .1rem; font-size:.75rem;
              text-transform:uppercase; letter-spacing:.05em; }
  .scope { color:#c084fc; }
</style>
<main>
  <h1>t3code service</h1>

  <div class="card">
    <dl id="status"><div class="row"><dt>loading…</dt><dd></dd></div></dl>
  </div>

  <div class="card">
    <div class="row" style="padding-top:0">
      <dt>version</dt>
      <dd id="version">—</dd>
    </div>
    <div class="actions" style="margin-top:.75rem">
      <button id="changelog">What's changed</button>
      <button id="update">Update &amp; restart</button>
    </div>
    <div id="notes" hidden></div>
  </div>

  <div class="card" id="fork-card" hidden>
    <div class="row" style="padding-top:0"><dt>fork</dt><dd id="fork-branch">—</dd></div>
    <dl id="fork-status"></dl>
    <div class="actions" style="margin-top:.75rem">
      <button id="fork-deploy">Sync, build &amp; deploy</button>
      <button id="fork-merge-dev">Merge dev, build &amp; deploy</button>
      <button id="fork-rebuild">Rebuild &amp; deploy</button>
    </div>
    <div id="fork-note" class="muted" style="margin-top:.6rem"></div>
    <div id="fork-dev-note" class="muted" style="margin-top:.35rem"></div>
    <div id="fork-commits" hidden></div>
  </div>

  <div class="card">
    <div class="actions">
      <button data-action="start">Start</button>
      <button data-action="restart">Restart</button>
      <button data-action="stop" class="danger">Stop</button>
    </div>
  </div>

  <div class="card">
    <div class="row" style="padding-top:0"><dt>pair a client</dt><dd>Tailscale Serve</dd></div>
    <div class="fields">
      <input id="pair-label" aria-label="Client label" placeholder="client label">
      <input id="pair-ttl" aria-label="Link lifetime" value="15m">
      <input id="pair-port" aria-label="HTTPS port" type="number" min="1" max="65535" value="__PAIR_PORT__">
    </div>
    <div class="actions">
      <button id="pair">Create client link</button>
      <button id="pair-admin">Create administrator link</button>
    </div>
    <div class="muted" style="margin-top:.6rem">Administrator links restart T3 and grant access management.</div>
    <div id="pair-result" class="pair-result" hidden></div>
  </div>

  <pre id="log">ready</pre>
</main>
<script>
const TOKEN = '__TOKEN__'
const $ = (id) => document.getElementById(id)
const log = (msg) => { $('log').textContent = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2) }

function dotClass(active) {
  if (active === 'active') return 'ok'
  if (active === 'failed') return 'bad'
  return 'warn'
}

async function refresh() {
  const s = await (await fetch('/api/status')).json()
  const serviceUrl = s.url
    ? '<a href="' + esc(s.url) + '">' + esc(s.url) + '</a>'
    : '<span class="muted">not published</span>'
  $('status').innerHTML = [
    ['state', '<span class="dot ' + dotClass(s.active) + '"></span>' + s.active + (s.sub ? ' (' + s.sub + ')' : '')],
    ['unit', s.enabled],
    ['pid', s.pid ?? '—'],
    ['started', s.startedAt ?? '—'],
    ['restarts', s.restarts],
    ['url', serviceUrl],
  ].map(([k, v]) => '<div class="row"><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('')
  installed = s.installed
  renderVersion()
}

let installed = null, latest = null, upToDate = null

function renderVersion() {
  if (!installed) return
  if (!latest) { $('version').textContent = installed; return }
  const current = upToDate ?? latest === installed
  $('version').innerHTML = current
    ? installed + ' <span style="color:#6e6e6e">(latest)</span>'
    : installed + ' <span style="color:#f59e0b">&rarr; ' + latest + '</span>'
  // Source mode owns the installed binary; the npm button stays out of it.
  if (forkMode) return
  $('update').disabled = current
  $('update').textContent = current ? 'Up to date' : 'Update & restart'
}

async function checkUpdates() {
  try {
    const r = await (await fetch('/api/latest')).json()
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
    port: $('pair-port').value,
    administrative: String(administrative),
  })
  btn.disabled = true
  btn.textContent = 'creating…'
  try {
    const response = await fetch('/api/pair?' + params, {
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
  const buttons = [...document.querySelectorAll('button')]
  buttons.forEach((b) => (b.disabled = true))
  const label = btn.textContent
  btn.textContent = '…'
  try {
    const res = await fetch('/api/action?name=' + name, { method: 'POST', headers: { 'x-token': TOKEN } })
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

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

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
    const r = await (await fetch('/api/changelog')).json()
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
  $('fork-status').innerHTML = [
    ['checked out', esc(f.checkedOut ?? '—') + (f.dirty ? ' <span style="color:#f59e0b">(dirty)</span>' : '')],
    ['main behind upstream', String(f.mainBehind)],
    [f.branch + ' behind main', String(f.deployBehind)],
    [f.dev.branch + ' ahead / behind ' + f.branch, String(f.dev.ahead) + ' / ' + String(f.dev.behind)],
    ['development worktree', esc(f.dev.repo) + (f.dev.dirty ? ' <span style="color:#f59e0b">(dirty)</span>' : '')],
    ['built', f.built ? esc(f.built) + (f.needsRebuild ? ' <span style="color:#f59e0b">(stale)</span>' : '') : '—'],
  ].map(([k, v]) => '<div class="row"><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('')

  const pending = f.mainBehind > 0 || f.deployBehind > 0
  const blocked = f.dirty || !f.clean
  $('fork-deploy').disabled = blocked || !pending || Boolean(f.active)
  $('fork-merge-dev').disabled = f.dirty || f.dev.dirty || !f.dev.clean || f.dev.ahead === 0 || Boolean(f.active)
  $('fork-rebuild').disabled = f.dirty || Boolean(f.active)

  $('fork-note').innerHTML = f.dirty
    ? 'Worktree has uncommitted changes. Resolve them in ' + esc(f.repo) + ' first.'
    : !f.clean
      ? '<span style="color:#ef4444">Conflicts — merge by hand:</span> ' + esc(f.conflicts.join(', '))
      : pending
        ? f.mainBehind + ' upstream commit(s) ready to merge and deploy.'
        : f.needsRebuild
          ? 'Up to date with upstream, but the deployed build is older than the branch tip.'
          : 'Up to date with upstream.'

  $('fork-dev-note').innerHTML = f.dev.dirty
    ? 'Development changes are safe in ' + esc(f.dev.repo) + '. Commit them before merging into ' + esc(f.branch) + '.'
    : !f.dev.clean
      ? '<span style="color:#ef4444">Dev merge conflicts — resolve in the dev worktree:</span> ' + esc(f.dev.conflicts.join(', '))
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
    const r = await fetch('/api/fork')
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
      const job = await (await fetch('/api/job/' + id)).json()
      $('log').textContent = '[' + job.state + '] ' + job.step + '\n\n' + job.output
      $('log').scrollTop = $('log').scrollHeight
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
    const res = await fetch('/api/job?name=' + name, { method: 'POST', headers: { 'x-token': TOKEN } })
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

const host = await tailnetHost()
server.listen(PORT, host, () => {
  console.log(`t3code dashboard on http://${host}:${PORT}`)
  if (REPO) console.log(`source mode: ${REPO} (${BRANCH})`)
})
