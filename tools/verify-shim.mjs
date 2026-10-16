#!/usr/bin/env node
// verify-shim.mjs —— 验证"不需要原生 require-builtin 插件"这一结论（可随时复跑）
// 用法: node tools/verify-shim.mjs [桩路径]
//   （需要以 --expose-internals 运行才能全通过：node --expose-internals tools/verify-shim.mjs）
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const shim = process.argv[2] || path.resolve('dist/ohos-overlay/node_modules/node-addon-require-builtin/lib/index.js')
const internals = [
  'internal/modules/esm/loader',
  'internal/modules/cjs/loader',
  'internal/modules/helpers',
  'internal/modules/esm/utils',
  'internal/modules/esm/resolve',
]

console.log('shim      : ' + shim)
console.log('存在      : ' + fs.existsSync(shim))
console.log('node      : ' + process.version)
console.log('execArgv  : ' + JSON.stringify(process.execArgv))
const exposed = process.execArgv.includes('--expose-internals')
console.log('--expose-internals : ' + (exposed ? '有 ✓' : '无（本脚本应带它运行）'))
console.log('')

let bad = 0
const check = (name, fn) => {
  let ok = false, err = ''
  try { ok = !!fn() } catch (e) { err = e.code || e.message }
  if (!ok) bad++
  console.log((ok ? '  [OK] ' : '  [!!] ') + name + (err ? '   → ' + err : ''))
}

let addon = null
try { addon = require_(shim) } catch (e) { console.log('装不上桩: ' + e.message); process.exit(1) }

check('导出 requireBuiltin', () => typeof addon.requireBuiltin === 'function')
check('导出 isAllowedInternalId', () => typeof addon.isAllowedInternalId === 'function')
check('导出 getBindingInfo', () => typeof addon.getBindingInfo === 'function')
check('default 导出存在', () => typeof addon.default === 'object')
check('isAllowedInternalId() === true', () => addon.isAllowedInternalId('internal/anything') === true)
for (const m of internals) {
  check('requireBuiltin("' + m + '")', () => {
    const x = addon.requireBuiltin(m)
    return x && (typeof x === 'object' || typeof x === 'function')
  })
}
const info = addon.getBindingInfo()
check('getBindingInfo 形状正确', () => info && typeof info.backend === 'string' && info.shim === true)

// 复刻 DSH 真实调用方的双重兜底
const loadInternal = (id) => {
  if (process.execArgv.includes('--expose-internals')) { try { return require_(id) } catch (e) {} }
  try { return require_('node-addon-require-builtin').requireBuiltin(id) } catch (e) {}
  return null
}
console.log('')
check('复刻 DSH 写法: cjs/loader', () => loadInternal('internal/modules/cjs/loader'))
check('复刻 DSH 写法: esm/loader', () => loadInternal('internal/modules/esm/loader'))

console.log('')
console.log(bad === 0 ? '结论: 全部通过 ✓ 不需要原生插件（前提：启动带 --expose-internals）'
                      : ('结论: ' + bad + ' 项未通过 ✗'))
process.exit(bad === 0 ? 0 : 1)