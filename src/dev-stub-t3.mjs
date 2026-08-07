// A substitute for T3 Code, for work on the dashboard alone.
//
// The dashboard is a proxy in front of T3 Code. Thus it needs a server on the
// other side. Without one, each request through the proxy gives an HTTP 502.
// This server sends a placeholder page. The page gives the name of the side of
// the proxy that you see. An empty page cannot give you this data.
//
// The server prints its port in the format of the dev runner. Thus dev.sh
// reads the port in the same way for the two backends.
import { createServer } from 'node:http'

const HOST = process.env.T3CODE_STUB_HOST ?? '127.0.0.1'
// This label gives the name of the stub that answered. Thus you can show that
// a proxy changed to a different backend.
const LABEL = process.env.T3CODE_STUB_LABEL ?? ''
const PORT = Number(process.env.T3CODE_STUB_PORT ?? 0)

const PAGE = `<!doctype html>
<meta charset="utf-8">
<!-- This marker does not change. check.sh uses it to find the difference
     between this page and the console. The console has an <html lang="en">
     document. -->
<meta name="t3code-stub" content="__LABEL__">
<title>T3 Code (stub)</title>
<style>
  html { color-scheme: light dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.6 system-ui, sans-serif; text-align: center }
  main { max-width: 34rem; padding: 2rem }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem }
  p { margin: .5rem 0; opacity: .75 }
  code { font-size: .9em }
</style>
<main>
  <h1>T3 Code stub__LABEL__</h1>
  <p>The dashboard's proxy reached this placeholder, not the real console.</p>
  <p>Start the dev server from the production dashboard to serve T3 Code from
     the fork's source instead.</p>
</main>
`

const PAGE_HTML = PAGE
  .replace('content="__LABEL__"', `content="${LABEL || 'stub'}"`)
  .replace('__LABEL__', LABEL ? ` (${LABEL})` : '')

const server = createServer((req, res) => {
  // A request that looks like an API call gets JSON. Thus a fetch in the
  // dashboard gets a correct response, and it does not try to read HTML.
  if (req.url?.startsWith('/api/') || req.url?.startsWith('/ws')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ stub: true, label: LABEL, path: req.url }))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(PAGE_HTML)
})

// The console opens a WebSocket. This server has no WebSocket. Thus close the
// socket correctly. Do not leave the upgrade of the dashboard without an
// answer.
server.on('upgrade', (_req, socket) => {
  socket.end('HTTP/1.1 501 Not Implemented\r\n\r\n')
})

server.listen(PORT, HOST, () => {
  const { port } = server.address()
  console.log(`[dev-runner] stub webPort=${port} baseDir=${process.env.T3CODE_STUB_HOME ?? ''}`)
})
