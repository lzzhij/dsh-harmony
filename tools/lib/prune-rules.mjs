// prune-rules.mjs —— 运行包裁剪规则（共享模块）
//
// 用途：判断 DSH 官方运行包（win32-x64）里的每个文件，在【鸿蒙】上是否还需要。
// 原则：**保守**。分不清的一律进 REVIEW，绝不直接 DROP——宁可多打包几 MB，
//       也不要在手机上跑起来才发现少了东西。
//
// 被 tools/make-prune-plan.mjs 与 tools/make-ohos-runtime-manifest.mjs 共用。

export const MB = (n) => (n / 1048576).toFixed(1) + ' MB'

// DROP：确定与鸿蒙无关
export const DROP_RULES = [
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
export const REVIEW_RULES = [
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

export function classify(p) {
  for (const r of DROP_RULES) if (r.re.test(p)) return { kind: 'DROP', why: r.why }
  for (const r of REVIEW_RULES) if (r.re.test(p)) return { kind: 'REVIEW', why: r.why }
  return { kind: 'KEEP', why: '' }
}

/** 从文件路径取出所属 npm 包名（用于判定"某包是否还有文件存活"） */
export function packageOf(p) {
  const m = p.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)
  return m ? m[1] : null
}

/** 把 manifest.files 分成三档 */
export function bucketize(files) {
  const buckets = { KEEP: [], REVIEW: [], DROP: [] }
  let totalBytes = 0
  for (const f of files) {
    totalBytes += f.bytes || 0
    const c = classify(f.path)
    buckets[c.kind].push({ path: f.path, bytes: f.bytes || 0, sha256: f.sha256, executable: f.executable, why: c.why })
  }
  return { buckets, totalBytes }
}

export const sumBytes = (arr) => arr.reduce((a, b) => a + (b.bytes || 0), 0)
