// node_ctl.cpp —— DSH on HarmonyOS 的 NAPI 宿主壳（T9）
//
// 职责：把 OpenHarmony 的 libnode.so 以【进程内】方式启动起来，并给 ArkTS 提供控制接口。
//
// 设计要点全部来自已上架应用 electerm-harmony 的实测结论（见 docs/参考实现-构建要点.md）：
//   1) dlopen + node::Start 必须放在【后台线程】—— 内联会阻塞 ArkTS UI 线程到触发 APP_INPUT_BLOCK ANR
//   2) 启动参数必须带 --jitless --no-verify-heap（否则 V8 的 PROT_EXEC 被鸿蒙 W^X 策略拒绝 → SIGTRAP）
//   3) libuv 会无条件探测 io_uring_setup(425)，被沙箱 seccomp trap → 需把 SIGSYS 转成【正好 -1】
//   4) 必须装崩溃信号处理器：把 backtrace 写进 node-boot.log，并【把 node 线程停住】而不是让它死
//   5) --expose-internals 让 require("internal/...") 可用，从而不需要原生 require-builtin 插件
//
// NAPI 模块名: node_ctl      导出: startBackend / getBackendStatus / killNode / getNodeApiVersion
#include <node_api.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <chrono>

#include <dlfcn.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <ucontext.h>
#include <execinfo.h>
#include <sys/stat.h>
#include <sys/syscall.h>

#include <hilog/log.h>

#undef LOG_TAG
#define LOG_TAG "DshNodeHost"
#define LOGI(...) OH_LOG_Print(LOG_APP, LOG_INFO,  0x2A11, LOG_TAG, __VA_ARGS__)
#define LOGW(...) OH_LOG_Print(LOG_APP, LOG_WARN,  0x2A11, LOG_TAG, __VA_ARGS__)
#define LOGE(...) OH_LOG_Print(LOG_APP, LOG_ERROR, 0x2A11, LOG_TAG, __VA_ARGS__)

// ------------------------------------------------------------------ 状态

