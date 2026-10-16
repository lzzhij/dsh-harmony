# build-m1.ps1 —— 一键构建 M1 骨架（native + ArkTS + HAP），并校验 HAP 内容
#
# 本脚本把踩过的坑都固化进去了：
#   ① ArkTS 侧 import 原生模块 → 必须在 entry/oh-package.json5 声明 file: 依赖，且要 ohpm install
#   ② native 产物必须落到 entry/libs/<abi>/，hvigor 才会打包（否则 HAP 里没有 libs/）
#   ③ 需要 libnode.so 才能上机（本脚本只检查在不在，不下载）
#
# 用法：pwsh -File tools/build-m1.ps1 [-Product default|test] [-SkipNative]
param(
  [ValidateSet('default','test')][string]$Product = 'default',
  [switch]$SkipNative,
  # M1 阶段不需要背着 106MB 的 DSH 载荷；加 -WithoutDsh 会把 resfile/dsh 临时搬走再构建
  [switch]$WithoutDsh
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$root      = Split-Path -Parent $PSScriptRoot
$harmony   = Join-Path $root 'harmony'
$ndk       = 'F:\DevEco Studio\sdk\default\openharmony\native'
$cmake     = Join-Path $ndk 'build-tools\cmake\bin\cmake.exe'
$ninja     = Join-Path $ndk 'build-tools\cmake\bin\ninja.exe'
$ohpm      = 'F:\DevEco Studio\tools\ohpm\bin\ohpm.bat'
$nodeExe   = 'F:\DevEco Studio\tools\node\node.exe'
$hvigor    = 'F:\DevEco Studio\tools\hvigor\bin\hvigorw.js'
$cppDir    = Join-Path $harmony 'entry\src\main\cpp'
$libsDir   = Join-Path $harmony 'entry\libs\arm64-v8a'

function Step($n, $t) { Write-Host ''; Write-Host ("=== $n) $t ===") -ForegroundColor Cyan }
function Ok($m) { Write-Host ("  [OK] $m") -ForegroundColor Green }
function Bad($m) { Write-Host ("  [!!] $m") -ForegroundColor Red }

Step 1 '环境'
$env:DEVECO_SDK_HOME = 'F:\DevEco Studio\sdk'
$env:JAVA_HOME       = 'F:\DevEco Studio\jbr'
$env:_JAVA_OPTIONS   = '-Xmx768m'
$env:JAVA_TOOL_OPTIONS = '-Xmx768m'
$env:PATH = 'F:\DevEco Studio\jbr\bin;F:\DevEco Studio\tools\node;F:\DevEco Studio\tools\ohpm\bin;' + $env:PATH
foreach ($p in @($cmake,$ninja,$ohpm,$nodeExe,$hvigor)) {
  if (Test-Path $p) { Ok $p } else { Bad "缺失: $p" }
}

# ★ 凭据注入：App 的 <DSH_HOME>/.credentials.yaml 就来自这里。
#   为什么必须在【构建时】注入：hdc 以 shell 身份跑，写不进 App 私有沙箱
#   （实测 hdc file send / shell cp 都是 permission denied ✗），
#   所以只能走「放进 rawfile → App 自己用 writeRaw 复制」这条路 ✓。
#   该文件已被 .gitignore 排除 ⇒ 密钥只在构建产物里存在，永不入库 ✓
Step 2.5 '注入 API 凭据（可选；缺失只告警，不中断构建）'
$credSrc = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'
$credDst = Join-Path $harmony 'entry\src\main\resources\rawfile\credentials.yaml'
if (Test-Path $credSrc) {
  Copy-Item -LiteralPath $credSrc -Destination $credDst -Force
  Ok ("已注入凭据 {0} B（gitignore 已排除，不入库）" -f (Get-Item $credDst).Length)
} else {
  Write-Host "  ! 未找到 $credSrc" -ForegroundColor Yellow
  Write-Host "    => App 装好后需要手填 API Key，否则提问会报 MISSING_CREDENTIAL" -ForegroundColor Yellow
  if (Test-Path $credDst) {
    Remove-Item -LiteralPath $credDst -Force
    Write-Host "    已清掉上次遗留的 rawfile/credentials.yaml（避免装进过期的密钥）" -ForegroundColor Yellow
  }
}

if (-not $SkipNative) {
  Step 2 '编译 native 宿主壳（产物直接落到 entry/libs/<abi>/）'
  if (-not (Test-Path (Join-Path $cppDir 'build'))) {
    & $cmake -S $cppDir -B (Join-Path $cppDir 'build') -G Ninja `
      ("-DCMAKE_TOOLCHAIN_FILE=" + (Join-Path $ndk 'build\cmake\ohos.toolchain.cmake')) `
      '-DOHOS_ARCH=arm64-v8a' ("-DCMAKE_MAKE_PROGRAM=$ninja") 2>&1 |
      Select-String -Pattern 'native output dir|Configuring done|error' | ForEach-Object { '  ' + $_.Line.Trim() }
  }
  & $cmake --build (Join-Path $cppDir 'build') 2>&1 | Select-Object -Last 4 | ForEach-Object { '  ' + $_ }
  if ($LASTEXITCODE -eq 0) { Ok 'native 编译通过' } else { Bad 'native 编译失败'; exit 1 }
}

Step 3 '检查 libnode.so（上机必需）'
$libnode = Join-Path $libsDir 'libnode.so'
if (Test-Path $libnode) {
  Ok ("libnode.so 存在  {0:N1} MB" -f ((Get-Item $libnode).Length/1MB))
  $readelf = Join-Path $ndk 'llvm\bin\llvm-readelf.exe'
  if (Test-Path $readelf) {
    $hdr = & $readelf -h $libnode 2>&1 | Select-String -Pattern 'Type:'
    $itp = & $readelf -l $libnode 2>&1 | Select-String -Pattern 'INTERP'
    if ($hdr) { Ok ('ELF: ' + $hdr.Line.Trim()) }
    if ($itp) { Bad 'libnode.so 含 INTERP 段 —— 它是 PIE，dlopen 会崩，必须换 --shared 版本' } else { Ok 'libnode.so 无 INTERP（真共享库）' }
  }
} else {
  Bad '没有 libnode.so —— 可从 electerm/ohos-node-shared release 下载 libnode-arm64.so'
  Bad '（没有它 HAP 仍能构建，但上机后 node::Start 会因为 dlopen 失败而起不来）'
}

$resfileDsh = Join-Path $harmony 'entry\src\main\resources\resfile\dsh'
$stashPath = $null
if ($WithoutDsh -and (Test-Path $resfileDsh)) {
  Step 3.5 '临时搬走 DSH 载荷（-WithoutDsh）'
  $stashPath = Join-Path $env:TEMP ('dsh-resfile-stash-' + (Get-Date -Format 'HHmmss'))
  Move-Item -LiteralPath $resfileDsh -Destination $stashPath -Force
  Ok ('已搬到 ' + $stashPath + '（构建完会自动搬回）')
}

Step 4 'ohpm install（file: 依赖必须装一次，否则 ArkTS 侧原生模块解析成 any）'
Push-Location $harmony
try {
  & $ohpm install 2>&1 | Select-Object -Last 4 | ForEach-Object { '  ' + $_ }
  if ($LASTEXITCODE -eq 0) { Ok 'ohpm ok' } else { Bad 'ohpm 失败' }
} finally { Pop-Location }

Step 5 "hvigor assembleHap (product=$Product)"
Push-Location $harmony
try {
  $out = & $nodeExe $hvigor --mode module -p module=entry@default -p product=$Product -p buildMode=release assembleHap --no-daemon 2>&1
  $code = $LASTEXITCODE
  $out | Select-String -Pattern 'ERROR|Error Message|BUILD SUCCESSFUL|BUILD FAILED' | ForEach-Object { '  ' + ($_.Line -replace "`e\[[0-9;]*m",'').Trim() }
} finally { Pop-Location }
if ($code -ne 0) { Bad 'hvigor 失败'; exit 1 }
Ok 'hvigor 构建通过'

Step 6 '校验 HAP 内容'
$hap = Get-ChildItem -LiteralPath $harmony -Recurse -File -ErrorAction SilentlyContinue |
       Where-Object { $_.Extension -eq '.hap' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $hap) { Bad '没找到 HAP'; exit 1 }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead($hap.FullName)
$names = $z.Entries | ForEach-Object { $_.FullName }
$z.Dispose()
Ok ("HAP: {0}  ({1:N0} 字节)" -f $hap.Name, $hap.Length)
$must = @{ 'ets/modules.abc' = 'ArkTS 产物'; 'resources/resfile/bootstrap/hello.js' = 'M1 入口脚本' }
foreach ($k in $must.Keys) {
  if ($names -contains $k) { Ok ("含 " + $k + "  (" + $must[$k] + ")") } else { Bad ("缺 " + $k) }
}
$soEntries = $names | Where-Object { $_ -match '^libs/.*\.so$' }
if ($soEntries) {
  $soEntries | ForEach-Object { Ok ("含 " + $_) }
} else {
  Bad 'HAP 里没有 libs/**/*.so —— 检查 CMakeLists 的 CMAKE_LIBRARY_OUTPUT_DIRECTORY 是否指向 entry/libs/<abi>/'
}
if ($names -match 'libs/arm64-v8a/libnode\.so') { Ok '含 libnode.so（上机时 node 才能起来）' }
else { Write-Host '  [--] HAP 里没有 libnode.so —— 若它放在 libs/ 下但没进包，检查 .gitignore/打包排除规则' -ForegroundColor Yellow }

if ($stashPath -and (Test-Path $stashPath)) {
  Move-Item -LiteralPath $stashPath -Destination $resfileDsh -Force
  Ok 'DSH 载荷已搬回原位'
}

Write-Host ''
Write-Host '完成。产物：' -ForegroundColor Green
Write-Host ('  ' + $hap.FullName)