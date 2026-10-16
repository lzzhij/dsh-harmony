#!/usr/bin/env node
// make-prune-plan.mjs —— 从 DSH 官方运行包清单 desktop-runtime.json 推出
//                        「鸿蒙版运行包该发什么」的裁剪计划
//
// 输入：desktop-runtime.json（asar 内 dsh/desktop-runtime.json，win32-x64 的官方清单）
//        结构：{ schemaVersion, release, platform, arch, sharedPackages[287], files[12513] }
//               files 条目：{ path, bytes, sha256, executable }
// 输出：prune-plan.json（三档分类 + 体积统计）+ 控制台摘要
//
// 分类原则：**保守**。宁可多留，不可误删——分不清的放 REVIEW，不直接 DROP。
// 用法：node tools/make-prune-plan.mjs <desktop-runtime.json> [输出目录]
import fs from 'node:fs'
import path from 'node:path'

const src = process.argv[2]
const outDir = process.argv[3] || 'dist'
if (!src || !fs.existsSync(src)) {
  console.error('用法: node tools/make-prune-plan.mjs <desktop-runtime.json> [输出目录]')
  process.exit(2)
}

const manifest = JSON.parse(fs.readFileSync(src, 'utf8'))
const files = manifest.files || []
const sharedPackages = manifest.sharedPackages || []

const MB = (n) => (n / 1048576).toFixed(1) + ' MB'

