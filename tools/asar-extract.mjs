#!/usr/bin/env node
// asar-extract.mjs —— 从 Electron asar 包里列出/提取文件（零依赖）
//
// 为什么要它：DSH 的关键元数据（如 dsh/desktop-runtime.json）藏在 app.asar 里，
// 手工用 PowerShell 读 asar 头既繁琐又容易出错。做成工具后整条流水线可复现。
//
// 用法:
//   node tools/asar-extract.mjs <app.asar> --list [子串过滤]
//   node tools/asar-extract.mjs <app.asar> --find <子串> [--max N]
//   node tools/asar-extract.mjs <app.asar> <包内路径> <输出文件>
//   node tools/asar-extract.mjs <app.asar> <包内路径> --sha256
//
// asar 头部布局（实测有效）:
//   u32 @0  = 4
//   u32 @4  = pickle 负载大小
//   u32 @8  = JSON 字符串大小
//   u32 @12 = JSON 长度            ← 头部 JSON 从这里之后开始，文件数据从 16 + JSON长度 开始
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const [asarPath, arg1, arg2, arg3] = process.argv.slice(2)
if (!asarPath || !fs.existsSync(asarPath)) {
  console.error('用法: node tools/asar-extract.mjs <app.asar> --list [过滤] | --find <子串> | <包内路径> <输出文件> | <包内路径> --sha256')
  process.exit(2)
}

const fd = fs.openSync(asarPath, 'r')
const hdr = Buffer.alloc(16)
fs.readSync(fd, hdr, 0, 16, 0)
const jsonLen = hdr.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonLen)
fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
const baseOffset = 16 + jsonLen
const root = JSON.parse(jsonBuf.toString('utf8'))

/** 遍历 asar 目录树，收集 {path,size,offset} */
function walk(node, prefix, acc) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (child.files) walk(child, p, acc)
    // ★ asar 的 JSON 里 offset/size 可能是【字符串】，必须转数字，
    //   否则 fs.readSync 会报 ERR_INVALID_ARG_TYPE: position must be bigint or integer
    // ★★ 还必须记录 unpacked：这类条目的内容【不在 asar 内】，
    //    而在同级目录 <asar>.unpacked/<同样的内部路径> 下（整个子目录常常整块被 unpack）
    else acc.push({ path: p, size: Number(child.size || 0), offset: Number(child.offset || 0), unpacked: !!child.unpacked })
  }
  return acc
}
const entries = walk(root, '', [])

const unpackedRoot = asarPath + '.unpacked'   // Electron 约定：<app>.asar.unpacked/
function readEntry(e) {
  if (e.unpacked) {
    const p = path.join(unpackedRoot, e.path)
    if (!fs.existsSync(p)) throw new Error('unpacked 条目在磁盘上不存在: ' + p)
    const buf = fs.readFileSync(p)
    if (buf.length !== e.size) throw new Error('unpacked 大小不符: ' + p + ' 磁盘 ' + buf.length + ' vs 声明 ' + e.size)
    return buf
  }
  const buf = Buffer.alloc(e.size)
  fs.readSync(fd, buf, 0, e.size, baseOffset + e.offset)
  return buf
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')

if (arg1 === '--list') {
  const filter = arg2 || ''
  const hit = entries.filter((e) => e.path.includes(filter))
  console.log('asar 内文件总数: ' + entries.length + '   匹配 "' + filter + '": ' + hit.length)
  for (const e of hit.slice(0, 200)) console.log(String(e.size).padStart(10) + '  ' + e.path)
  if (hit.length > 200) console.log('  …（仅显示前 200 条）')
} else if (arg1 === '--find') {
  const needle = arg2
  if (!needle) { console.error('--find 需要一个子串'); process.exit(2) }
  const hit = entries.filter((e) => e.path.includes(needle))
  console.log('匹配 "' + needle + '": ' + hit.length)
  for (const e of hit) console.log(String(e.size).padStart(10) + '  ' + e.path)
} else if (arg1 && arg2 === '--sha256') {
  const e = entries.find((x) => x.path === arg1)
  if (!e) { console.error('包内不存在: ' + arg1); process.exit(1) }
  console.log(sha256(readEntry(e)))
} else if (arg1 && arg2) {
  const e = entries.find((x) => x.path === arg1)
  if (!e) { console.error('包内不存在: ' + arg1); process.exit(1) }
  const buf = readEntry(e)
  const dest = arg2
  if (dest !== '-') fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true })
  if (dest === '-') process.stdout.write(buf)
  else fs.writeFileSync(dest, buf)
  console.log('已提取 ' + arg1)
  console.log('  字节  : ' + buf.length)
  console.log('  sha256: ' + sha256(buf))
  if (dest !== '-') console.log('  输出  : ' + path.resolve(dest))
} else {
  console.error('参数不完整。见文件头用法说明。')
  process.exit(2)
}
fs.closeSync(fd)
