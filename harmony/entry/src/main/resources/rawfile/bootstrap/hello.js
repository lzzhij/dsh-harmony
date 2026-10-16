// hello.js —— M1 阶段的最小入口：不涉及 DSH，只为证明
//   ① libnode.so 能在鸿蒙 App 里被 dlopen 并启动
//   ② ArkWeb 能打开它提供的网页
//   ③ 关键运行时能力可用（fs / http / child_process / 原生模块加载）
'use strict'
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const PORT = Number(process.env.DSH_HELLO_PORT || 5577)
const started = new Date().toISOString()

function probeNative() {
  const out = {}
  // 关键：require-builtin 的纯 JS 路径是否可用（决定要不要原生插件）
  try {
    const internal = require('internal/modules/cjs/loader')
    out.internalModules = !!internal
  } catch (e) {
    out.internalModules = 'FAILED: ' + e.message
  }
  // 若干 native 模块的加载结果（懒加载/仅 Windows 的应当失败但不应拖垮进程）
  for (const m of ['koffi', 'node-pty', 'sharp']) {
    try { require(m); out[m] = 'loaded' } catch (e) { out[m] = 'not-loaded(' + (e.code || 'ERR') + ')' }
  }
  return out
}

const facts = {
  started,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  execPath: process.execPath,
  cwd: process.cwd(),
  argv: process.argv.slice(0, 8),
  execArgv: process.execArgv,
  isSecureContextIrrelevantHere: true,
  homedir: os.homedir(),
  tmpdir: os.tmpdir(),
  jitless: process.execArgv.includes('--jitless'),
  exposeInternals: process.execArgv.includes('--expose-internals'),
  native: probeNative(),
}

try { fs.writeFileSync(path.join(os.tmpdir(), 'hello-facts.json'), JSON.stringify(facts, null, 2)) } catch (e) {}

const server = http.createServer((req, res) => {
  if (req.url === '/facts') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify(facts, null, 2))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Node on HarmonyOS ✓</title>
<style>body{background:#0f1115;color:#e6e8ec;font:14px/1.7 system-ui;padding:20px}
h1{font-size:20px;color:#4d7cfe}pre{background:#171a21;padding:12px;border-radius:8px;overflow:auto;font-size:12px}
.ok{color:#22c55e}.bad{color:#ef4444}</style></head><body>
<h1>Node.js 已在鸿蒙上运行 ✓</h1>
<p>这一页由 <b>端上 Node.js</b> 提供（libnode.so，进程内 dlopen）。</p>
<pre>${JSON.stringify(facts, null, 2)}</pre>
<p><a style="color:#4d7cfe" href="/facts">/facts</a></p>
</body></html>`)
})

server.listen(PORT, '127.0.0.1', () => {
  const line = '[hello] listening on http://127.0.0.1:' + PORT + '  node=' + process.version + ' platform=' + process.platform + ' jitless=' + facts.jitless
  console.log(line)
  try { fs.appendFileSync(path.join(os.tmpdir(), 'hello-boot.log'), line + '\n') } catch (e) {}
})