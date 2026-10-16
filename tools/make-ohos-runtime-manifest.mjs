#!/usr/bin/env node
// make-ohos-runtime-manifest.mjs —— 从官方 win32-x64 清单生成【鸿蒙版运行包清单】
//                                    并生成配套的 overlay（JS 桩等），最后自带校验
//
// 用法: node tools/make-ohos-runtime-manifest.mjs <desktop-runtime.json> [输出目录=dist]
//
// 产物:
//   <out>/ohos-runtime.json          —— 鸿蒙版清单（files 只保留 KEEP；platform/arch 改为 openharmony/arm64）
//   <out>/ohos-overlay/…             —— 需要【覆盖或新增】的文件（JS 桩）
//   <out>/ohos-manifest-report.txt   —— 校验报告
// 校验不过 → 退出码 1
import fs from 'node:fs'
import path from 'node:path'
import { classify, packageOf, bucketize, sumBytes, MB } from './lib/prune-rules.mjs'

const src = process.argv[2]
const outDir = process.argv[3] || 'dist'
if (!src || !fs.existsSync(src)) {
  console.error('用法: node tools/make-ohos-runtime-manifest.mjs <desktop-runtime.json> [输出目录]')
  process.exit(2)
}
const manifest = JSON.parse(fs.readFileSync(src, 'utf8'))
const { buckets, totalBytes } = bucketize(manifest.files || [])

// ---------- overlay：JS 桩替代 node-addon-require-builtin ----------
// 依据：cordis-plugin-loader 的实现是
//   if (process.execArgv.includes("--expose-internals")) try { return require(id) } catch {}
//   try { return require("node-addon-require-builtin").requireBuiltin(id) } catch {}
// 只要启动带 --expose-internals，纯 JS 即可，无需任何原生编译。
const SHIM_INDEX = `"use strict";
// 纯 JS 替代 node-addon-require-builtin（鸿蒙无需原生编译）
// 前提：Node 以 --expose-internals 启动，使 require("internal/...") 可用。
// 导出形状与原包保持一致（named + default），便于 require / import 两种用法。
function requireBuiltin(moduleId) {
  return require(moduleId);
}
function isAllowedInternalId(_moduleId) {
  return true;
}
function getBindingInfo() {
  return {
    backend: "js-shim",
    abi: "napi-v9",
    platform: process.platform,
    arch: process.arch,
    shim: true,
  };
}
module.exports = { requireBuiltin, isAllowedInternalId, getBindingInfo };
module.exports.default = module.exports;
`
const SHIM_PKG = JSON.stringify({
  name: 'node-addon-require-builtin',
  version: '0.1.6-ohos-shim',
  description: 'Pure-JS shim replacing the native require-builtin addon on OpenHarmony (needs --expose-internals).',
  main: 'lib/index.js',
  exports: { '.': { import: './lib/index.js', require: './lib/index.js', default: './lib/index.js' }, './package.json': './package.json' },
  license: 'MIT',
}, null, 1) + '\n'

const DISABLED_PLUGIN_NAMES = [
  '@deepseek-ai/dsh-sandbox-windows-acl',
  '@deepseek-ai/dsh-win32-process',
  '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice',
  '@deepseek-ai/dsh-host-directory-picker-native',
]

const OVERLAY = [
  { path: 'node_modules/node-addon-require-builtin/lib/index.js', content: SHIM_INDEX, note: '覆盖为纯 JS 桩（需 --expose-internals）' },
  { path: 'node_modules/node-addon-require-builtin/package.json', content: SHIM_PKG, note: '包元数据（保持可 require 解析）' },
]

// ---------- 生成清单 ----------
const keep = buckets.KEEP.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256, executable: f.executable }))
const alivePkgs = new Set(keep.map((f) => packageOf(f.path)).filter(Boolean))
const sharedPackages = (manifest.sharedPackages || []).filter((p) => alivePkgs.has(p.name))

const ohos = {
  schemaVersion: manifest.schemaVersion ?? 1,
  release: { ...(manifest.release || {}), note: 'OpenHarmony 运行包清单（由 tools/make-ohos-runtime-manifest.mjs 生成）' },
  platform: 'openharmony',
  arch: 'arm64',
  derivedFrom: { platform: manifest.platform, arch: manifest.arch, files: (manifest.files || []).length, bytes: totalBytes },
  launch: {
    argv: ['--expose-internals', '--jitless', '--no-verify-heap'],
    env: { UV_USE_IO_URING: '0' },
    why: {
      '--expose-internals': '让 require("internal/...") 可用，从而不需要原生 require-builtin 插件',
      '--jitless': '避免 V8 运行时 PROT_EXEC 映射被 OpenHarmony W^X 策略拒绝（否则 node::Start 里 SIGTRAP）',
      '--no-verify-heap': '受限运行时下对堆分配检查的防御',
      UV_USE_IO_URING: 'libuv 的 io_uring 探测会被沙箱 seccomp trap（另需 SIGSYS shim 把 trap 转成 -1）',
    },
  },
  disabledPlugins: [
    { name: '@deepseek-ai/dsh-sandbox-windows-acl', why: 'Windows 专属' },
    { name: '@deepseek-ai/dsh-win32-process', why: 'Windows 专属' },
    { name: '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice', why: '实验性语音；且与"仅网络权限"的隐私声明冲突' },
    { name: '@deepseek-ai/dsh-host-directory-picker-native', why: 'Win32 COM 对话框；改用同族的 -auto / -browse' },
  ],
  overrides: OVERLAY.map((o) => ({ path: o.path, note: o.note })),
  sharedPackages,
  files: keep,
  stats: {
    files: keep.length,
    bytes: sumBytes(keep),
    dropped: { files: buckets.DROP.length, bytes: sumBytes(buckets.DROP) },
    review: { files: buckets.REVIEW.length, bytes: sumBytes(buckets.REVIEW) },
  },
}

fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'ohos-runtime.json'), JSON.stringify(ohos, null, 1))
for (const o of OVERLAY) {
  const dest = path.join(outDir, 'ohos-overlay', o.path)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, o.content)
}

// ---------- 自带校验 ----------
const checks = []
const add = (ok, name, detail) => checks.push({ ok: !!ok, name, detail })

add(ohos.platform === 'openharmony' && ohos.arch === 'arm64', '平台字段已改为 openharmony/arm64', ohos.platform + '/' + ohos.arch)

// 只看"二进制/原生模块"，不看包名——Windows 专属插件的 JS/README 留着无害（用配置禁用即可），
// 而且直接删包会让加载器因"引用了不存在的包"报错。
const binLeftover = keep.filter((f) => /\.(dll|exe|pdb|node|so)$/i.test(f.path))
add(binLeftover.length === 0, '清单内已无任何二进制/原生模块', binLeftover.length ? binLeftover.slice(0, 3).map((f) => f.path).join(', ') : '0 个')

// 被禁用的插件【必须仍然在包内】（否则 enabled:false 的配置会指向不存在的包）
for (const d of DISABLED_PLUGIN_NAMES) {
  add(alivePkgs.has(d), '被禁用插件仍在包内（供配置禁用）: ' + d, alivePkgs.has(d) ? '✓' : '缺失 ✗ 需保留或调整禁用配置')
}

const reDrop = keep.filter((f) => classify(f.path).kind === 'DROP')
add(reDrop.length === 0, '清单内无任何仍命中 DROP 规则的文件', reDrop.length + ' 个')

// 前端资源必须在（ArkWeb 要加载它）
const uiPkgs = [...alivePkgs].filter((p) => p.startsWith('@deepseek-ai/dsh-client-ui-'))
add(uiPkgs.length >= 30, '前端 UI 插件包齐备', uiPkgs.length + ' 个 dsh-client-ui-* 包')
const feEntry = keep.find((f) => /dsh-web-frontend\/dist\/index\.html$/.test(f.path))
add(!!feEntry, 'Web 前端入口 index.html 在清单内', feEntry ? feEntry.path : '未找到')

// 核心必须都在
for (const must of ['@deepseek-ai/dsh', '@deepseek-ai/cordis', '@deepseek-ai/dsh-app-boot', '@deepseek-ai/dsh-web-frontend']) {
  add(alivePkgs.has(must), '核心包存活: ' + must, alivePkgs.has(must) ? '✓' : '缺失')
}

// 原生模块的处理状态必须明确
const nativeInKeep = keep.filter((f) => /\.node$/i.test(f.path))
add(nativeInKeep.length === 0, '清单内已无 .node 原生模块（改为 JS 桩/懒加载）', nativeInKeep.length ? nativeInKeep.map((f) => f.path).join(', ') : '0 个')

const failed = checks.filter((c) => !c.ok)
const lines = []
lines.push('OpenHarmony 运行包清单校验报告')
lines.push('生成自: ' + path.basename(src) + '  (' + manifest.platform + '-' + manifest.arch + ')')
lines.push('')
lines.push('体积:')
lines.push('  原始   ' + String((manifest.files || []).length).padStart(6) + ' 文件  ' + MB(totalBytes).padStart(10))
lines.push('  KEEP   ' + String(keep.length).padStart(6) + ' 文件  ' + MB(sumBytes(keep)).padStart(10))
lines.push('  DROP   ' + String(buckets.DROP.length).padStart(6) + ' 文件  ' + MB(sumBytes(buckets.DROP)).padStart(10))
lines.push('  REVIEW ' + String(buckets.REVIEW.length).padStart(6) + ' 文件  ' + MB(sumBytes(buckets.REVIEW)).padStart(10))
lines.push('')
lines.push('sharedPackages: ' + (manifest.sharedPackages || []).length + ' → ' + sharedPackages.length + '（裁掉 ' + ((manifest.sharedPackages || []).length - sharedPackages.length) + ' 个纯平台包）')
lines.push('overlay（覆盖/新增）: ' + OVERLAY.length + ' 个文件')
lines.push('')
lines.push('校验项:')
for (const c of checks) lines.push('  ' + (c.ok ? '[✓]' : '[✗]') + ' ' + c.name + (c.detail ? '   — ' + c.detail : ''))
lines.push('')
lines.push(failed.length === 0 ? '结论: 全部通过 ✓ 清单可用于 M2 打包' : ('结论: ' + failed.length + ' 项未通过 ✗ 需修正'))

const report = lines.join('\n')
fs.writeFileSync(path.join(outDir, 'ohos-manifest-report.txt'), report)
console.log(report)
console.log('')
console.log('已写出: ' + path.join(outDir, 'ohos-runtime.json'))
console.log('已写出: ' + path.join(outDir, 'ohos-overlay') + '/')
process.exit(failed.length === 0 ? 0 : 1)
