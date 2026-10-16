#!/usr/bin/env node
// assemble-resfile.mjs —— 按 ohos-runtime.json 从 DSH 的 app.asar 里抽取文件，
//                          组装成鸿蒙工程要打包的 resfile 载荷（M2 的核心步骤）
//
// 用法:
//   node tools/assemble-resfile.mjs <app.asar> <ohos-runtime.json> <输出目录> [--overlay <overlay目录>] [--dry]
//
// 例:
//   node tools/assemble-resfile.mjs "F:/deepseek-harnees/resources/app.asar" dist/ohos-runtime.json \
//        harmony/entry/src/main/resources/resfile/dsh --overlay dist/ohos-overlay
//
// 做的事:
//   ① 读 asar 头部，建立 path → {offset,size} 索引
//   ② 按清单里的 files[] 逐个抽取（路径前缀 dsh/ 由 --asar-prefix 指定，默认 dsh/）
//   ③ 施加 overlay（覆盖同路径文件，例如 node-addon-require-builtin 的纯 JS 桩）
//   ④ 生成 launch.json（入口脚本 + 启动参数），供 ArkTS 侧读取
//   ⑤ 校验：文件数/字节数与清单一致、关键文件存在、无二进制混入
import fs from 'node:fs'
import path from 'node:path'

const [asarPath, manifestPath, outDir] = process.argv.slice(2)
const argv = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const asarPrefix = flag('--asar-prefix', 'dsh/')
const overlayDir = flag('--overlay', null)
const dry = argv.includes('--dry')

if (!asarPath || !manifestPath || !outDir || !fs.existsSync(asarPath) || !fs.existsSync(manifestPath)) {
  console.error('用法: node tools/assemble-resfile.mjs <app.asar> <ohos-runtime.json> <输出目录> [--overlay <目录>] [--asar-prefix dsh/] [--dry]')
  process.exit(2)
}

const MB = (n) => (n / 1048576).toFixed(1) + ' MB'

// ---------- 1) asar 索引 ----------
const fd = fs.openSync(asarPath, 'r')
const hdr = Buffer.alloc(16)
fs.readSync(fd, hdr, 0, 16, 0)
const jsonLen = hdr.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const baseOffset = 16 + jsonLen
const root = JSON.parse(jsonBuf.toString('utf8'))

const index = new Map()
;(function walk(node, prefix) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (child.files) walk(child, p)
    // ★ asar 的 offset/size 在 JSON 里可能是字符串，必须转数字
    // ★★ unpacked：内容不在 asar 内，而在 <asar>.unpacked/<同路径> 下
    else index.set(p, { size: Number(child.size || 0), offset: Number(child.offset || 0), unpacked: !!child.unpacked })
  }
})(root, '')

// ---------- 2) 清单 ----------
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const files = manifest.files || []
console.log('asar 索引条目: ' + index.size)
console.log('清单要求文件: ' + files.length + '  ' + MB(files.reduce((a, f) => a + (f.bytes || 0), 0)))

// ---------- 3) 抽取 ----------
let written = 0, bytes = 0, missing = 0, sizeMismatch = 0
const missingList = []
const mismatchList = []
if (!dry) fs.mkdirSync(outDir, { recursive: true })

for (const f of files) {
  const src = asarPrefix + f.path
  const e = index.get(src)
  if (!e) {
    missing++
    if (missingList.length < 10) missingList.push(src)
    continue
  }
  if (dry) { written++; bytes += e.size; continue }
  const dest = path.join(outDir, f.path)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  let buf
  if (e.unpacked) {
    // ★ 内容在 <asar>.unpacked/ 下（整个被 unpack 的子目录很常见，如 @swc/helpers、fflate）
    const src2 = path.join(asarPath + '.unpacked', src)
    if (!fs.existsSync(src2)) { missing++; if (missingList.length < 10) missingList.push('UNPACKED-MISSING ' + src); continue }
    buf = fs.readFileSync(src2)
    if (buf.length !== e.size) { sizeMismatch++; if (mismatchList.length < 6) mismatchList.push(src + ' 磁盘' + buf.length + ' vs 声明' + e.size) }
  } else {
    buf = Buffer.alloc(e.size)
    fs.readSync(fd, buf, 0, e.size, baseOffset + e.offset)
  }
  fs.writeFileSync(dest, buf)
  written++; bytes += e.size
}

console.log('已抽取: ' + written + ' 个文件  ' + MB(bytes) + (dry ? '（dry-run，未落盘）' : ''))
if (sizeMismatch) { console.log('!! 有 ' + sizeMismatch + ' 个 unpacked 文件与声明大小不符:'); for (const m of mismatchList) console.log('     ' + m) }
if (missing) {
  console.log('!! 清单里有 ' + missing + ' 个文件在 asar 中找不到，例如:')
  for (const m of missingList) console.log('     ' + m)
}