namespace {

constexpr int kMaxArgv = 64;

std::atomic<int> g_state{0};           // 0=未启动 1=启动中 2=运行中 3=已退出 4=失败
std::atomic<int> g_exitCode{-1};
std::atomic<bool> g_starting{false};
std::mutex g_logMutex;
FILE* g_bootLog = nullptr;
std::string g_logPath;

// 线程内上下文（node 主线程用）
struct LaunchCtx {
  std::string libnodePath;
  std::string scriptPath;
  std::string appDir;      // resfile/<app> 的绝对路径
  std::string dataDir;     // filesDir/<app>-data
  std::vector<std::string> argvStore;
  std::vector<char*> argv;
  int exitCode = -1;
};

// ---------------------------------------------------------------- 日志

void bootLogOpen(const std::string& dir) {
  std::lock_guard<std::mutex> lk(g_logMutex);
  if (g_bootLog) return;
  ::mkdir(dir.c_str(), 0700);
  g_logPath = dir + "/node-boot.log";
  g_bootLog = ::fopen(g_logPath.c_str(), "a");
  if (g_bootLog) {
    ::setvbuf(g_bootLog, nullptr, _IOLBF, 0);
    std::fprintf(g_bootLog, "\n===== node-boot.log opened =====\n");
  }
}

void bootLog(const char* fmt, ...) {
  char buf[2048];
  va_list ap;
  va_start(ap, fmt);
  ::vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  {
    std::lock_guard<std::mutex> lk(g_logMutex);
    if (g_bootLog) { std::fprintf(g_bootLog, "%s\n", buf); }
  }
  LOGI("%{public}s", buf);
}

// ------------------------------------------------- SIGSYS shim（io_uring）

// libuv 在 loop init 里无条件调用 io_uring_setup(425)。鸿蒙沙箱用 seccomp 把它 trap 成 SIGSYS。
// 处理办法：把 SIGSYS 转成【正好 -1】（不是 -ENOSYS！），libuv 的守卫才会当作"不支持"而正常继续。
void sigsysHandler(int, siginfo_t* si, void* uctx) {
  if (si && si->si_code == SI_KERNEL && si->si_errno == 0) {
    // 无法从 siginfo 直接拿到 syscall 号，统一按 io_uring 处理：
    // 把返回值寄存器设为 -1，并跳过该指令。
    ucontext_t* uc = reinterpret_cast<ucontext_t*>(uctx);
    if (uc) {
      // aarch64: x0 = 返回值
      uc->uc_mcontext.regs[0] = static_cast<unsigned long>(-1);
      bootLog("[sigsys] io_uring_setup trapped -> forced -1 (libuv guard will treat as unsupported)");
      return;
    }
  }
  bootLog("[sigsys] unexpected SIGSYS (code=%d) -> forced -1", si ? si->si_code : -999);
  ucontext_t* uc = reinterpret_cast<ucontext_t*>(uctx);
  if (uc) uc->uc_mcontext.regs[0] = static_cast<unsigned long>(-1);
}

void installSigsysShim() {
  // 让 libuv 自己别用 io_uring（双重保险）
  ::setenv("UV_USE_IO_URING", "0", 1);

  struct sigaction sa;
  ::memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = sigsysHandler;
  sa.sa_flags = SA_SIGINFO | SA_RESTART;
  ::sigemptyset(&sa.sa_mask);
  if (::sigaction(SIGSYS, &sa, nullptr) != 0) {
    bootLog("[sigsys] sigaction(SIGSYS) failed");
  } else {
    bootLog("[sigsys] shim installed");
  }
}

// ------------------------------------------------- 崩溃处理器（留证据）

// 把 backtrace 写进 boot log，然后【把线程停住】而不是让进程死掉——
// 这样 ArkTS 侧还能读到状态、还能重启后端。
void crashHandler(int sig, siginfo_t* si, void* uctx) {
  void* frames[48];
  int n = ::backtrace(frames, 48);
  char pc[64] = "?";
  if (uctx) {
    ucontext_t* uc = reinterpret_cast<ucontext_t*>(uctx);
    std::snprintf(pc, sizeof(pc), "0x%lx", static_cast<unsigned long>(uc->uc_mcontext.pc));
  }
  {
    std::lock_guard<std::mutex> lk(g_logMutex);
    if (g_bootLog) {
      std::fprintf(g_bootLog, "\n*** CRASH sig=%d code=%d pc=%s ***\n", sig, si ? si->si_code : -1, pc);
      ::fflush(g_bootLog);
      ::backtrace_symbols_fd(frames, n, ::fileno(g_bootLog));
      std::fprintf(g_bootLog, "*** node thread parked ***\n");
      ::fflush(g_bootLog);
    }
  }
  // ★ 关键：同时打到 hilog —— 崩溃在信号上下文里写 hilog 并不严格安全，
  //   但这是【唯一能被外部（hdc/hilog）读到的通道】：应用沙箱里的 node-boot.log
  //   连 debug 签名都不让 hdc 读（实测 permission denied），所以必须打 hilog。
  LOGW("*** CRASH sig=%d code=%d pc=%s ***", sig, si ? si->si_code : -1, pc);
  for (int i = 0; i < n && i < 8; ++i) {
    LOGW("  crash frame[%d]=%p", i, frames[i]);
  }
  LOGW("*** node thread parked, state=4 ***");
  g_state.store(4);
  g_starting.store(false);   // 复位以允许重启
  // 停住当前线程（不返回），避免带病继续执行
  for (;;) { ::pause(); }
}

void installCrashHandlers() {
  const int sigs[] = {SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGTRAP};
  struct sigaction sa;
  ::memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = crashHandler;
  sa.sa_flags = SA_SIGINFO | SA_RESTART;
  ::sigemptyset(&sa.sa_mask);
  for (int s : sigs) ::sigaction(s, &sa, nullptr);
  bootLog("[crash] handlers installed for SEGV/ABRT/BUS/ILL/FPE/TRAP");
}

// ------------------------------------------- 重定向 node 的 stdout/stderr
// 为什么必须做：node 的启动输出（含它实际监听的 URL/端口）默认写到 App 的 stdout，
// 进程内嵌入时抓不到 ⇒ M2 无法知道该连哪个端口。所以先 dup2 到文件，再交给 node。
int g_savedStdout = -1;
int g_savedStderr = -1;

void redirectStdio(const std::string& dir) {
  const std::string outPath = dir + "/node-stdout.log";
  int fd = ::open(outPath.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd < 0) {
    bootLog("[stdio] 打不开 %s，保持原样", outPath.c_str());
    return;
  }
  ::fflush(stdout);
  ::fflush(stderr);
  g_savedStdout = ::dup(STDOUT_FILENO);
  g_savedStderr = ::dup(STDERR_FILENO);
  ::dup2(fd, STDOUT_FILENO);
  ::dup2(fd, STDERR_FILENO);
  ::close(fd);
  bootLog("[stdio] node 的 stdout/stderr 已重定向到 %s", outPath.c_str());
}

void restoreStdio() {
  if (g_savedStdout >= 0) { ::dup2(g_savedStdout, STDOUT_FILENO); ::close(g_savedStdout); g_savedStdout = -1; }
  if (g_savedStderr >= 0) { ::dup2(g_savedStderr, STDERR_FILENO); ::close(g_savedStderr); g_savedStderr = -1; }
}

// ----------------------------------------------------- 启动 node（后台线程）

// ★★ 符号名以【真实 libnode.so】的导出表为准（用 llvm-nm -D 读出来的）：
//     electerm/ohos-node-shared 的 libnode-arm64.so(v24.2.0) 导出的其实是：
//         _ZN4node5StartEiPPc   →   node::Start(int, char**)
//     （而 node::Start(int, char const* const*) → _ZN4node5StartEiPKPKc 只在我本机
//       用 clang 合成的目标文件里出现过，那个二进制里【并没有】）
//   两种签名各配一个函数指针类型才是干净的写法。
using StartFnCharPP  = int (*)(int, char**);              // node::Start(int, char**)
using StartFnConstPP = int (*)(int, const char* const*);  // node::Start(int, char const* const*)

struct StartSymbol {
  const char* name;
  bool takesConst;      // true → 用 StartFnConstPP 调用
};

const StartSymbol kStartSymbols[] = {
  {"_ZN4node5StartEiPPc",   false},   // ★ 实测存在（真实 libnode.so 里的就是它）
  {"_ZN4node5StartEiPKPKc", true },   // 有些构建用 const 版本
  {"_ZN4node5StartEiPPKc",  false},   // 历史写法兜底
  {"node::Start",           false},   // 万一有 C 导出
};

void bootstrapThread(LaunchCtx* ctx) {
  // ★ 这个线程里做 dlopen/dlsym/node::Start —— 绝不能放在 ArkTS UI 线程
  bootLog("[boot] thread start, libnode=%s", ctx->libnodePath.c_str());

  installSigsysShim();
  installCrashHandlers();

  dlerror();
  void* h = ::dlopen(ctx->libnodePath.c_str(), RTLD_NOW | RTLD_GLOBAL);
  if (!h) {
    const char* e = ::dlerror();
    bootLog("[boot] dlopen FAILED: %s", e ? e : "(no detail)");
    g_state.store(4);
    g_starting.store(false);   // 复位以允许重启
    delete ctx;
    return;
  }
  bootLog("[boot] dlopen ok");

  void* startSym = nullptr;
  bool takesConst = false;
  for (const StartSymbol& s : kStartSymbols) {
    void* sym = ::dlsym(h, s.name);
    bootLog("[boot] dlsym(%s) -> %s", s.name, sym ? "ok" : "null");
    if (sym) { startSym = sym; takesConst = s.takesConst; break; }
  }
  if (!startSym) {
    bootLog("[boot] FATAL: node::Start not found in libnode.so（试过 %zu 个候选符号）",
            sizeof(kStartSymbols) / sizeof(kStartSymbols[0]));
    g_state.store(4);
    g_starting.store(false);   // 复位以允许重启
    delete ctx;
    return;
  }
  bootLog("[boot] using %s (%s)", takesConst ? "const-variant" : "char**-variant",
          takesConst ? "_ZN4node5StartEiPKPKc" : "_ZN4node5StartEiPPc");

  g_state.store(2);
  // ★★★ 关键：ctx->argv 末尾压了一个 nullptr 哨兵，argc 必须【排除它】。
  //   之前直接传 argv.size()（含哨兵），Node 会拿到一个 NULL 参数，
  //   实测在 node::Start 内 5 毫秒就段错误（日志里能直接看到 argv[N]=(null)）。
  const int argc = static_cast<int>(ctx->argv.size()) - 1;
  bootLog("[boot] node pid=%d, argc=%d (argv 末位是哨兵,已排除)", static_cast<int>(::getpid()), argc);
  // ★★ 必须在 libuv 初始化【之前】设好：OHOS 的 seccomp 会 trap io_uring_setup，
  //    只靠 SIGSYS shim 兜底不够保险（移植文档把这一条列为必做）。
  ::setenv("UV_USE_IO_URING", "0", 1);
  ::setenv("UV_THREADPOOL_SIZE", "4", 1);
  // ★ M2：DSH 需要一个可写的 DSH_HOME（它会在下面建 profiles/<name>、storages 等）
  if (!ctx->dataDir.empty()) {
    ::setenv("DSH_HOME", ctx->dataDir.c_str(), 1);
    ::setenv("NODE_ENV", "production", 1);
    bootLog("[boot] env DSH_HOME=%s", ::getenv("DSH_HOME"));
  }
  // ★ 鸿蒙沙箱：应用【读不到】/storage/Users/currentUser（实测 EPERM）✗
  //   而 Node 的 os.homedir() 取 $HOME —— DSH 的文件选择器默认从 homedir 开始，
  //   所以把它指到沙箱内【可读可写】的父目录（即 <filesDir>），选择器就能正常浏览。
  //   真正读手机文件要靠系统文件选择器授权（后续 M5 用 NAPI 桥接）。
  if (!ctx->dataDir.empty()) {
    std::string homeDir = ctx->dataDir;
    const size_t slash = homeDir.find_last_of('/');
    if (slash != std::string::npos && slash > 0) homeDir = homeDir.substr(0, slash);
    ::setenv("HOME", homeDir.c_str(), 1);
    ::setenv("USERPROFILE", homeDir.c_str(), 1);
    bootLog("[boot] env HOME=%s (沙箱内可读目录，替代沙箱外的 /storage/Users/currentUser)", ::getenv("HOME"));
  // ★★★ 让 agent 真正"有手"的关键开关（2026-10-07 夜找到）
  //   依据 @deepseek-ai/dsh-base/cordis.patch.yml：
  //     sandbox-policy.config.mode   = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
  //     approval.config.policy       = (DSH_PERMISSION_MODE === 'danger-full-access') ? 'never' : 'ask'
  //   而 workspace-write 需要一个"沙箱后端"（Linux 上是 landlock，鸿蒙上没有）
  //   ⇒ 实测现象：agent 第一次写文件就报 sandbox mode 错误，随后想升级权限又要审批，
  //     审批不可用时按 fail-closed 处理 ⇒ 表现为"只有脑子没有手"。
  //   设成 danger-full-access 后：沙箱全开 + 审批 never ⇒ 文件工具第一次就成功。
  ::setenv("DSH_PERMISSION_MODE", "danger-full-access", 1);
  bootLog("[boot] env DSH_PERMISSION_MODE=%s", ::getenv("DSH_PERMISSION_MODE"));
  }
  bootLog("[boot] env UV_USE_IO_URING=%s", ::getenv("UV_USE_IO_URING") ? ::getenv("UV_USE_IO_URING") : "(null)");
  redirectStdio(ctx->dataDir);          // ★ 之后 node 的输出都进 node-stdout.log
  bootLog("[boot] calling node::Start with argc=%d（不带哨兵）", argc);
  for (size_t i = 0; i < ctx->argv.size(); ++i) bootLog("[boot]   argv[%zu]=%s", i, ctx->argv[i]);

  const auto t0 = std::chrono::steady_clock::now();
  int rc;
  if (takesConst) {
    auto fn = reinterpret_cast<StartFnConstPP>(startSym);
    rc = fn(argc, const_cast<const char* const*>(ctx->argv.data()));
  } else {
    auto fn = reinterpret_cast<StartFnCharPP>(startSym);
    rc = fn(argc, ctx->argv.data());
  }
  restoreStdio();                       // 恢复 app 自己的输出
  const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - t0).count();
  ctx->exitCode = rc;
  g_exitCode.store(rc);
  g_state.store(3);
  g_starting.store(false);   // node 已退出，允许重启
  bootLog("[boot] node::Start returned %d（运行了 %lld ms）", rc, static_cast<long long>(ms));
  delete ctx;
}

