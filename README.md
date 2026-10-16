# dsh-harmony

让**真正的 DeepSeek Harness（DSH）原生运行在鸿蒙手机**上 —— 不是遥控、不是投屏、不是套壳浏览器。

**当前状态：已跑通并持续验证中** ✓（47+ 次提交，12 个里程碑 tag）

---

> ## ⚠️ 开源版说明（与原开发仓库的差异）
>
> **本仓库不含 `dsh-payload.tar.gz`（DSH 本体的 JS 载荷）**，原因是版权：
> 那个文件是 `@deepseek-ai/dsh-desktop-runtime` 的完整分发（约 28 MB / 13837 个文件），
> **公开发布它等于重新分发别人的软件**。
>
> 它是**可再生的** —— 用你自己的 DSH 安装生成：
> ```powershell
> node tools/assemble-resfile.mjs "<你的 app.asar 路径>" dist/ohos-runtime.json `
>      harmony/entry/src/main/resources/resfile/dsh --overlay dist/ohos-overlay
> # 再把该目录打成单个 tar.gz 放到：
> #   harmony/entry/src/main/resources/rawfile/dsh-payload.tar.gz
> ```
>
> 另外这些也**不在本仓库里**（构建产物/凭据/二进制，都已脱敏排除）：
> `harmony/entry/libs/*.so`、`**/build/`、`**/oh_modules/`、`.hvigor/`、
> `credentials.yaml`、以及签名口令（`build-profile.json5` 里的
> `keyPassword`/`storePassword` 已清空，**必须由你填入自己的 DevEco 签名**）。
## 一句话现状

```
鸿蒙 App（ArkTS + ArkWeb）
  └─ NAPI 宿主壳 libnode_ctl.so（C++）
      └─ dlopen("libnode.so") → node::Start()    ← 真正的 Node.js v24.2.0，跑在 App 进程内
          └─ 解包并启动 DSH 本体（rawfile 里的 tar.gz）
              └─ dsh web @ http://127.0.0.1:3080/?token=…   ← ArkWeb 加载它
```
**真机实测**：`platform: openharmony / arch: arm64 / node v24.2.0`；
端上 agent **能独立完成真实任务**（创建文件、写入、读回、列出文件、网页检索、派子智能体）。

---

## 关键实测数字（真机）

| 项 | 值 |
|---|---|
| 端上 Node | **v24.2.0**（`platform: openharmony`, `arch: arm64`）|
| DSH 服务 | `http://127.0.0.1:3080/?token=…`（**仅回环**，不对局域网开放）|
| HAP 体积 | **71.8 MB**（开启 `.so` 压缩后；未压缩时 151.6 MB）|
| JS 载荷 | `dsh-payload.tar.gz` **28.1 MB** → 解包 **11419 个文件 / 111.6 MB**，端上 **1~2 秒**解完 |
| 可用工具 | **15 个**（`read` / `write` / `glob` / `grep` / **`phone_fs`（本项目新增：ls/stat/mkdir/rm/mv/cp/touch/head/tail/wc/unzip）** / `web_search` / `web_fetch` / `subagent` / `subagent_fork` / `todo_write` / `present` / `ask_user_question` / `get_goal` / `job_list` / `list_agents` / `send_message`）|
| 不可用工具 | **2 个**（`bash`、`workflow`）—— 均因**鸿蒙禁止 app 执行外部程序** ✗，详见下文 |
| 后台存活 | 切后台可用 **~3~4 分钟**（`requestSuspendDelay` 180 s + 自动续期）；无限常驻需扩展能力 |
| 已验证机型 | 华为 Mate 70 / HarmonyOS 7 / API 26（bundleName `com.dsh.harmony`）|

---

## 五步上手（假设已装 DevEco Studio，且 hdc 已连设备）

