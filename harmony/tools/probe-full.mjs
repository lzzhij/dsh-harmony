// 完整复现手机路径：配对 → 拿 cookie → 抓页面 → 检查注入 → WS 升级测试
// 用法: node probe-full.mjs
import net from 'node:net'

const B = 'http://127.0.0.1:8800'
const PUB = 'http://8.137.177.104:8800'
const UA = 'Mozilla/5.0 (Phone; OpenHarmony 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 ArkWeb/6.0.0.46SP3 Mobile'
function out(s) { console.log(s) }

// 1) 开配对窗
const o = await fetch(B + '/__mbrid/pairing/open', { method: 'POST' }).then(r => r.json())
const pin = String(o.pin || '')
out('=== 1) 配对窗 pin 位数: ' + pin.length)

// 2) 配对（页面用 fetch POST /__mbrid/pair）
let cookie = ''
try {
  const r = await fetch(B + '/__mbrid/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ pin: pin })
  })
  const setc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]
  cookie = (setc || []).filter(Boolean).map(c => String(c).split(';')[0]).join('; ')
  out('=== 2) 配对 HTTP ' + r.status + '  cookie=' + (cookie ? cookie.replace(/=.*/, '=***') : '(无)'))
  const txt = await r.text()
  out('      body 前 120 字: ' + txt.replace(/\s+/g, ' ').slice(0, 120))
} catch (e) { out('=== 2) 配对异常: ' + e.message) }

// 3) 用 cookie 抓页面（手机真实路径：公网）
for (const [name, base] of [['公网', PUB], ['本地', B]]) {
  try {
    const r = await fetch(base + '/', { headers: { cookie, 'user-agent': UA } })
    const html = await r.text()
    const isPairing = html.includes('手机联动 · DSH')
    out(`=== 3) ${name} GET / → HTTP ${r.status}  长度 ${html.length}  ${isPairing ? '【配对页】' : '【DSH界面】'}`)
    if (!isPairing) {
      out('      含 __DSH_BOOT__: ' + html.includes('__DSH_BOOT__'))
      out('      含 __mbrid_mobile__(窄屏CSS): ' + html.includes('__mbrid_mobile__'))
      out('      含 __mbrid_injected__: ' + html.includes('__mbrid_injected__'))
      const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1])
      out('      script 数: ' + scripts.length)
      // 找实时端点
      const pats = [/new WebSocket\(([^)]{0,120})\)/g, /EventSource\(([^)]{0,120})\)/g, /["'`](\/[A-Za-z0-9_\-.\/]*(?:ws|stream|events|rpc|socket)[A-Za-z0-9_\-.\/]*)["'`]/gi]
      const found = new Set()
      for (const s of scripts.slice(0, 8)) {
        const u = s.startsWith('http') ? s : base + (s.startsWith('/') ? '' : '/') + s
        try {
          const js = await fetch(u, { headers: { cookie, 'user-agent': UA } }).then(x => x.text())
          for (const re of pats) { re.lastIndex = 0; let m; while ((m = re.exec(js)) !== null) { if (m[1]) found.add(String(m[1]).trim()) } }
        } catch {}
      }
      out('      实时端点候选: ' + ([...found].join('  |  ') || '(未抓到)'))
    }
  } catch (e) { out(`=== 3) ${name} 抓取异常: ` + e.message) }
}

// 4) WS 升级测试（带 cookie）
function tryUpgrade(port, path, ck) {
  return new Promise((resolve) => {
    const key = Buffer.from('probe' + Date.now() + 'xxxxxxxx').toString('base64').replace(/=/g, '').slice(0, 22) + '=='
    let raw = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    raw += `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${port}\r\n`
    if (ck) raw += `Cookie: ${ck}\r\n`
    raw += '\r\n'
    const s = net.connect(port, '127.0.0.1')
    let buf = ''
    const fin = v => { try { s.destroy() } catch {}; resolve(v) }
    s.setTimeout(5000)
    s.once('connect', () => s.write(raw))
    s.on('data', d => { buf += d.toString('latin1'); if (buf.includes('\r\n')) fin(buf.split('\r\n')[0]) })
    s.once('timeout', () => fin('TIMEOUT'))
    s.once('error', e => fin('ERR ' + e.code))
  })
}
out('')
out('=== 4) WS 升级测试（path=/）')
out('  直连桥 8800 带 cookie: ' + await tryUpgrade(8800, '/', cookie))
out('  经 shim 8899 带 cookie: ' + await tryUpgrade(8899, '/', cookie))

// 5) 最终设备数
const info = await fetch(B + '/__mbrid/info').then(r => r.json())
out('')
out('=== 5) 配对后设备数: ' + Object.keys(info.devices || {}).length)
out('  提示：这条探测设备会留下，如需清理请用 revoke 指定它的完整 id')