// ------------------------------------------------------------------ 工具

// 用 dladdr 取"本模块自己"的路径，从而推断同目录下的 libnode.so ——
// 比让 ArkTS 侧猜路径可靠（libs/<abi>/ 的实际布局随打包方式而变）。
std::string selfDirFromDladdr() {
  Dl_info info;
  if (::dladdr(reinterpret_cast<void*>(&selfDirFromDladdr), &info) && info.dli_fname) {
    std::string p(info.dli_fname);
    const size_t slash = p.find_last_of('/');
    if (slash != std::string::npos) return p.substr(0, slash);
  }
  return std::string();
}

std::string getStringProp(napi_env env, napi_value obj, const char* key, const char* dflt) {
  napi_value v;
  if (napi_get_named_property(env, obj, key, &v) != napi_ok) return dflt;
  napi_valuetype t;
  if (napi_typeof(env, v, &t) != napi_ok || t != napi_string) return dflt;
  size_t len = 0;
  if (napi_get_value_string_utf8(env, v, nullptr, 0, &len) != napi_ok) return dflt;
  std::string s(len, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, v, &s[0], len + 1, &written) != napi_ok) return dflt;
  s.resize(written);
  return s;
}

napi_value makeStr(napi_env env, const std::string& s) {
  napi_value v;
  napi_create_string_utf8(env, s.c_str(), s.size(), &v);
  return v;
}