// ---------- 4) overlay（覆盖/新增）----------
let overlayCount = 0
if (overlayDir && fs.existsSync(overlayDir) && !dry) {
  const walkOverlay = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const r = rel ? rel + '/' + name : name
      if (fs.statSync(p).isDirectory()) walkOverlay(p, r)
      else {
        const dest = path.join(outDir, r)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(p, dest)
        overlayCount++
        console.log('  overlay: ' + r)
      }
    }
  }
  walkOverlay(overlayDir, '')
}
console.log('overlay 覆盖/新增: ' + overlayCount + ' 个')

// ---------- 5) launch.json ----------
const entryRel = 'node_modules/@deepseek-ai/dsh/lib/bin.js'
// ★ V1 已在 PC 上实测跑通（纯 Node、无 Electron），并暴露三件事，这里全部固化：
//   ① DSH web 启动时会在 stdout 打印完整 URL，形如：
//        dsh web: http://127.0.0.1:3080/?token=<每 run 随机>
//      ⇒ 端口不要猜，从日志解析；本机实测端口是 3080
//   ② 该 URL 带 token，**不带 token 的请求返回 401** ⇒ WebView 必须加载【带 token 的完整 URL】
//   ③ 需要 --no-open，否则它会尝试拉起浏览器
const launch = {
  note: 'M2 入口：由 ArkTS 侧把 script/args 交给 nodeCtl.startBackend()',
  scriptRelative: entryRel,
  args: ['web', '--no-open'],
  env: { UV_USE_IO_URING: '0', NODE_ENV: 'production' },
  hostArgv: ['--expose-internals', '--jitless', '--no-verify-heap'],
  dataSubdir: 'dsh-harmony-data',
  observed: {
    verifiedOn: 'PC / Node v24.21.0 / 纯 Node（无 Electron）',
    stdoutLineExample: 'dsh web: http://127.0.0.1:3080/?token=<random>',
    port: 3080,
    tokenRequired: true,
    noTokenStatus: 401,
    withTokenStatus: 303,
    writesToDshHome: ['.anonymous-user-id', '.credentials.yaml', 'profiles/web/*', 'storages/workspace.json'],
    note: 'WebView 必须加载日志里那条【完整 URL】（含 ?token=）；探测端口时 401/303 都算“服务已起”',
  },
  expectHttp: { host: '127.0.0.1', note: '逐次从 node-stdout.log 解析完整 URL（含 token），端口不写死' },
  disabledPlugins: (manifest.disabledPlugins || []).map((d) => d.name),
}
if (!dry) {
  fs.writeFileSync(path.join(outDir, '..', 'launch.json'), JSON.stringify(launch, null, 2))
}

// ---------- 6) 校验 ----------
const checks = []
const add = (ok, name, detail) => checks.push({ ok: !!ok, name, detail })
add(missing === 0, '清单里每个文件都能在 asar 中找到', missing ? missing + ' 个缺失' : '0 个缺失')
add(dry || written === files.length, '抽取数量与清单一致', written + ' / ' + files.length)
add(dry || overlayCount >= 1 || !overlayDir, 'overlay 已施加（JS 桩）', overlayCount + ' 个')
if (!dry) {
  const entry = path.join(outDir, entryRel)
  add(fs.existsSync(entry), 'DSH 入口脚本存在: ' + entryRel, fs.existsSync(entry) ? '✓' : '缺失')
  const shim = path.join(outDir, 'node_modules/node-addon-require-builtin/lib/index.js')
  if (fs.existsSync(shim)) {
    const s = fs.readFileSync(shim, 'utf8')
    add(s.includes('js-shim') || s.includes('module.exports.default'), 'require-builtin 已是纯 JS 桩', '✓')
  }
  const feIdx = path.join(outDir, 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html')
  add(fs.existsSync(feIdx), 'Web 前端入口存在（ArkWeb 要加载它）', fs.existsSync(feIdx) ? '✓' : '缺失')
  // 抽样确认没有二进制混进来
  const bin = []
  const scan = (dir, rel) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const r = rel ? rel + '/' + name : name
      if (fs.statSync(p).isDirectory()) scan(p, r)
      else if (/\.(dll|exe|pdb|node)$/i.test(name)) bin.push(r)
    }
  }
  scan(outDir, '')
  add(bin.length === 0, '没有二进制/原生模块混入', bin.length ? bin.slice(0, 5).join(', ') : '0 个')
}

const failed = checks.filter((c) => !c.ok)
console.log('')
console.log('校验:')
for (const c of checks) console.log('  ' + (c.ok ? '[OK]' : '[!!]') + ' ' + c.name + (c.detail ? '   — ' + c.detail : ''))
console.log('')
console.log(failed.length === 0 ? '结论: 全部通过 ✓ resfile 可用于 M2 打包' : '结论: ' + failed.length + ' 项未通过 ✗')
console.log('输出目录: ' + path.resolve(outDir))
fs.closeSync(fd)
process.exit(failed.length === 0 ? 0 : 1)
