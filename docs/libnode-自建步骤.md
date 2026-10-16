# 自建可嵌入的 `libnode.so`（OpenHarmony / arm64）

> 什么时候需要它：DSH 官方运行包声明 **`nodeVersion: 24.18.1`**，
> 而现成可嵌入的 `libnode.so`（`electerm/ohos-node-shared`）是 **24.2.0**。
> 若实测 24.2.0 不够用，就按本文自建 **`--shared`** 版本。

---

## 0. 先试便宜的方案（顺序很重要）

| 顺序 | 方案 | 成本 | 说明 |
|---|---|---|---|
| 1 | **直接用 24.2.0**（electerm 的 release） | 几分钟 | 同一大版本；N-API v9 ABI 稳定 ⇒ 原生模块不受影响；风险只在"DSH 是否用到 24.3+ 的 Node API" |
| 2 | **自建 `--shared` 的 24.18.1 / 24.21.0** | 1~2 小时（含环境） | 见下文。同一份源码，只比 `hqzing` 多一个 `--shared` |

> `hqzing/ohos-node` 已经发布了 **v24.21.0** —— 但那是 **PIE 可执行文件** ✗。
> **PIE 不能被 `dlopen`**：它会把 local-exec `%fs` TLS 别名到宿主 App 的 TLS 块，
> V8 的 `thread_local current_per_thread_assert_data` 读到垃圾，
> release 版 `CHECK AllowHeapAllocationInRelease` 在 `Isolate::Initialize`
> **第一次堆分配就崩**。所以必须自己用 `--shared` 构建。

---

## 1. 环境与资源（★ 有个容易踩的坑）

| 项 | 要求 |
|---|---|
| 主机 | **Linux x64**（交叉编译 arm64）|
| 工具链 | OpenHarmony SDK 的 **LLVM-19**（`aarch64-unknown-linux-ohos-clang`）|
| 磁盘 | ≥ 20 GB（源码 + 产物）|
| **内存** | **★ 建议 ≥ 8 GB 或加 swap** —— 见下 |

> **★ 内存坑**：Node 的构建（尤其链接 + V8 的 `mksnapshot`）在 **2 vCPU / 1.6 GB 且无 swap**
> 的机器上**极可能 OOM**。你那台阿里云正是 2 vCPU / 1.6 GB / **无 swap**。
> 两条路：
> 1. **临时加 swap**（最快）：`fallocate -l 4G /swap && chmod 600 /swap && mkswap /swap && swapon /swap`
>    （构建完 `swapoff /swap && rm /swap`，别长期留着占盘）
> 2. **本机 Docker Desktop 构建**（Windows 上跑 Linux 容器；内存由电脑提供，更宽裕）
> 3. 或临时升配服务器规格后再降回

---

## 2. 交叉编译配方（来自 `hqzing/ohos-node/build.sh` 实测）

```bash
# 关键环境变量（注意 -fno-emulated-tls）
export CC="$SDK/llvm-19/llvm/bin/aarch64-unknown-linux-ohos-clang   -fno-emulated-tls"
export CXX="$SDK/llvm-19/llvm/bin/aarch64-unknown-linux-ohos-clang++ -fno-emulated-tls"

CONFIGURE_ARGS="
  --dest-cpu=arm64
  --cross-compiling
  --shared                      # ★★ 与 hqzing 的唯一区别：产出真共享库（PIC + 动态 TLS + SONAME）
  --without-npm
  --without-corepack
"

# OHOS 交叉编译下 Temporal 会导致构建失败，必须关闭
if ./configure --help 2>&1 | grep -q -- '--v8-disable-temporal-support'; then
  CONFIGURE_ARGS="$CONFIGURE_ARGS --v8-disable-temporal-support"
fi

./configure $CONFIGURE_ARGS
make -j$(nproc)          # 2 核机器建议 -j2，并留意内存
```

`hqzing` 的补丁（可一并套用）：
- `0001-fix-argument-list-too-long.patch`
- `0002-use-C++20-for-Node.js-core.patch`

---

## 3. 产物校验（**必做**，否则会崩在手机上）

```bash
# 1) 必须是 ET_DYN 且【没有 PT_INTERP】—— 有 PT_INTERP 就是 PIE，dlopen 必崩
readelf -h libnode.so | grep -E 'Type|Machine'
readelf -l libnode.so | grep -c INTERP      # 期望 0

# 2) 应有 SONAME（形如 libnode.so.24）
readelf -d libnode.so | grep SONAME

# 3) 架构应为 AArch64
file libnode.so

# 4) 签名：鸿蒙商用版校验 ELF 代码签名，没有 .codesign section 装上也用不了
readelf -S libnode.so | grep -i codesign    # 期望能查到
# 若未签名，用 OHOS 工具链签：
$SDK/ohos-sdk/linux/toolchains/lib/binary-sign-tool sign \
  --in-file libnode.so --out-file libnode.signed.so --selfSign 1
```

**启动侧还需注意**（详见 [参考实现-构建要点.md](参考实现-构建要点.md)）：
- 启动参数 `--jitless --no-verify-heap`
- `UV_USE_IO_URING=0` + `io_uring_setup` 的 **SIGSYS shim**（把 trap 转成**正好 `-1`**）
- 设 `NODE_OPTIONS` 时注意：**`--expose-internals` 必须走 argv**（我们的 JS 桩依赖它）

---

## 4. 放进 App

```
entry/libs/arm64-v8a/libnode.so      ← 本产物（hvigor 会打进 HAP 的 native libs 目录）
```
运行时由 `libnode_ctl.so` 用 `dlopen` 从该目录加载（见参考实现要点）。

---

## 5. 备选：直接复用现成产物

| 来源 | 形态 | 可用性 |
|---|---|---|
| `electerm/ohos-node-shared` release `ohos-node-shared-v24.2.0` | **真共享库** ✓ | 版本 24.2.0，**先试这个** |
| `hqzing/ohos-node` release `v24.21.0` | **PIE** ✗ | ✗ 不能 dlopen（只能当独立进程跑）|

---

## 6. 决策建议

1. **M1 阶段就用 24.2.0** —— 先把"Node 能在鸿蒙起来 + ArkWeb 能显示"跑通（与 Node 版本无关）
2. **M2 阶段验证 DSH 是否能跑** —— 报错集中在 API 缺失才自建
3. 自建时**先加 swap 或改用本机 Docker**，避免在 1.6 GB 无 swap 的服务器上白等一场