// ------------------------------------------------------------ NAPI 接口

// startBackend({ libnode, script, appDir, dataDir, args?: string[] })
napi_value StartBackend(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  bool expected = false;
  if (!g_starting.compare_exchange_strong(expected, true)) {
    bootLog("[api] startBackend called while already starting/running");
    return makeStr(env, "already-started");
  }

  LaunchCtx* ctx = new LaunchCtx();
  ctx->libnodePath = getStringProp(env, args[0], "libnode", "");
  ctx->scriptPath  = getStringProp(env, args[0], "script", "");
  ctx->appDir      = getStringProp(env, args[0], "appDir", "");
  ctx->dataDir     = getStringProp(env, args[0], "dataDir", "");

  // ★ 注意：这里【不能】先要求 libnode 非空 —— ArkTS 侧按约定传空串表示
  //   "让 native 用 dladdr 在自身同目录里推断"。之前这里多了一道同样的校验，
  //   导致下面那段兜底永远执行不到，startBackend 每次都直接返回 bad-params ✗
  if (ctx->libnodePath.empty()) {
    const std::string dir = selfDirFromDladdr();
    if (!dir.empty()) {
      ctx->libnodePath = dir + "/libnode.so";
      bootLog("[api] libnode 未指定，按 dladdr 推断为 %s", ctx->libnodePath.c_str());
    }
  }
  // 参数校验（含上面的兜底）
  if (ctx->libnodePath.empty() || ctx->scriptPath.empty()) {
    bootLog("[api] startBackend 参数不足：libnode=%s script=%s",
            ctx->libnodePath.c_str(), ctx->scriptPath.c_str());
    g_state.store(4);
    g_starting.store(false);   // ★ 必须复位，否则后续重试一律 already-started
    delete ctx;
    return makeStr(env, "bad-params");
  }
  bootLogOpen(ctx->dataDir);
  bootLog("[api] startBackend appDir=%s dataDir=%s", ctx->appDir.c_str(), ctx->dataDir.c_str());

  // argv: node 启动参数 + 脚本 + 透传参数
  ctx->argvStore.push_back("node");
  ctx->argvStore.push_back("--expose-internals");   // ★ 让 require("internal/...") 可用（免原生 require-builtin）
  // ★ 2026-10-03 深夜实验：去掉 --jitless —— 因为 --jitless 会连带把 WebAssembly 一起关掉，
  //   而 Node 内置 undici(fetch) 的 llhttp 是 WASM ⇒ DSH 启动即 "WebAssembly is not defined" ✗。
  //   当初加 --jitless 是因为 electerm 文档说 V8 的 PROT_EXEC 会被 W^X 拒绝（那是别的机型/版本）。
  //   本机实测：若去掉后不出现 SIGTRAP，说明这台设备不需要它。
  // ctx->argvStore.push_back("--jitless");
  ctx->argvStore.push_back("--no-verify-heap");     // ★ 受限运行时下的防御

  // ★ 先放脚本：Node 把第一个非选项参数当脚本，必须排在透传参数【之前】
  ctx->argvStore.push_back(ctx->scriptPath);

  // 可选：从入参 args 追加（这些是【给脚本】的参数，排在脚本之后）
  napi_value argvProp;
  if (napi_get_named_property(env, args[0], "args", &argvProp) == napi_ok) {
    bool isArr = false;
    napi_is_array(env, argvProp, &isArr);
    if (isArr) {
      uint32_t n = 0;
      napi_get_array_length(env, argvProp, &n);
      for (uint32_t i = 0; i < n && static_cast<int>(ctx->argvStore.size()) < kMaxArgv - 2; ++i) {
        napi_value e;
        if (napi_get_element(env, argvProp, i, &e) == napi_ok) {
          size_t len = 0;
          if (napi_get_value_string_utf8(env, e, nullptr, 0, &len) == napi_ok) {
            std::string s(len, '\0');
            size_t w = 0;
            if (napi_get_value_string_utf8(env, e, &s[0], len + 1, &w) == napi_ok) { s.resize(w); ctx->argvStore.push_back(s); }
          }
        }
      }
    }
  }
  for (auto& s : ctx->argvStore) ctx->argv.push_back(const_cast<char*>(s.c_str()));
  ctx->argv.push_back(nullptr);

  g_state.store(1);
  std::thread t(bootstrapThread, ctx);
  t.detach();      // ★ detached：不阻塞 ArkTS 侧

  return makeStr(env, "starting");
}