// ---------- 分类规则 ----------
// DROP：确定与鸿蒙无关（Windows 二进制 / 构建产物 / 测试 / sourcemap）
const DROP_RULES = [
  { re: /(^|\/)libreoffice-kit-win32[^/]*\//i,               why: 'Windows 版 LibreOffice（170MB 级）' },
  { re: /(^|\/)sherpa-onnx-win[^/]*\//i,                     why: 'Windows 版语音（实验插件，可停用）' },
  { re: /@img\/sharp-win32[^/]*\//i,                         why: 'sharp 的 Windows 预编译' },
  { re: /@koromix\/koffi-win32[^/]*\//i,                     why: 'koffi 的 Windows 预编译（懒加载，鸿蒙不用）' },
  { re: /node-addon-[^/]*-win32[^/]*\//i,                    why: 'node-addon 的 Windows 预编译（改用 JS 桩）' },
  { re: /node-pty\/(prebuilds\/win32|third_party\/conpty)/i,  why: 'node-pty 的 Windows ConPTY 产物' },
  { re: /\.(dll|exe|pdb|lib|exp)$/i,                          why: 'Windows 原生二进制/调试符号' },
  { re: /\/(test|tests|__tests__|__mocks__)\//i,              why: '测试目录' },
  { re: /\.(test|spec)\.[cm]?js$/i,                           why: '测试文件' },
  { re: /\.map$/i,                                            why: 'sourcemap' },
  { re: /\.(tsbuildinfo|log)$/i,                              why: '构建缓存/日志' },
]

// REVIEW：可能有用、也可能要换实现，交给人工/后续决定
const REVIEW_RULES = [
  { re: /@vscode\/ripgrep-win32[^/]*\//i,                    why: '★ 检索工具：鸿蒙需换 OHOS 版 ripgrep 或纯 JS 替代' },
  { re: /(^|\/)libreoffice-kit-(?!win32)[^/]*\//i,           why: 'Office 文档工具（非 win 版）：体积大，可按需下载' },
  { re: /@img\/sharp-libvips-(?!win32)[^/]*\//i,             why: 'sharp 的 libvips（非 win）：如需图像功能再定' },
  { re: /@img\/sharp-(?!win32)[^/]*\//i,                     why: 'sharp 其他平台预编译' },
  { re: /@koromix\/koffi-(?!win32)[^/]*\//i,                 why: 'koffi 其他平台预编译（懒加载，多半可删）' },
  { re: /sherpa-onnx-(?!win)[^/]*\//i,                       why: '语音其他平台预编译' },
  { re: /node-pty\/prebuilds\/(?!win32)[^/]*\//i,            why: 'node-pty 其他平台预编译' },
  { re: /\.wasm$/i,                                          why: 'wasm 产物：鸿蒙可能可用，需实测' },
  { re: /\.node$/i,                                          why: '★ 其他平台原生模块：需换 OHOS 版或确认懒加载' },
]

function classify(p) {
  for (const r of DROP_RULES) if (r.re.test(p)) return { kind: 'DROP', why: r.why }
  for (const r of REVIEW_RULES) if (r.re.test(p)) return { kind: 'REVIEW', why: r.why }
  return { kind: 'KEEP', why: '' }
}

// ---------- 执行 ----------
const buckets = { KEEP: [], REVIEW: [], DROP: [] }
const dropReasons = new Map()
let totalBytes = 0
for (const f of files) {
  totalBytes += f.bytes || 0
  const c = classify(f.path)
  buckets[c.kind].push({ path: f.path, bytes: f.bytes || 0, why: c.why })
  if (c.kind === 'DROP') dropReasons.set(c.why, (dropReasons.get(c.why) || 0) + (f.bytes || 0))
}
const sum = (arr) => arr.reduce((a, b) => a + b.bytes, 0)

// 每个 sharedPackage 是否还有存活文件
const alive = new Set()
for (const e of buckets.KEEP) {
  const m = e.path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)
  if (m) alive.add(m[1])
}
const fullyDroppedPkgs = sharedPackages
  .map((p) => p.name)
  .filter((n) => !alive.has(n))

const plan = {
  generatedFrom: path.basename(src),
  sourceManifest: { platform: manifest.platform, arch: manifest.arch, release: manifest.release, schemaVersion: manifest.schemaVersion },
  totals: {
    files: files.length,
    bytes: totalBytes,
    keep: { files: buckets.KEEP.length, bytes: sum(buckets.KEEP) },
    review: { files: buckets.REVIEW.length, bytes: sum(buckets.REVIEW) },
    drop: { files: buckets.DROP.length, bytes: sum(buckets.DROP) },
  },
  sharedPackages: { total: sharedPackages.length, fullyDropped: fullyDroppedPkgs.length, fullyDroppedNames: fullyDroppedPkgs },
  reviewItems: buckets.REVIEW.sort((a, b) => b.bytes - a.bytes).slice(0, 200),
  dropByReason: [...dropReasons.entries()].sort((a, b) => b[1] - a[1]).map(([why, bytes]) => ({ why, bytes })),
  keepLargest: buckets.KEEP.sort((a, b) => b.bytes - a.bytes).slice(0, 30),
}
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'prune-plan.json')
fs.writeFileSync(outFile, JSON.stringify(plan, null, 1))

// ---------- 摘要 ----------
console.log('源清单: ' + plan.sourceManifest.platform + '-' + plan.sourceManifest.arch + '   release=' + JSON.stringify(manifest.release))
console.log('总览:   ' + files.length + ' 个文件  ' + MB(totalBytes))
console.log('')
console.log('  KEEP   ' + String(buckets.KEEP.length).padStart(6) + ' 个  ' + MB(sum(buckets.KEEP)).padStart(10))
console.log('  REVIEW ' + String(buckets.REVIEW.length).padStart(6) + ' 个  ' + MB(sum(buckets.REVIEW)).padStart(10))
console.log('  DROP   ' + String(buckets.DROP.length).padStart(6) + ' 个  ' + MB(sum(buckets.DROP)).padStart(10))
console.log('')
console.log('→ 直接可用（KEEP）:            ' + MB(sum(buckets.KEEP)))
console.log('→ 去重后最乐观（KEEP+REVIEW）: ' + MB(sum(buckets.KEEP) + sum(buckets.REVIEW)))
console.log('→ 必须裁掉（DROP）:            ' + MB(sum(buckets.DROP)))
console.log('')
console.log('DROP 按原因:')
for (const d of plan.dropByReason.slice(0, 12)) console.log('  ' + MB(d.bytes).padStart(10) + '  ' + d.why)
console.log('')
console.log('REVIEW 最大 12 项:')
for (const r of plan.reviewItems.slice(0, 12)) console.log('  ' + MB(r.bytes).padStart(10) + '  ' + r.why + '  ← ' + r.path.slice(0, 80))
console.log('')
console.log('KEEP 里最大的 12 项（裁剪后仍占体积的）:')
for (const k of plan.keepLargest.slice(0, 12)) console.log('  ' + MB(k.bytes).padStart(10) + '  ' + k.path.slice(0, 90))
console.log('')
console.log('sharedPackages: ' + sharedPackages.length + ' 个，其中裁剪后完全消失的 ' + fullyDroppedPkgs.length + ' 个')
console.log('  例: ' + fullyDroppedPkgs.slice(0, 10).join(', '))
console.log('')
console.log('已写出: ' + outFile)
