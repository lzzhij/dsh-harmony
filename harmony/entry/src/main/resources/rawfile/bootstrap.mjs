// bootstrap.mjs —— 在端上解包 DSH 载荷，然后【在同一个进程里】把 DSH 启动起来
//
// 为什么必须让 Node 自己解包（2026-10-03 真机实测得出的架构结论）：
//   同一沙箱目录、同一进程、同一 uid 下，"谁写的文件谁能读"并不成立：
//     · ArkTS 用 fs.writeSync 写的 hello.js      → Node 能 require ✓（M1 已跑通）
//     · 鸿蒙 zlib.decompressFile 解出来的 bin.js → Node 报 MODULE_NOT_FOUND ✗
//   ⇒ 所以让【最终使用者也当写入者】：由 Node 自己解包，它自己就必然能读。
//
// 用法：
//   node bootstrap.mjs <payload.tar.gz> <destDir> [entryRel] [dsh args...]
//   例：node bootstrap.mjs /path/dsh-payload.tar.gz /path/dsh \
//          dsh/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open
//
// 说明：
//   · 用 Node 内置 zlib 解 gzip（无需任何外部依赖）
//   · tar 只实现到够用且正确的程度：ustar + GNU 'L' 长名 + PAX 'x'/'g' + 目录 + 普通文件
//   · 符号链接（npm 的 .bin）在鸿蒙沙箱里通常建不了，跳过并计数（不影响 require）
//   · 进度打到 stdout —— 宿主壳已把 stdout 重定向到 node-stdout.log，界面能看到

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const tarGz = argv[0]
const destDir = argv[1]
const entryRel = argv[2] || 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
const dshArgs = argv.slice(3)

const t0 = Date.now()
const say = (m) => { console.log('[unpack] ' + m); }

if (!tarGz || !destDir) {
  console.error('[unpack] 用法: node bootstrap.mjs <payload.tar.gz> <destDir> [entryRel] [dsh args...]')
  process.exit(2)
}

say('bootstrap 启动  node=' + process.version + '  platform=' + process.platform + '  arch=' + process.arch)
say('载荷 = ' + tarGz)
say('目标 = ' + destDir)
say('入口 = ' + entryRel)

// ---------------------------------------------------------------- 解包
fs.mkdirSync(destDir, { recursive: true })

let raw
try {
  const packed = fs.readFileSync(tarGz)
  say('读到 tar.gz ' + packed.length + ' 字节')
  raw = zlib.gunzipSync(packed)
  say('解压后 tar ' + raw.length + ' 字节（' + (raw.length / 1048576).toFixed(1) + ' MB）')
} catch (e) {
  console.error('[unpack] 读取/解压失败: ' + e.message)
  process.exit(3)
}

let off = 0
let files = 0
let dirs = 0
let links = 0
let skipped = 0
let longName = null
let paxPath = null
const BLOCK = 512

function cstr(buf, from, to) {
  return buf.subarray(from, to).toString('utf8').replace(/\0[\s\S]*$/, '')
}
function octal(buf, from, to) {
  const s = cstr(buf, from, to).trim()
  if (s === '') return 0
  return parseInt(s, 8) || 0
}

while (off + BLOCK <= raw.length) {
  const h = raw.subarray(off, off + BLOCK)
  let allZero = true
  for (let i = 0; i < BLOCK; i++) { if (h[i] !== 0) { allZero = false; break } }
  if (allZero) { break }                     // 两个全零块 = 归档结束

  let name = cstr(h, 0, 100)
  const size = octal(h, 124, 136)
  const typeFlag = String.fromCharCode(h[156]) || '0'
  const prefix = cstr(h, 345, 500)
  if (prefix) name = prefix + '/' + name

  const dataStart = off + BLOCK
  const data = raw.subarray(dataStart, dataStart + size)

  if (typeFlag === 'L') {                    // GNU 长文件名：名字在数据里，作用于【下一条】
    longName = data.toString('utf8').replace(/\0[\s\S]*$/, '')
  } else if (typeFlag === 'x' || typeFlag === 'g') {   // PAX 扩展头：找 path=
    const txt = data.toString('utf8')
    const m = txt.match(/\d+ path=([^\n]+)\n/)
    if (m) paxPath = m[1]
  } else {
    if (longName) { name = longName; longName = null }
    if (paxPath) { name = paxPath; paxPath = null }

    const target = path.join(destDir, name)
    try {
      if (typeFlag === '5' || name.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true })
        dirs++
      } else if (typeFlag === '2' || typeFlag === '1') {   // 符号/硬链接
        links++                                            // 鸿蒙沙箱通常建不了，跳过
      } else if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, data)
        files++
        if (files % 1000 === 0) { say('已写出 ' + files + ' 个文件…（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）') }
      } else {
        skipped++
      }
    } catch (e) {
      skipped++
      if (skipped <= 5) { console.log('[unpack] 跳过 ' + name + ' : ' + e.message) }
    }
  }

  off = dataStart + Math.ceil(size / BLOCK) * BLOCK
}