```powershell
# 1) 组装 JS 载荷（从 DSH 的 app.asar 抽取，产物可再生产）
node tools/assemble-resfile.mjs "<app.asar 路径>" dist/ohos-runtime.json `
     harmony/entry/src/main/resources/resfile/dsh --overlay dist/ohos-overlay
#    然后把该目录打成单个 tar.gz 放到 harmony/entry/src/main/resources/rawfile/dsh-payload.tar.gz

# 2) 一键构建（自带校验；-WithoutDsh = 只打 M1 小包）
pwsh -File tools/build-m1.ps1

# 3) 装机
hdc install -r harmony/entry/build/default/outputs/default/entry-default-signed.hap

# 4) 启动
hdc shell aa start -a EntryAbility -b com.dsh.harmony

# 5) 验证（把端上 3080 映射到电脑直接请求）
hdc fport tcp:13080 tcp:3080
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:13080/
#   期望 401（服务器活着但需要 token）—— 返回 000 表示进程已被系统冻结
```

**构建前提**：`libnode.so` 放在 `harmony/entry/libs/arm64-v8a/`（见 `docs/libnode-自建步骤.md`），
且 `libc++_shared.so` **必须同目录存在** ✗（缺它 `dlopen` 会静默失败，ArkTS 侧只拿到 `undefined`）。

---

## 平台适配总表（每一项都有实测出处）

> 全部通过 `dist/ohos-overlay/`（**覆盖文件，不改上游包** ✓ 可复现、可回滚）或宿主壳环境变量实现。

| # | 鸿蒙的限制 / 差异 | 症状 | 解法 |
|---|---|---|---|
| 1 | `libc++_shared.so` 不在包内 | ArkTS 拿到 `undefined`（**不报错** ✗）| 打进 HAP |
| 2 | `argc` 把 `nullptr` 哨兵算进去 | Node 拿到 NULL 参数，**5 ms 段错误** | `argc = argv.size() - 1` |
| 3 | **argv 顺序**：脚本必须在参数之前 | Node 去执行了 `dsh-payload.tar.gz`（`SyntaxError`）| 调整顺序（**args 为空时不会暴露** ✗）|
| 4 | `resfile/` 连 ArkTS 的 `fs` 都读不到 | `No such file or directory` | 改用 `rawfile/` + `resourceManager` |
| 5 | **解压器写的文件 Node 读不到** | `MODULE_NOT_FOUND`（同目录同进程 ✗）| **让 Node 自己解包**（tar.gz + `bootstrap.mjs`）|
| 6 | 被 `import()` 的 CLI 不会自跑 | 加载后静默退出（`import.meta.main` 恒 false）| 显式调用它导出的 `runCli()` |
| 7 | **`--jitless` 会关掉 WebAssembly** | `WebAssembly is not defined`（undici/fetch 崩）| 本机实测**不需要** `--jitless` |
| 8 | `os.homedir()` 指向沙箱外 | 文件选择器 `EPERM` | 宿主壳 `setenv("HOME", 沙箱内目录)` |
| 9 | **`flock(2)` 不支持** | `flock is not supported on openharmony-arm64` | 单进程场景视为总是获取成功 |
| 10 | **`link(2)` 被拒** | `EACCES: permission denied, link …` | `open(dst,'wx')`+复制（保 EEXIST 语义）/ `rename` |
| 11 | `glob`/`grep` 依赖 **ripgrep 可执行文件** | 无法 spawn（seccomp）| **纯 JS 复刻 `rg` 的输出契约** |
| 12 | HAP 里 `.so` **默认不压缩** | 包体虚高（151.6 MB）| `module.json5` module 级 `compressNativeLibs: true` |
| 16 | 内置文件工具**没有删除/移动/复制** | agent 报告 "no delete tool available" | **本项目新增 `phone_fs` 工具**（纯 JS，路径钉死在工作区内）|

### 让 agent「有手」的三处关键（第 13~15 项）

| # | 根因 | 修法 |
|---|---|---|
| 13 | `workspace-write` 需要**沙箱后端**（Linux 是 landlock），鸿蒙没有 ⇒ 首次写文件必失败 | 宿主壳 `setenv("DSH_PERMISSION_MODE","danger-full-access")`（这一个变量同时把审批策略变成 `never`）|
| 14 | `workspaceRoot` 取 `process.cwd()`，而默认是 `/`（不可写）| `bootstrap.mjs` 里 `process.chdir(沙箱 workspace)` |
| 15 | `dsh-fs-local` 用 `link(2)` 做独占发布 | overlay 改为"先试 link，失败退化 `wx`+复制" |

---

## 调试方法论（比结论更值钱）

### 三条独立通道（缺一不可）
| 通道 | 命令 | 用途 |
|---|---|---|
| 截图 | `hdc shell snapshot_display -f /data/local/tmp/s.jpeg` + `hdc file recv` | **自己看屏幕** |
| 点击 | `hdc shell uitest uiInput click <x> <y>` | **自己点按钮** |
| **日志回传** | `hdc rport tcp:19999 tcp:19999` + 端上 POST 到 `127.0.0.1:19999` | ★ **完整不截断的端上日志** |

⚠ **沙箱里的日志文件连 debug 签名也不让 hdc 读** ⇒ 日志回传是唯一可靠通道；
截图读日志会被截断 ✗。

### UI 自动化的三个坑（`tools/device-ui.ps1` 已固化）
1. **`uitest` / `snapshot_display` 只作用于【前台应用】** —— 手机上开着浏览器（如远程 DSH）时会抢前台，
   表现为"点了完全没反应" ⇒ **每次操作前必须 `EnsureForeground` 并确认 bundle 名**
2. **`hdc shell` 会剥掉引号** ⇒ 带空格文本必被设备 sh 拆开
   ⇒ 解法：**逐词 `uitest uiInput text <词>` + 词间插 `uitest uiInput keyEvent 2050`（空格键）**
3. **`keyEvent Back`** 能关掉 DSH 的选择器弹窗并确认选择，**但会让 App 退到后台** ⇒ 之后必须重新拉前台

### 通用心法
**先加可观测性，再改代码** —— 「把状态刷到 UI」→「日志回传」→「自己截屏/点击」。
**没有通道时的每一次改动都是盲猜** ✗。

---

## 已实测【此路不通】的清单（别再重试）

| 方向 | 结论与证据 |
|---|---|
| **突破应用沙箱** | ✗ 本机不支持：运行时申请返回 `authResults=[2,2]`（2=不受支持）、`getUserXxxDir()` 报 `801`、真实路径 `EPERM(13900001)`。**唯一合法通道是系统文件选择器** ✓ |
| **`bash` / 终端工具** | ✗ 不可能：`/bin/sh` 与 `/system/bin/sh` 都存在，但 `spawnSync` 返回 **EACCES**（seccomp 禁止 app 执行任何程序）|
| **`workflow` 工具** | ✗ 不可修：`dsh-ptc-runtime-node` 必须 `spawn(process.execPath)` 起子 Node 进程 ⇒ 与 seccomp 硬冲突。**用 `subagent` / `subagent_fork` 替代** ✓ |
| **无限后台常驻** | ✗ 普通应用做不到：`TASK_KEEPING` 报 `9800005`（本机不支持该类型）、`DATA_TRANSFER` 报 `9900002`（**进后台超时后不允许再申请**）⇒ 真常驻需 `ContinuousTaskExtensionAbility` |
| **进程外看门狗** | ✗ 这台设备做不到（**已实测**）：鸿蒙**有**运行时的 `childProcessManager`（`startChildProcess` / `startArkChildProcess` / **`startNativeChildProcess`**）✓，但我实测 `startArkChildProcess` 返回 **`Capability not support. (code=801)`**，hilog 里没有任何子进程入口日志 ⇒ **本机未实现该能力**。（规律：鸿蒙很多新能力"SDK 里有声明、设备未实现"，**看声明只能证明存在、不能证明可用**，必须真机试一次）|
| **选文件夹导入** | ~ 未打通：`MIXED` 模式点目录是"进入"（0/20 空操作）、`FOLDER` 模式点目录才"选中"，但选择器是**独立系统窗口**且 `dumpLayout` 时有时无 ⇒ 自动化成本过高。**文件导入已可用** ✓（149 MB 实测）|

---

## 上架状态

| 项 | 状态 |
|---|---|
| 权限精简 | ✓ 仅 2 项：`INTERNET` + `KEEP_BACKGROUND_RUNNING` |
| 隐私声明 | ✓ `docs/隐私声明.md`（与代码实际权限逐条对应）|
| 原创图标 | ✓ 程序化生成，脚本留证 `tools/make_icon_original.py` |
| 包体 | ✓ 71.8 MB（`compressNativeLibs`）|
| **发布证书** | ✗ 当前为 DevEco 自动签名（debug）⇒ **需在 AGC 换发布证书** |
| 市场素材 | ✗ 截图 / 描述 / 分类（人工环节）|
| 真常驻 | ✗ 需实现 `ContinuousTaskExtensionAbility` |

---

## 仓库结构

```
harmony/                     鸿蒙工程（Stage 模型）
  entry/src/main/cpp/        NAPI 宿主壳：detached 线程 + SIGSYS shim + 崩溃处理器
  entry/src/main/ets/        ArkTS UI：启动 Node、读日志、导入文件、保活、探针
  entry/src/main/resources/rawfile/
      bootstrap.mjs          ★ 端上解包器 + 启动 DSH（含 shell / cwd / 用户目录探针）
      dsh-payload.tar.gz     JS 载荷（**本开源版不包含**，须用 assemble-resfile.mjs 自行生成）
  entry/libs/arm64-v8a/      libnode.so / libc++_shared.so / libnode_ctl.so（gitignore）
