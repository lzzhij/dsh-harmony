<#
  device-ui.ps1 — 和我这台鸿蒙手机可靠交互的工具集（2026-10-07 夜）
  血泪教训：
    · uitest / snapshot_display 作用于【前台应用】——手机浏览器（用户的远程 DSH）经常抢前台，
      导致所有点击/输入都打在浏览器上，表现为"点了没反应"。
    · hdc shell 会把命令交给设备 sh，双引号被剥掉 ⇒ 带空格的文本必然被拆成多参数。
      解法：逐词 uitest uiInput text，词间插 uitest uiInput keyEvent 2050（空格键）。
    · keyEvent Back 能关闭 DSH 的选择器弹窗（并确认当前选择），但会让 App 退到后台
      ⇒ 每次 Back 之后必须重新拉前台。
  用法：
    . <REPO_ROOT>\tools\device-ui.ps1
    EnsureForeground ; $j = DumpLayout 'x' ; ClickNode $j 'workspace' ; TypeText 'hello world'
#>

$script:HdcExe = 'F:\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe'
$script:DevSerial = '5BH0225314003152'
$script:AppBundle = 'com.dsh.harmony'
$script:UiTmp = Join-Path $env:TEMP 'dsh-device-ui'
if (-not (Test-Path $script:UiTmp)) { New-Item -ItemType Directory -Force -Path $script:UiTmp | Out-Null }

function Sh([string]$cmd) {
  return (& $script:HdcExe -t $script:DevSerial shell $cmd 2>&1 | Out-String).Trim()
}
function ShTargets() { return (& $script:HdcExe list targets 2>&1 | Out-String).Trim() }

function GetForeground() {
  $lines = (Sh 'aa dump -l') -split "`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match 'state #FOREGROUND|state #FOCUS') {
      for ($k = [Math]::Max(0, $i - 6); $k -le $i; $k++) {
        if ($lines[$k] -match 'bundle name \[([^\]]+)\]') { return $Matches[1] }
      }
    }
  }
  return '(unknown)'
}

# 把 App 拉到前台，并【确认】它真的是前台（最多试 4 次）
function EnsureForeground([int]$maxTry = 4) {
  for ($i = 1; $i -le $maxTry; $i++) {
    $fg = GetForeground
    if ($fg -eq $script:AppBundle) { return $true }
    Sh "aa start -a EntryAbility -b $script:AppBundle" | Out-Null
    Start-Sleep -Seconds 4
  }
  return ((GetForeground) -eq $script:AppBundle)
}

function DumpLayout([string]$tag = 'x') {
  $remote = "/data/local/tmp/dsh-$tag.json"
  Sh "uitest dumpLayout -p $remote" | Out-Null
  $local = Join-Path $script:UiTmp "$tag.json"
  if (Test-Path $local) { Remove-Item -LiteralPath $local -Force -ErrorAction SilentlyContinue }
  (& $script:HdcExe -t $script:DevSerial file recv $remote $local 2>&1 | Out-Null)
  if (Test-Path $local) { return [System.IO.File]::ReadAllText($local) }
  return ''
}

# 从一个 layout JSON 里取所有 "文本 → 中心坐标"
function GetNodes([string]$json) {
  $res = @()
  foreach ($m in [regex]::Matches($json, '"text"\s*:\s*"([^"]{1,80})"[^{}]*?"bounds"\s*:\s*"\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')) {
    $g = $m.Groups
    $res += [pscustomobject]@{ T = $g[1].Value; X = [int](([int]$g[2].Value + [int]$g[4].Value) / 2); Y = [int](([int]$g[3].Value + [int]$g[5].Value) / 2) }
  }
  if ($res.Count -eq 0) {
    foreach ($m in [regex]::Matches($json, '"bounds"\s*:\s*"\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^{}]*?"text"\s*:\s*"([^"]{1,80})"')) {
      $g = $m.Groups
      $res += [pscustomobject]@{ T = $g[5].Value; X = [int](([int]$g[1].Value + [int]$g[3].Value) / 2); Y = [int](([int]$g[2].Value + [int]$g[4].Value) / 2) }
    }
  }
  return $res
}

# ★ 默认【精确匹配】。血泪教训：模糊匹配会让"选择"命中"选择工作区"，
#   导致我对着错误的按钮点、白白浪费好几轮。需要模糊时显式用 FindNodeFuzzy。
function FindNode([string]$json, [string]$text) {
  foreach ($n in (GetNodes $json)) { if ($n.T.Trim() -eq $text) { return $n } }
  return $null
}
function FindNodeFuzzy([string]$json, [string]$text) {
  foreach ($n in (GetNodes $json)) { if ($n.T.Trim() -eq $text) { return $n } }
  foreach ($n in (GetNodes $json)) { if ($n.T -like "*$text*") { return $n } }
  return $null
}

function ClickAt([int]$x, [int]$y) { Sh "uitest uiInput click $x $y" | Out-Null; Start-Sleep -Milliseconds 1200 }
function ClickNode([string]$json, [string]$text) {
  $n = FindNode $json $text
  if ($n) { ClickAt $n.X $n.Y; return $true }
  return $false
}
function PressBack() { Sh 'uitest uiInput keyEvent Back' | Out-Null; Start-Sleep -Seconds 2 }

# ★ 带空格的文本：逐词 text + 词间 keyEvent 2050（空格）
function TypeText([string]$text) {
  $words = ($text -split '\s+') | Where-Object { $_ -ne '' }
  $parts = @()
  for ($i = 0; $i -lt $words.Count; $i++) {
    if ($i -gt 0) { $parts += 'uitest uiInput keyEvent 2050' }
    $parts += ('uitest uiInput text ' + $words[$i])
  }
  if ($parts.Count -gt 0) { Sh ($parts -join '; ') | Out-Null }
  Start-Sleep -Milliseconds 800
  return $words.Count
}

function TypeIntoBox([string]$json, [string]$text) {
  $ph = @('描述你想要构建的内容，/ 调用指令，@ 文件或对话', '发消息或创建任务，/ 调用指令，@ 文件或对话', '添加文件或调用指令')
  $box = $null
  foreach ($p in $ph) { $box = FindNode $json $p; if ($box) { break } }
  if (-not $box) { return $false }
  ClickAt $box.X $box.Y
  Start-Sleep -Seconds 1
  TypeText $text | Out-Null
  return $true
}

function SendMessage([string]$json) {
  $n = FindNode $json '发送消息'
  if ($n) { ClickAt $n.X $n.Y; return $true }
  return $false
}

function Screenshot([string]$tag = 'shot') {
  $remote = "/data/local/tmp/dsh-$tag.jpeg"
  Sh "rm -f $remote" | Out-Null
  Sh "snapshot_display -f $remote" | Out-Null
  $local = Join-Path $script:UiTmp "$tag.jpeg"
  (& $script:HdcExe -t $script:DevSerial file recv $remote $local 2>&1 | Out-Null)
  if (Test-Path $local) { return $local }
  return ''
}

function AppPid() { return (Sh "pidof $script:AppBundle") }
function Port3080() { return ((Sh 'cat /proc/net/tcp') -match ':0C08') }