// getBackendStatus() -> { state, exitCode, logPath }
napi_value GetBackendStatus(napi_env env, napi_callback_info info) {
  napi_value obj;
  napi_create_object(env, &obj);
  const char* names[] = {"not-started", "starting", "running", "exited", "failed"};
  int s = g_state.load();
  if (s < 0 || s > 4) s = 4;
  napi_set_named_property(env, obj, "state", makeStr(env, names[s]));
  napi_value ec;
  napi_create_int32(env, g_exitCode.load(), &ec);
  napi_set_named_property(env, obj, "exitCode", ec);
  napi_set_named_property(env, obj, "logPath", makeStr(env, g_logPath));
  return obj;
}

// killNode() —— 目前只记录；优雅退出需 node 侧配合（见文档"待办"）
napi_value KillNode(napi_env env, napi_callback_info info) {
  bootLog("[api] killNode requested (尚未实现优雅退出，仅记录)");
  return makeStr(env, "not-implemented");
}

// getNodeApiVersion() —— 便于 ArkTS 侧做能力探测
napi_value GetNodeApiVersion(napi_env env, napi_callback_info info) {
  napi_value v;
  napi_create_int32(env, NAPI_VERSION, &v);
  return v;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
    {"startBackend",      nullptr, StartBackend,      nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getBackendStatus",  nullptr, GetBackendStatus,  nullptr, nullptr, nullptr, napi_default, nullptr},
    {"killNode",          nullptr, KillNode,          nullptr, nullptr, nullptr, napi_default, nullptr},
    {"getNodeApiVersion", nullptr, GetNodeApiVersion, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  LOGI("node_ctl module initialized (NAPI_VERSION=%d)", NAPI_VERSION);
  return exports;
}

}  // namespace

static napi_module g_nodeCtlModule = {
  .nm_version = 1,
  .nm_flags = 0,
  .nm_filename = nullptr,
  .nm_register_func = Init,
  .nm_modname = "node_ctl",
  .nm_priv = nullptr,
  .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterNodeCtlModule(void) {
  napi_module_register(&g_nodeCtlModule);
}