tools/
  build-m1.ps1               ★ 一键构建（自带校验）
  assemble-resfile.mjs       从 app.asar 组装运行包 + 应用 overlay
  make-prune-plan.mjs        从官方清单推裁剪计划（三档分类 + 体积统计）
  make-ohos-runtime-manifest.mjs  生成鸿蒙版运行包清单（自带 14 项校验）
  device-ui.ps1              ★ 与手机可靠交互的工具集（前台校验 / 逐词输入 / 坐标解析）
  make_icon_original.py      原创图标生成（留证）
  asar-extract.mjs           通用 asar 工具（零依赖）
  verify-shim.mjs            JS 桩自检
dist/
  ohos-runtime.json          鸿蒙运行包清单
  ohos-overlay/              ★ 平台适配（6 个覆盖文件，可复现）
  prune-plan.json            裁剪明细
docs/
  技术方案.md / 参考实现-构建要点.md / libnode-自建步骤.md / 动手手册.md
  M2融合与后续路线.md / 隐私声明.md
```

---

## 更多文档

- **技术方案**（目标 / 验收、路径对比、风险清单、分阶段计划）→ [`docs/技术方案.md`](docs/技术方案.md)
- **自建 libnode.so**（含"必须是真共享库、无 PT_INTERP"等硬约束）→ [`docs/libnode-自建步骤.md`](docs/libnode-自建步骤.md)
- **动手手册** → [`docs/动手手册.md`](docs/动手手册.md)
- **隐私声明**（上架用）→ [`docs/隐私声明.md`](docs/隐私声明.md)
- **本项目踩过的坑全集** → `~/.dsh/AGENTS.md` 第十三~二十章 + skill `harmonyos-native-node`

---

*最后更新：2026-10-08（对应 tag `v1.9-glob-fixed` / HAP 71.8 MB / 47 次提交）*
