<#
  build.ps1 —— 一键出两种包（互不混淆）

    powershell -File tools\build.ps1 test      # 真机测试包（可 hdc 安装，需开发者模式）
    powershell -File tools\build.ps1 upload    # 上传应用市场用的 .app
    powershell -File tools\build.ps1 both      # 两个都出

  为什么必须分开（血的教训）：
    · 应用市场发布用的 Profile 是 app_gallery —— 系统**只允许从应用市场安装**，
      用 hdc 装会失败（官方错误 INSTALL_FAILED_APP_SOURCE_NOT_TRUSTED）。
    · 真机自测必须用「指定设备发布」Profile（app_distribution_type = internaltesting），
      它才能被 hdc 安装，而且**必须开着开发者模式**。

  本脚本构建后会**直接校验产物内嵌的分发类型**，避免"编译成功但装不上"这种假成功。
#>
param(
  [ValidateSet('test', 'upload', 'both')]
  [string]$Mode = 'test'
)
$ErrorActionPreference = 'Continue'   # 注意：hvigor 会往 stderr 写警告，Stop 会被当成致命错误
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Say($m) { Write-Host ('  ' + $m) }
function Ok($m) { Write-Host ('  [OK] ' + $m) -ForegroundColor Green }
function Bad($m) { Write-Host ('  [!!] ' + $m) -ForegroundColor Red }

$proj = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $proj 'build-profile.json5'))) { $proj = (Get-Location).Path }
Say ('工程: ' + $proj)

# ---- 环境（DevEco 自带的 jbr/node，缺了会报 spawn java ENOENT / 内存不足）----
$env:DEVECO_SDK_HOME = 'F:\DevEco Studio\sdk'
$env:JAVA_HOME = 'F:\DevEco Studio\jbr'
$env:_JAVA_OPTIONS = '-Xmx640m'
$env:JAVA_TOOL_OPTIONS = '-Xmx640m'
$env:PATH = 'F:\DevEco Studio\jbr\bin;F:\DevEco Studio\tools\node;F:\DevEco Studio\tools\ohpm\bin;' + $env:PATH
$node = 'F:\DevEco Studio\tools\node\node.exe'
$hvigor = 'F:\DevEco Studio\tools\hvigor\bin\hvigorw.js'
if (-not (Test-Path $node)) { throw "找不到 $node" }
if (-not (Test-Path $hvigor)) { throw "找不到 $hvigor" }

function KindOf([string]$file) {
  if (-not (Test-Path $file)) { return '不存在' }
  $txt = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($file))
  if ($txt -match 'internaltesting') { return 'internaltesting（可 hdc 安装 ✓）' }
  if ($txt -match 'app_gallery') { return 'app_gallery（只能从应用市场安装）' }
  return '未知'
}

Push-Location $proj
try {
  if ($Mode -in 'test', 'both') {
    Write-Host ''
    Write-Host '=== 真机测试包（target=default, product=test → devicetest 签名）==='
    $log = & $node $hvigor --mode module -p module=entry@default -p product=test -p buildMode=release assembleHap --no-daemon 2>&1
    $code = $LASTEXITCODE
    $log | Select-String -Pattern 'ERROR|Error Message|BUILD SUCCESSFUL|FAILED' | ForEach-Object { '  ' + ($_.Line -replace "`e\[[0-9;]*m", '').Trim() }
    if ($code -ne 0) { Bad ('构建失败，退出码 ' + $code) } else { Ok '构建成功' }
    $hap = Join-Path $proj 'entry\build\test\outputs\default\entry-default-signed.hap'
    Say ('产物: ' + $hap.Replace($proj, '.'))
    Say ('分发类型: ' + (KindOf $hap))
    Say '装机命令: hdc install -r "<上面这个 hap>"'
    Say '（前提：手机已开「开发者模式 + USB 调试」，并且这台手机的 UDID 在 Profile 的 device-ids 里）'
  }

  if ($Mode -in 'upload', 'both') {
    Write-Host ''
    Write-Host '=== 上传应用市场用的 .app（product=default）==='
    $log2 = & $node $hvigor --mode project -p product=default -p buildMode=release assembleApp --no-daemon 2>&1
    $code2 = $LASTEXITCODE
    $log2 | Select-String -Pattern 'ERROR|Error Message|BUILD SUCCESSFUL|FAILED' | ForEach-Object { '  ' + ($_.Line -replace "`e\[[0-9;]*m", '').Trim() }
    if ($code2 -ne 0) { Bad ('构建失败，退出码 ' + $code2) } else { Ok '构建成功' }
    $app = Join-Path $proj 'build\outputs\default\HarnessMobile-default-signed.app'
    Say ('产物: ' + $app.Replace($proj, '.'))
    Say ('分发类型: ' + (KindOf $app))
    Say '这个 .app 才是上传 AGC 用的（上传时若提示"包解析失败/请使用发布证书和发布 Profile"→ 说明用错了 Profile）'
  }
} finally { Pop-Location }

Write-Host ''
Ok ('完成（模式: ' + $Mode + '）')