say('解包完成  文件=' + files + '  目录=' + dirs + '  链接跳过=' + links + '  其它跳过=' + skipped +
    '  用时=' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒')

// ---------------------------------------------- 探针：端上有没有可用的 shell
// ★ DSH 的 bash 工具要 spawn shell；鸿蒙只有 sh 没有 bash ⇒ 先测清楚
import { spawnSync } from 'node:child_process'
function probeShell() {
  const cands = ['/bin/sh', '/system/bin/sh', '/usr/bin/sh', '/bin/bash', '/system/bin/bash']
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['-c', 'echo SHELL_OK'], { encoding: 'utf8', timeout: 5000 })
      say('shell 探针 ' + c + ' → status=' + r.status + ' error=' + (r.error ? r.error.code : 'none'))
    } catch (e) {
      say('shell 探针 ' + c + ' → 异常 ' + e.message)
    }
  }
}
probeShell()

// ★ 把 Node 的工作目录固定到沙箱内的 workspace —— DSH 的 workspaceRoot 用 process.cwd()，
//   默认 cwd 是 "/"（不可写）⇒ 指到这里，agent 的默认工作区就是可读写的沙箱目录。
try {
  const wsDir = path.join(path.dirname(destDir), 'workspace')
  fs.mkdirSync(wsDir, { recursive: true })
  process.chdir(wsDir)
  say('cwd 已设为 ' + process.cwd())
} catch (e) {
  say('cwd 设置失败: ' + (e && e.message ? e.message : e))
}


// ---------------------------------------------------------------- 校验入口
const entryAbs = path.join(destDir, entryRel)
let entryOk = false
try {
  const st = fs.statSync(entryAbs)
  entryOk = st.isFile() && st.size > 1000
  say('入口检查: ' + entryAbs + '  大小=' + st.size + '  是文件=' + st.isFile() + '  ⇒ ' + (entryOk ? '可用' : '不可用'))
} catch (e) {
  say('入口检查失败: ' + entryAbs + ' : ' + e.message)
}
if (!entryOk) { console.error('[unpack] 入口不可用，中止'); process.exit(4) }

// 顺手确认 Node 能打开它（这正是整件事的关键 —— 谁写谁读）
try {
  const probe = fs.readFileSync(entryAbs)
  say('Node 读取入口成功: ' + probe.length + ' 字节 ✓（这一步就是 M1 成功、M2 失败的分水岭）')
} catch (e) {
  console.error('[unpack] Node 读不到入口: ' + e.message)
  process.exit(5)
}

// 本地验证用：只解包、不启动 DSH（避免在电脑上又起一个 DSH 实例）
if (process.env.DSH_BOOTSTRAP_UNPACK_ONLY === '1') {
  say('UNPACK_ONLY=1 ⇒ 到此为止（本地验证解包器）')
  process.exit(0)
}

// ---------------------------------------------------------------- 启动 DSH（同一进程内）
// DSH 的 bin.js 是 ESM，所以用动态 import；并把 process.argv 摆成 CLI 期望的形状。
const realArgv = [process.argv[0], entryAbs, ...(dshArgs.length > 0 ? dshArgs : ['web', '--no-open'])]
process.argv = realArgv
say('准备启动 DSH: argv=' + JSON.stringify(process.argv.slice(1)))
say('（DSH_HOME=' + (process.env.DSH_HOME || '(未设置)') + '）')

try {
  const mod = await import(pathToFileURL(entryAbs).href)
  say('DSH 入口已加载')
  // ★★★ 关键：bin.js 的最后一行是 `if (import.meta.main) await runCli();`
  //   —— `import.meta.main` 只在"该模块就是进程主入口"时为真；
  //   我们是用 import() 加载它的，所以它是 false ⇒ runCli() 永远不会自跑，
  //   表现就是"DSH 入口已加载"之后进程立刻退出（实测就是这个现象）。
  //   bin.js 同时 `export { runCli }`，所以这里显式调用它。
  if (mod && typeof mod.runCli === 'function') {
    say('⇒ 显式调用 runCli()（绕过 import.meta.main 的限制）')
    await mod.runCli()
    say('runCli() 已返回')
  } else {
    say('⚠ 入口没有导出 runCli，只能依赖它自跑（import.meta.main=' + (import.meta.main === true) + '）')
  }
} catch (e) {
  console.error('[unpack] 启动 DSH 失败: ' + (e && e.stack ? e.stack : e))
  process.exit(6)
}
