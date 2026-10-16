// Index.ets —— DSH on HarmonyOS 的界面与进程守护（M2 就绪版）
//
// 设计要点：
//   ① 启动参数由 resfile/launch.json 驱动（没有它则退化为跑 bootstrap/hello.js）
//   ② 端口从【node 自己的启动输出】里解析（DSH web 的端口事先未知）
//      —— 这依赖 native 侧的 stdout 重定向（node-stdout.log），见 cpp/node_ctl.cpp
//   ③ 后端崩溃/退出 → 自动重启（最多 3 次，间隔递增），并把过程记入面板
//   ④ 所有 native 调用都包在 try 里：native 缺符号/加载失败不应让界面崩掉
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { promptAction } from '@kit.ArkUI';
import http from '@ohos.net.http';
import fs from '@ohos.file.fs';
import util from '@ohos.util';
import zlib from '@ohos.zlib';
import picker from '@ohos.file.picker';
import fileUri from '@ohos.file.fileuri';
import fileEnv from '@ohos.file.environment';
import abilityAccessCtrl from '@ohos.abilityAccessCtrl';
import backgroundTaskManager from '@ohos.resourceschedule.backgroundTaskManager';
import wantAgent from '@ohos.app.ability.wantAgent';
import type { Permissions } from '@ohos.abilityAccessCtrl';
import nodeCtl from 'libnode_ctl.so';
// ★ 只保留默认导入：这是 OHOS 原生模块的官方写法（编译成 requireNapi('node_ctl')）。
//   具名导入会触发 "does not provide an export name" 的静态错误，已移除。
import { StartBackendOptions, BackendStatus } from 'libnode_ctl.so';

const DATA_SUBDIR: string = 'dsh-harmony-data';
const MAX_RESTART: number = 0;   // ★ 一个进程只能 node::Start 一次（node.cc:827 有一次性断言）；不自动重启

// ★ M2：DSH 本体。载荷以【单个 zip】放在 rawfile/，首次运行解包到 filesDir 下再交给 node。
const PAYLOAD_ZIP: string = 'dsh-payload.zip';
const DSH_ROOT_NAME: string = 'dsh-v2';   // ★ 换版本号即可强制重新解包（避免复用不完整的旧解包）
// ★ 注意：tar.gz 里的条目带 dsh/ 前缀（从上层目录打包），解到 dsh-v1/ 后实际路径是 dsh-v1/dsh/...
const DSH_ENTRY_REL: string = 'dsh/node_modules/@deepseek-ai/dsh/lib/bin.js';
const DSH_ARGS: string[] = ['web', '--no-open'];
const PAYLOAD_TGZ: string = 'dsh-payload.tar.gz';
const PAYLOAD_TGZ_BYTES: number = 0;   // 0 = 不做精确比对（避免写死数字；只看 MB 与是否 >0）

// ★★★ 对照实验开关（2026-10-03 深夜）
//   false = 只跑 M1 自检页（入口 = rawfile/bootstrap/hello.js → ArkTS 写到 filesDir）
//           这是 22:51 那次【已跑通】的配置，用它来验证"成功是否可复现"
//   true  = 跑 M2（入口 = 解包出来的 DSH bin.js）
const USE_DSH_PAYLOAD: boolean = true;
const FALLBACK_SCRIPT_REL: string = 'bootstrap/hello.js';
const FALLBACK_PORTS: number[] = [5577, 19387, 3000, 8000, 8080, 3001, 9000];

interface LaunchConfig {
  scriptRelative: string;
  args: string[];
  dataSubdir: string;
}

@Entry
@Component
struct Index {
  private controller: webview.WebviewController = new webview.WebviewController();
  private timer: number = -1;
  private ticks: number = 0;
  private restarts: number = 0;
  private restartPending: boolean = false;

  @State stage: string = '初始化';
  @State detail: string = '';
  @State ready: boolean = false;
  @State logText: string = '';
  @State showLog: boolean = false;
  @State port: number = 0;
  @State webUrl: string = '';   // ★ V1 实测：DSH web 的 URL 带 ?token=，不带 token 会 401
  // ★ 调试通道：把日志 POST 回电脑（靠 hdc rport 反向转发）。截图读日志太不可靠（会截断）
  private fwdPending: string = '';
  private fwdStdoutOff: number = 0;
  private fwdBootOff: number = 0;
  private fwdTimer: number = -1;
  @State importing: boolean = false;
  @State backend: string = '-';

  aboutToAppear(): void {
    this.start();
  }

  aboutToDisappear(): void {
    this.stopTimer();
  }

  // ---------------- 基础工具 ----------------
  private ctx(): common.UIAbilityContext {
    return getContext(this) as common.UIAbilityContext;
  }

  private resfile(rel: string): string {
    return this.ctx().bundleCodeDir + '/resources/resfile/' + rel;
  }

  private dataDir(sub: string): string {
    return this.ctx().filesDir + '/' + (sub.length > 0 ? sub : DATA_SUBDIR);
  }

  private log(s: string): void {
    const d = new Date();
    const p2 = (n: number): string => (n < 10 ? '0' : '') + n;
    const p3 = (n: number): string => (n < 100 ? (n < 10 ? '00' : '0') : '') + n;
    const ts = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + p3(d.getMilliseconds());
    const line = ts + '  ' + s;
    this.logText = this.logText.length > 0 ? (line + '\n' + this.logText) : line;
    this.fwdPending += line + '\n';
    if (this.fwdTimer < 0) {
      this.fwdTimer = setInterval(() => { this.flushLogs(); }, 2000);
    }
  }

  /** 把累积的日志 POST 回电脑（失败静默；这只是调试辅助） */
  private flushLogs(): void {
    if (this.fwdPending.length === 0) { return; }
    const body: string = this.fwdPending;
    this.fwdPending = '';
    const req = http.createHttp();
    req.request('http://127.0.0.1:19999/log', {
      method: http.RequestMethod.POST,
      header: { 'content-type': 'text/plain; charset=utf-8' },
      extraData: body,
      connectTimeout: 1500,
      readTimeout: 1500
    }).then(() => { req.destroy(); }).catch(() => { req.destroy(); });
  }

  /** 把端上两个日志文件的【增量】转发回电脑 —— 这样我能看到 Node 的完整输出，不用截图 */
  private forwardLogFiles(ddir: string): void {
    const jobs: string[][] = [
      [ddir + '/node-stdout.log', 'node-stdout'],
      [ddir + '/node-boot.log', 'node-boot']
    ];
    for (let i = 0; i < jobs.length; i++) {
      const path: string = jobs[i][0];
      const tag: string = jobs[i][1];
      const prevOff: number = tag === 'node-stdout' ? this.fwdStdoutOff : this.fwdBootOff;
      try {
        if (!fs.accessSync(path)) { continue; }
        const st = fs.statSync(path);
        // 文件被截断/重置时，从头再读
        let from: number = prevOff;
        if (st.size < prevOff) { from = 0; }
        if (st.size <= from) { continue; }
        const len: number = st.size - from;
        const f = fs.openSync(path, fs.OpenMode.READ_ONLY);
        const buf = new ArrayBuffer(len);
        fs.readSync(f.fd, buf, { offset: from, length: len });
        fs.closeSync(f);
        if (tag === 'node-stdout') { this.fwdStdoutOff = st.size; } else { this.fwdBootOff = st.size; }
        const dec = util.TextDecoder.create('utf-8');
        const txt: string = dec.decodeToString(new Uint8Array(buf));
        const req = http.createHttp();
        req.request('http://127.0.0.1:19999/' + tag, {
          method: http.RequestMethod.POST,
          header: { 'content-type': 'text/plain; charset=utf-8' },
          extraData: txt,
          connectTimeout: 1500,
          readTimeout: 1500
        }).then(() => { req.destroy(); }).catch(() => { req.destroy(); });
      } catch (e) { }
    }
  }

  /** 读文件尾部若干字节（不存在就返回空串） */
  private tailFile(p: string, maxBytes: number): string {
    try {
      if (!fs.accessSync(p)) {
        return '';
      }
      const st = fs.statSync(p);
      const from: number = st.size > maxBytes ? st.size - maxBytes : 0;
      const len: number = st.size - from;
      if (len <= 0) {
        return '';
      }
      const f = fs.openSync(p, fs.OpenMode.READ_ONLY);
      const buf = new ArrayBuffer(len);
      fs.readSync(f.fd, buf, { offset: from, length: len });
      fs.closeSync(f);
      const dec = util.TextDecoder.create('utf-8');
      return dec.decodeToString(new Uint8Array(buf));
    } catch (e) {
      return '';
    }
  }

  /**
   * 从任意文本里找最后一个 DSH web 的完整 URL。
   * ★ V1 实测：DSH 启动时会打印 `dsh web: http://127.0.0.1:3080/?token=xxxx`，
   *   且**不带 token 的请求返回 401** ⇒ 必须把【整条 URL】交给 Web 组件，而不是自己拼 host:port。
   */
  private parseUrl(text: string): string {
    const key: string = 'http://127.0.0.1:';
    const i: number = text.lastIndexOf(key);
    if (i < 0) {
      return '';
    }
    let j: number = i;
    while (j < text.length) {
      const c: string = text.charAt(j);
      if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '"' || c === "'" || c === ')') {
        break;
      }
      j++;
    }
    return text.substring(i, j);
  }

  /** 从任意文本里找最后一个 "127.0.0.1:<port>"（不用正则，稳） */
  private parsePort(text: string): number {
    const key: string = '127.0.0.1:';
    let idx: number = text.lastIndexOf(key);
    if (idx < 0) {
      return 0;
    }
    let i: number = idx + key.length;
    let num: number = 0;
    let digits: number = 0;
    while (i < text.length && digits < 5) {
      const c: string = text.charAt(i);
      if (c < '0' || c > '9') {
        break;
      }
      num = num * 10 + (c.charCodeAt(0) - 48);
      digits++;
      i++;
    }
    return digits >= 2 ? num : 0;
  }

  // ---------------- 启动 ----------------
  private loadConfig(): LaunchConfig {
    const cfg: LaunchConfig = { scriptRelative: FALLBACK_SCRIPT_REL, args: [], dataSubdir: DATA_SUBDIR };
    const raw: string = this.tailFile(this.resfile('launch.json'), 65536);
    if (raw.length === 0) {
      this.log('未找到 resfile/launch.json，使用 M1 回退入口 ' + FALLBACK_SCRIPT_REL);
      return cfg;
    }
    try {
      const o: Record<string, Object> = JSON.parse(raw) as Record<string, Object>;
      const sr: Object | undefined = o.scriptRelative;
      if (typeof sr === 'string' && sr.length > 0) {
        cfg.scriptRelative = sr;
      }
      const a: Object | undefined = o.args;
      if (Array.isArray(a)) {
        const arr: string[] = [];
        for (let i = 0; i < a.length; i++) {
          const v: Object = a[i];
          if (typeof v === 'string') {
            arr.push(v);
          }
        }
        cfg.args = arr;
      }
      const ds: Object | undefined = o.dataSubdir;
      if (typeof ds === 'string' && ds.length > 0) {
        cfg.dataSubdir = ds;
      }
      this.log('launch.json: script=' + cfg.scriptRelative + '  args=[' + cfg.args.join(' ') + ']');
    } catch (e) {
      const err = e as BusinessError;
      this.log('launch.json 解析失败（' + err.message + '），用回退入口');
    }
    return cfg;
  }

  /**
   * 确保 DSH 载荷已在 filesDir 下解包好。
   * 链路（上机实测出来的正解）：rawfile(打包在内) → resourceManager 读字节
   *   → 写成 filesDir 里的真实 zip 文件 → zlib 解包到 filesDir/dsh
   */
  private async ensurePayload(ddir: string): Promise<string> {
    const root: string = ddir + '/' + DSH_ROOT_NAME;
    const entry: string = root + '/' + DSH_ENTRY_REL;
    try { fs.mkdirSync(root, true); } catch (e) { }
    // ★ 判据必须严：光"路径存在"不够（上一轮就是被这个宽松判据坑了 ——
    //   accessSync 对 0 字节文件/目录都返回 true，于是复用了坏的解包，Node 一直报 MODULE_NOT_FOUND）
    let payloadOk: boolean = false;
    if (fs.accessSync(entry)) {
      try {
        const st = fs.statSync(entry);
        payloadOk = st.isFile() && st.size > 1000;
        this.log('  已有载荷: 大小=' + st.size + ' 字节  是文件=' + st.isFile() + '  ⇒ ' + (payloadOk ? '可用' : '不可用，将重新解包'));
      } catch (e) {
        this.log('  已有载荷 statSync 失败，将重新解包');
      }
    }
    if (payloadOk) {
      this.log('✓ DSH 载荷已就绪: ' + entry);
      try {
        const libDir = root + '/node_modules/@deepseek-ai/dsh/lib';
        const items: string[] = fs.listFileSync(libDir);
        this.log('  dsh/lib 下文件数=' + items.length + '  前几个: ' + items.slice(0, 6).join(', '));
      } catch (e) {
        const err = e as BusinessError;
        this.log('  ✗ 列 dsh/lib 失败: ' + err.message);
      }
      try {
        const nm: string[] = fs.listFileSync(root + '/node_modules');
        this.log('  node_modules 顶层条目数=' + nm.length + '  前几个: ' + nm.slice(0, 6).join(', '));
      } catch (e) {
        const err2 = e as BusinessError;
        this.log('  ✗ 列 node_modules 失败: ' + err2.message);
      }
      return entry;
    }
    this.stage = '首次运行：解包 DSH 载荷';
    this.log('解包 DSH 载荷（11419 个文件，请稍候）…');
    const zipDst: string = ddir + '/dsh-payload.zip';
    try {
      const rm = this.ctx().resourceManager;
      const bytes: Uint8Array = rm.getRawFileContentSync(PAYLOAD_ZIP);
      this.log('从 rawfile 读到载荷 zip: ' + bytes.byteLength + ' 字节');
      const f = fs.openSync(zipDst, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      fs.writeSync(f.fd, bytes.buffer);
      fs.closeSync(f);
      this.log('已写出 ' + zipDst + ' (' + fs.statSync(zipDst).size + ' 字节)');
    } catch (e) {
      const err = e as BusinessError;
      this.log('✗ 写载荷 zip 失败: ' + err.message);
      return '';
    }
    const t0: number = Date.now();
    try {
      // ★ zip 里的条目是 dsh/...（从上层目录打包，无 ./ 前缀），所以解到 ddir 而不是 root
      await zlib.decompressFile(zipDst, ddir);
      this.log('✓ 解包完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
    } catch (e) {
      const err = e as BusinessError;
      this.log('✗ 解包失败: ' + err.message);
      return '';
    }
    // ★ 决定性诊断：把各个候选位置都列出来（解包产物到底落在哪）
    const probe = (label: string, dir: string): void => {
      try {
        const items: string[] = fs.listFileSync(dir);
        this.log('  [' + label + '] ' + dir + '  → ' + items.length + ' 项: ' + items.slice(0, 8).join(', '));
      } catch (e) {
        const err = e as BusinessError;
        this.log('  [' + label + '] ' + dir + '  → 列目录失败: ' + err.message);
      }
    };
    probe('ddir', ddir);
    probe('ddir/dsh', ddir + '/dsh');
    probe('root(dsh-v1)', root);
    probe('root/node_modules', root + '/node_modules');
    // 逐个候选找 bin.js
    const cands: string[] = [
      ddir + '/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      ddir + '/node_modules/@deepseek-ai/dsh/lib/bin.js',
      root + '/node_modules/@deepseek-ai/dsh/lib/bin.js'
    ];
    for (let i = 0; i < cands.length; i++) {
      const c: string = cands[i];
      if (fs.accessSync(c)) {
        try {
          const st = fs.statSync(c);
          this.log('  ★ 找到候选入口[' + i + ']: ' + c + '  大小=' + st.size + ' 是文件=' + st.isFile());
          if (st.isFile() && st.size > 1000) { this.log('✓ 采用候选入口[' + i + ']'); return c; }
        } catch (e) { }
      }
    }
    this.log('✗ 三个候选位置都没有可用的入口');
    return '';
  }

  /** 把 rawfile 里的一个文件写到 filesDir（M1 已证明：ArkTS 写的文件 Node 必能读） */
  private writeRaw(rel: string, dst: string): number {
    const rm = this.ctx().resourceManager;
    const bytes: Uint8Array = rm.getRawFileContentSync(rel);
    const f = fs.openSync(dst, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
    fs.writeSync(f.fd, bytes.buffer);
    fs.closeSync(f);
    return fs.statSync(dst).size;
  }

  private start(): void {
    this.stopTimer();
    this.ticks = 0;
    this.ready = false;
    this.port = 0;
    this.stage = '启动端上 Node';

    const ddir: string = this.dataDir(DATA_SUBDIR);
    // ★ 把本项目自带的插件补丁写进 DSH_HOME —— DSH 会自动读取 <DSH_HOME>/cordis.patch.yml。
    //   为什么不走 CLI 的 --patch：那是【全局】选项，放在 web 子命令之后会被吞掉 ⇒ DSH 起不来；
    //   写在这个位置零风险、不需要改 argv。
    this.writePatchYml(ddir);
    try { fs.mkdirSync(ddir, true); } catch (e) { }
    // 先申请权限，再探测（否则一定 EPERM）。
    // 注意：这里是同步方法，不能 await ⇒ 用 then 串联。
    this.startKeepAlive();
    this.requestStoragePerms().then((): void => { this.probeUserDirs(); })
      .catch((): void => { this.probeUserDirs(); });
    // ★ 沙箱内可读可写的工作区（DSH 的文件选择器会从 HOME=<filesDir> 开始）
    const wsDir: string = ddir.substring(0, ddir.lastIndexOf('/')) + '/workspace';
    try { fs.mkdirSync(wsDir, true); this.log('✓ 工作区目录: ' + wsDir + '（沙箱内，可读写）'); } catch (e) { }

    let script: string = '';
    let nodeArgs: string[] = [];

    if (USE_DSH_PAYLOAD) {
      // ★★ M2：入口 = bootstrap.mjs —— 由【Node 自己】解包载荷，然后启动 DSH。
      //    为什么不让 ArkTS 解包：实测「鸿蒙 zlib 解出来的文件 Node 的 musl 裸 open 读不到」，
      //    而「ArkTS fs.writeSync 写的文件 Node 能读」⇒ 让最终使用者也当写入者。
      const bsDst: string = ddir + '/bootstrap.mjs';
      const tgzDst: string = ddir + '/' + PAYLOAD_TGZ;
      try {
        const n: number = this.writeRaw('bootstrap.mjs', bsDst);
        this.log('✓ bootstrap.mjs 已写出: ' + (n / 1024).toFixed(1) + ' KB');
      } catch (e) {
        const er = e as BusinessError;
        this.log('✗ 写 bootstrap.mjs 失败: ' + er.message);
      }
      try {
        const n2: number = this.writeRaw(PAYLOAD_TGZ, tgzDst);
        const mb: string = (n2 / 1048576).toFixed(2);
        const exact: string = PAYLOAD_TGZ_BYTES > 0
          ? (n2 === PAYLOAD_TGZ_BYTES ? '  ✓ 与预期一致' : '  ✗ 与预期 ' + (PAYLOAD_TGZ_BYTES / 1048576).toFixed(2) + ' MB 不符')
          : '';
        this.log('✓ 载荷已写出: ' + mb + ' MB' + exact);
      } catch (e2) {
        const er2 = e2 as BusinessError;
        this.log('✗ 写载荷 tar.gz 失败: ' + er2.message);
      }
      // ★ 内置凭据（可选）：构建时把本机的 DSH 凭据放进 rawfile/（并在 .gitignore 里排除），
      //   这里复制进 DSH_HOME，让装出来的 App 开箱即用。
      //   为什么这么做：hdc 以 shell 身份跑，写不进 App 私有目录（实测 permission denied ✗），
      //   而密钥绝不允许进 git（见工程铁律一.3）⇒ 只在构建产物里存在 ✓
      try {
        const credDst: string = ddir + '/.credentials.yaml';
        const nc: number = this.writeRaw('credentials.yaml', credDst);
        this.log('✓ 凭据已内置写入: ' + nc + ' B → ' + credDst);
      } catch (e4) {
        this.log('（未内置凭据，跳过 —— 需要时在设置里手填 API Key）');
      }
      script = bsDst;
      nodeArgs = [tgzDst, ddir + '/dsh-v1', DSH_ENTRY_REL].concat(DSH_ARGS);
      this.log('启动命令: node bootstrap.mjs ' + nodeArgs.join(' '));
    } else {
      // M1 自检页（保底路径）
      const hello: string = ddir + '/hello.js';
      try {
        const n3: number = this.writeRaw('bootstrap/hello.js', hello);
        this.log('✓ hello.js 已写出: ' + n3 + ' 字节');
      } catch (e3) {
        const er3 = e3 as BusinessError;
        this.log('✗ 写 hello.js 失败: ' + er3.message);
      }
      script = hello;
      nodeArgs = [];
      this.log('启动命令(M1 自检页): node hello.js');
    }

    this.startNode(script, nodeArgs, ddir);
  }

  /** 真正把 node 拉起来 */
  private startNode(script: string, nodeArgs: string[], ddir: string): void {
    const cfg: LaunchConfig = this.loadConfig();
    this.log('script(给 node) = ' + script);
    this.log('args(给 node) = [' + nodeArgs.join(', ') + ']');
    this.log('dataDir = ' + ddir);
    for (let i = 0; i < FALLBACK_PORTS.length; i++) {
      this.log('备用端口候选: ' + FALLBACK_PORTS[i]);
    }
    this.reallyStart(script, nodeArgs, ddir, cfg);
  }

  private reallyStart(script: string, nodeArgs: string[], ddir: string, cfg: LaunchConfig): void {
    const srcScript: string = script;
    // ★★ 系统架构层面的正确做法（上机实测两次纠正后的结论）：
    //    ① resfile 里的文件在这个安装形态下【连 ArkTS 的 fs 都访问不到】
    //       实测：fs.copyFileSync 报 "No such file or directory" ✗
    //    ② OHOS 的标准随包资源目录是 rawfile/，用 resourceManager 读成字节流 ✓
    //    ⇒ 链路：rawfile(打包在内) → resourceManager 读字节 → 写入 filesDir(真实可写) → 交给 Node
    try {
      fs.mkdirSync(ddir, true);
    } catch (e) { }
    try {
      // ★ 模块形状探针：下一张截图就能看清 native 模块到底给了我们什么
      const dOk: boolean = nodeCtl !== undefined && nodeCtl !== null;
      this.log('★ native 模块探测: typeof=' + (typeof nodeCtl)
        + '  startBackend=' + (dOk ? (typeof nodeCtl.startBackend) : 'n/a')
        + '  getBackendStatus=' + (dOk ? (typeof nodeCtl.getBackendStatus) : 'n/a')
        + '  getNodeApiVersion=' + (dOk ? (typeof nodeCtl.getNodeApiVersion) : 'n/a'));
      if (!dOk || typeof nodeCtl.startBackend !== 'function') {
        this.stage = '原生模块没挂上';
        this.detail = 'libnode_ctl.so 的导出不可用（请看日志里的 typeof 结果）';
        this.log('✗ nodeCtl.startBackend 不是函数 —— 原生模块解析失败');
        return;
      }
      const r: string = nodeCtl.startBackend({
        libnode: '',
        script: script,
        appDir: this.resfile(''),
        dataDir: ddir,
        args: nodeArgs
      });
      this.log('startBackend -> ' + r);
      this.stage = '等待 Node 就绪';
      this.detail = '第 ' + (this.restarts + 1) + ' 次启动';
    } catch (e) {
      const err = e as BusinessError;
      this.stage = '启动失败';
      this.detail = err.message;
      this.log('startBackend 抛异常: ' + err.message);
      promptAction.showToast({ message: '启动失败：' + err.message });
      return;
    }

    this.timer = setInterval(() => {
      this.tick(cfg, ddir);
    }, 1000);
  }

  /** 沙箱内的工作区目录（filesDir 下，可读写） */
  private workspaceDir(): string {
    const ddir: string = this.dataDir(DATA_SUBDIR);
    return ddir.substring(0, ddir.lastIndexOf('/')) + '/workspace';
  }

  /**
   * ★ 接入鸿蒙【系统文件选择器】—— 让 DSH 能用手机里的真实文件。
   *   为什么必须"复制进来"：应用运行在沙箱里，系统【不允许】直接读 /storage/...（实测 EPERM）✗；
   *   而系统选择器跑在沙箱外，用户选中的内容会被授权给本应用 ⇒ 我们把它复制进沙箱工作区，
   *   DSH（Node 侧）就能正常读写了 ✓（这也是沙箱应用的标准做法）。
   */
  private async importFolder(): Promise<void> {
    if (this.importing) { return; }
    this.importing = true;
    try {
      this.log('打开系统文件选择器（选一个文件夹）…');
      const p = new picker.DocumentViewPicker();
      const opts: picker.DocumentSelectOptions = {
        // ★ 用 FOLDER：实测 MIXED 模式下点目录是"进入"而非"选中"（0/20 空操作 ✗）；
        //   FOLDER 模式下点目录会直接高亮选中并显示「已选中 X」✓
        selectMode: picker.DocumentSelectMode.FOLDER,
        maxSelectNumber: 1
      };
      const uris: string[] = await p.select(opts);
      if (!uris || uris.length === 0) {
        this.log('已取消（没有选择文件夹）');
        return;
      }
      const uri: string = uris[0];
      this.log('已选择: ' + uri);
      const destDir: string = this.workspaceDir() + '/imported';
      try { fs.mkdirSync(destDir, true); } catch (e) { }
      let ok: number = 0;
      let dirs: number = 0;
      let failed: number = 0;
      for (let k = 0; k < uris.length; k++) {
        const u: string = uris[k];
        let name: string = u.substring(u.lastIndexOf('/') + 1);
        if (name.length === 0 || name.indexOf(':') >= 0) { name = 'imported-' + Date.now() + '-' + k; }
        const d: string = destDir + '/' + name;
        try {
          // ★ SDK 事实：open() 支持 URI；stat()/copyFileSync() 支持 fd
          const f = fs.openSync(u, fs.OpenMode.READ_ONLY);
          try {
            const st = fs.statSync(f.fd);
            if (st.isDirectory()) {
              dirs++;
              this.log('  ⏭ 目录暂不支持（listFile 不吃 URI）: ' + name);
              continue;
            }
            fs.copyFileSync(f.fd, d);      // ★ 源是 fd ⇒ 支持 URI 场景 ✓
            ok++;
            this.log('  ✓ 已导入: ' + name + '  (' + st.size + ' 字节)');
          } finally {
            fs.closeSync(f);
          }
        } catch (e) {
          failed++;
          const err3 = e as BusinessError;
          this.log('  ✗ 导入失败 ' + name + ': ' + err3.message);
        }
      }
      this.log('✓ 导入结束: 成功 ' + ok + ' 个文件，跳过目录 ' + dirs + ' 个，失败 ' + failed + ' 个');
      this.log('  目标目录: ' + destDir + '（在 DSH 里把 workspace 作为工作区即可看到）');
    } catch (e) {
      const err = e as BusinessError;
      this.log('✗ 导入失败: ' + err.message);
    } finally {
      this.importing = false;
    }
  }

  /**
   * 递归复制。源是系统选择器给的 URI。
   * ★ 依据 SDK 声明（@ohos.file.fs.d.ts）：
   *   · listFile(path) 文档只写 "Application sandbox path" ⇒ **不接受 URI** ✗
   *   · open(path)     明确写 "supports the use of a URI" ✓（文件或目录都可）
   *   · copy(srcUri,dst) 明确写 "URI of the file or directory" ✓
   * ⇒ 先用系统级 copy 直拷（一步到位）；不行再 open(uri) 拿 fd、用 listFile(fd) 列目录递归。
   */
  private async copyTree(src: string, dst: string, depth: number): Promise<number> {
    if (depth > 24) { return 0; }
    // ① 系统级复制（对 URI 最友好）
    if (depth === 0) {
      // ★ SDK 事实：fs.copy(srcUri, destUri) 两端【都必须是 URI】。
      //   之前只把源做成 URI、目标给沙箱路径 ⇒ 报 "The input parameter is invalid"。
      //   这里用 @ohos.file.fileuri 把沙箱路径转成 URI 再试。
      try {
        const dstUri: string = new fileUri.FileUri(dst).toString();
        this.log('  尝试 fs.copy(URI→URI): ' + src + '  ⇒  ' + dstUri);
        await fs.copy(src, dstUri);
        const n0: number = this.countFiles(dst, 0);
        this.log('  ✓ 目录已递归复制（URI→URI）: ' + n0 + ' 个文件');
        return n0;
      } catch (e) {
        const err0 = e as BusinessError;
        this.log('  URI→URI copy 失败(' + err0.message + ' code=' + err0.code + ')');
      }
    }
    // ★ 更正：SDK 里 listFileSync/listFile 只接受 string（不接受 fd）✗
    //   而 copy(srcUri, destUri) 明确支持 URI（含目录）✓ —— 所以 URI 场景只走系统级 copy。
    let items: string[] = [];
    try {
      items = fs.listFileSync(src);   // 纯路径场景可用；URI 会抛错，由下面兜住
    } catch (e) {
      const err = e as BusinessError;
      this.log('  无法按路径列出（URI 场景正常）: ' + err.message);
      this.log('  ⇒ URI 目录无法用 listFile 递归；系统级 copy 是 SDK 指定的 URI 路径 ✓');
      return 0;
    }
    let n: number = 0;
    for (let i = 0; i < items.length; i++) {
      const name: string = items[i];
      const s: string = src + '/' + name;
      const d: string = dst + '/' + name;
      try {
        const st = fs.statSync(s);
        if (st.isDirectory()) {
          try { fs.mkdirSync(d, true); } catch (e) { }
          n += await this.copyTree(s, d, depth + 1);
        } else {
          fs.copyFileSync(s, d);
          n++;
          if (n % 50 === 0) { this.log('  已复制 ' + n + ' 个文件…'); }
        }
      } catch (e) {
        const err2 = e as BusinessError;
        if (n < 5) { this.log('  跳过 ' + name + ': ' + err2.message); }
      }
    }
    return n;
  }

  /** 数一个目录下有多少文件（用于 copy 成功后报告数量） */
  private countFiles(dir: string, depth: number): number {
    if (depth > 24) { return 0; }
    let n: number = 0;
    try {
      const items: string[] = fs.listFileSync(dir);
      for (let i = 0; i < items.length; i++) {
        try {
          const st = fs.statSync(dir + '/' + items[i]);
          if (st.isDirectory()) { n += this.countFiles(dir + '/' + items[i], depth + 1); } else { n++; }
        } catch (e) { }
      }
    } catch (e) { }
    return n;
  }

  /** ★ 试取鸿蒙「预授权用户目录」的沙箱路径（需 READ_WRITE_*_DIRECTORY 权限） */
  private probeUserDirs(): void {
    try { this.log('用户目录 Download: ' + fileEnv.getUserDownloadDir()); }
    catch (e) { const er = e as BusinessError; this.log('✗ getUserDownloadDir 失败: ' + er.message + ' (code=' + er.code + ')'); }
    try { this.log('用户目录 Documents: ' + fileEnv.getUserDocumentDir()); }
    catch (e) { const er2 = e as BusinessError; this.log('✗ getUserDocumentDir 失败: ' + er2.message + ' (code=' + er2.code + ')'); }
    try { this.log('用户目录 Desktop: ' + fileEnv.getUserDesktopDir()); }
    catch (e) { const er3 = e as BusinessError; this.log('✗ getUserDesktopDir 失败: ' + er3.message + ' (code=' + er3.code + ')'); }
    // ★ 真实路径探针：装了 READ_WRITE_DOCUMENTS/DOWNLOAD_DIRECTORY 之后，
    //   沙箱外的 /storage/Users/currentUser/... 是不是终于可读了？（决定"目录递归导入"能否简化）
    const rawDirs: string[] = [
      '/storage/Users/currentUser/Documents',
      '/storage/Users/currentUser/Download',
      '/storage/Users/currentUser',
      '/storage/Users/currentUser/Desktop'
    ];
    for (let i = 0; i < rawDirs.length; i++) {
      const d: string = rawDirs[i];
      try {
        const items = fs.listFileSync(d);
        this.log('真实路径可读 ✓ ' + d + ' → ' + items.length + ' 项: ' + items.slice(0, 5).join(', '));
      } catch (e) {
        const er = e as BusinessError;
        this.log('真实路径不可读 ✗ ' + d + ' → ' + er.message + ' (code=' + er.code + ')');
      }
    }  }

  /**
   * ★ 运行时申请"用户目录读写"权限。
   *   教训：光在 module.json5 里声明、能装上，并不等于已授权 ——
   *   实测此时读 /storage/Users/currentUser/Documents 仍是 EPERM(13900001)，
   *   getUserXxxDir() 也报"设备不支持此 API"(801)。必须走 user_grant 弹窗申请。
   */
  private async requestStoragePerms(): Promise<void> {
    try {
      const at = abilityAccessCtrl.createAtManager();
      const perms: Permissions[] = [
        'ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY',
        'ohos.permission.READ_WRITE_DOWNLOAD_DIRECTORY'
      ];
      const ctx = getContext(this) as common.UIAbilityContext;
      const res = await at.requestPermissionsFromUser(ctx, perms);
      this.log('★ 权限申请返回: authResults=' + JSON.stringify(res.authResults) + ' permissions=' + JSON.stringify(res.permissions));
    } catch (e) {
      const er = e as BusinessError;
      this.log('★ 权限申请异常: ' + er.message + ' (code=' + er.code + ')');
    }
  }

  /**
   * ★ 长时任务（continuous task）：让端上 Node 在熄屏/切后台后【不被冻结】。
   *   实测基线：切后台 90 秒后进程还在、端口还在监听，但 HTTP 请求返回 000
   *   —— 典型的"进程活着但线程被冻结"。日志通道时断时续也是这个原因。
   *   依据 SDK：需 ohos.permission.KEEP_BACKGROUND_RUNNING + module.json5 的 backgroundModes。
   *   注意：DATA_TRANSFER 型要求每 10 分钟更新一次进度，否则任务会被系统取消。
   */
  /**
   * ★ 真常驻：优先用【长时任务】(BackgroundMode.TASK_KEEPING=9，计算型，
   *   与 DATA_TRANSFER 不同、不要求每 10 分钟更新进度)；
   *   失败则退回 requestSuspendDelay(180s，到期自动续) 兜底。
   *   背景：鸿蒙会在几分钟后【冻结】后台应用 —— 实测无保活时切后台 90 秒
   *   进程还在、端口还在监听，但 HTTP 返回 000；仅靠延迟挂起可撑到 3~4 分钟。
   *   注：新版 API 已移除 module.backgroundModes 的字符串数组写法(会 schema 校验失败)。
   */
  private async startKeepAlive(): Promise<void> {
    // ① 长时任务（真常驻）
    try {
      const ctx = getContext(this) as common.UIAbilityContext;
      const info: wantAgent.WantAgentInfo = {
        wants: [{ bundleName: 'com.dsh.harmony', abilityName: 'EntryAbility' }],
        actionType: wantAgent.OperationType.START_ABILITY,
        requestCode: 0
      };
      const agent = await wantAgent.getWantAgent(info);
      await backgroundTaskManager.startBackgroundRunning(ctx, backgroundTaskManager.BackgroundMode.TASK_KEEPING, agent);
      this.log('★★ 长时任务已启动（TASK_KEEPING）—— 期望真常驻，不受后台冻结影响');
    } catch (e) {
      const er = e as BusinessError;
      this.log('★ TASK_KEEPING 长时任务失败: ' + er.message + ' (code=' + er.code + ')');
    }
    // ② 延迟挂起兜底（到期自动续）
    try {
      const d: backgroundTaskManager.DelaySuspendInfo = backgroundTaskManager.requestSuspendDelay(
        'DSH 端上服务运行中',
        (): void => {
          this.log('★ 延迟挂起到期 ⇒ 自动续申请');
          this.startKeepAlive().catch((): void => { });
        }
      );
      this.log('★ 延迟挂起兜底: ' + d.actualDelayTime + ' ms');
    } catch (e) {
      const er2 = e as BusinessError;
      this.log('★ 延迟挂起失败: ' + er2.message);
    }
  }

  /** 把手机文件系统工具的补丁写入 DSH_HOME（DSH 启动时自动读取）。 */
  private writePatchYml(ddir: string): void {
    // ★ 必须用【绝对路径】：DSH 的加载器对绝对路径/相对路径会走 pathToFileURL
    //   （见 dsh-app-boot 第 3540/3694 行），而裸包名会去 profile 的 pnpm 依赖里找 ⇒ 找不到 ✗
    const pluginJs: string = ddir + '/dsh-v1/dsh/node_modules/@local/dsh-tool-phone-fs/lib/index.js';
    const text: string = "- insert:\n" +
      "    - id: tool-phone-fs\n" +
      "      name: '" + pluginJs + "'\n";
    const target: string = ddir + '/cordis.patch.yml';
    try {
      const f = fs.openSync(target, fs.OpenMode.CREATE | fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(f.fd, text);
      } finally {
        fs.closeSync(f);
      }
      this.log('✓ 已写入插件补丁: ' + target);
    } catch (e) {
      const er = e as BusinessError;
      this.log('✗ 写插件补丁失败: ' + er.message);
    }
  }

  private stopTimer(): void {
    if (this.timer >= 0) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }

  // ---------------- 每秒巡检 ----------------
  private tick(cfg: LaunchConfig, ddir: string): void {
    this.ticks++;
    this.forwardLogFiles(ddir);   // ★ 把端上 Node 的输出实时转发回电脑

    // 1) native 状态
    let state: string = '';
    try {
      const st: BackendStatus = nodeCtl.getBackendStatus();
      state = st.state;
      this.backend = state + '(exit=' + st.exitCode + ')';
      this.detail = 'native state=' + state + '  exitCode=' + st.exitCode;
      if (state === 'failed' || state === 'exited') {
        this.handleBackendDown(state, st.exitCode);
        return;
      }
    } catch (e) {
      const err = e as BusinessError;
      this.backend = '调用异常';
      this.detail = 'getBackendStatus 异常: ' + err.message;
    }

    // 2) 从 node 的输出里解析端口（比猜端口可靠）
    const outText: string = this.tailFile(ddir + '/node-stdout.log', 32768);
    const bootText: string = this.tailFile(ddir + '/node-boot.log', 32768);
    const u1: string = this.parseUrl(outText);
    const u2: string = this.parseUrl(bootText);
    const fullUrl: string = u1.length > 0 ? u1 : u2;
    if (fullUrl.length > 0 && fullUrl !== this.webUrl) {
      this.webUrl = fullUrl;
      this.port = this.parsePort(fullUrl);
      this.log('★ 从 node 输出解析到完整 URL: ' + fullUrl);
    } else if (this.webUrl.length === 0) {
      const p1: number = this.parsePort(outText);
      const p2: number = this.parsePort(bootText);
      if (p1 > 0) { this.port = p1; } else if (p2 > 0) { this.port = p2; }
    }

    // 3) 探测（解析到的端口 / 备用候选）
    const candidates: number[] = [];
    if (this.port > 0) {
      candidates.push(this.port);
    }
    for (let i = 0; i < FALLBACK_PORTS.length; i++) {
      if (candidates.indexOf(FALLBACK_PORTS[i]) < 0) {
        candidates.push(FALLBACK_PORTS[i]);
      }
    }
    const limit: number = this.port > 0 ? 1 : Math.min(candidates.length, 3);
    let idx: number = 0;
    const tryNext = (): void => {
      if (idx >= limit) {
        this.afterProbeFailure(state, cfg);
        return;
      }
      const p: number = candidates[idx];
      idx++;
      this.probe(p, (ok: boolean) => {
        if (ok) {
          this.port = p;
          this.ready = true;
          this.stage = '已就绪';
          this.restarts = 0;
          this.stopTimer();
          this.log('探测成功: http://127.0.0.1:' + p);
          promptAction.showToast({ message: 'Node 已就绪 ✓ 端口 ' + p + (this.webUrl.length > 0 ? '（已取到带 token 的 URL）' : '') });
        } else {
          tryNext();
        }
      });
    };
    tryNext();

    // 4) 定期把日志刷进面板
    if (this.ticks % 5 === 0) {
      const t: string = this.tailFile(ddir + '/node-boot.log', 8192);
      if (t.length > 0) {
        const lines: string[] = t.split('\n');
        const last: string = lines.length > 0 ? lines[lines.length - 2 >= 0 ? lines.length - 2 : 0] : '';
        if (last.length > 0) {
          this.log('[node-boot] ' + last.substring(0, 200));
        }
      }
    }
  }

  /** 把端上 node 的两个日志文件的尾部刷到面板（排障用：崩溃 backtrace 就在这里） */
  private dumpLogs(reason: string, ddir: string): void {
    this.log('===== ' + reason + ' =====');
    const boot: string = this.tailFile(ddir + '/node-boot.log', 16384);
    if (boot.length > 0) {
      const ls: string[] = boot.split('\n');
      const from: number = ls.length > 40 ? ls.length - 40 : 0;
      for (let i = from; i < ls.length; i++) {
        if (ls[i].length > 0) { this.log('[boot] ' + ls[i].substring(0, 220)); }
      }
    } else { this.log('（node-boot.log 为空或读不到）'); }
    const out: string = this.tailFile(ddir + '/node-stdout.log', 32768);
    if (out.length > 0) {
      const ls2: string[] = out.split('\n');
      const from2: number = ls2.length > 40 ? ls2.length - 40 : 0;
      for (let i = from2; i < ls2.length; i++) {
        if (ls2[i].length > 0) { this.log('[node] ' + ls2[i].substring(0, 220)); }
      }
    } else { this.log('（node-stdout.log 为空）'); }
  }

  private handleBackendDown(state: string, exitCode: number): void {
    if (this.restartPending) {
      return;
    }
    this.dumpLogs('backend ' + state + ' exit=' + exitCode, this.dataDir(DATA_SUBDIR));
    if (this.restarts >= MAX_RESTART) {
      this.stage = 'Node 已退出';
      this.detail = '请看下方日志的最后一段（[node] 行是 Node 自己的输出）';
      this.stopTimer();
      this.log('Node 已退出。注意：同一进程内 node::Start 只能调用一次，');
      this.log('所以无法在本进程内重启 —— 请【杀掉应用再重开】以重新尝试。');
      return;
    }
    this.restartPending = true;
    this.restarts++;
    const delay: number = 2000 * this.restarts;
    this.stage = 'Node 已退出，' + (delay / 1000) + ' 秒后重启（第 ' + this.restarts + ' 次）';
    this.log('backend ' + state + '(exit=' + exitCode + ') → 计划 ' + delay + 'ms 后重启');
    setTimeout(() => {
      this.restartPending = false;
      this.start();
    }, delay);
  }

  private afterProbeFailure(state: string, cfg: LaunchConfig): void {
    if (this.ready) {
      return;
    }
    if (this.ticks >= 60) {
      this.stage = '等待超时（60 秒未监听）';
      this.stopTimer();
      this.log('60 秒内没有探测到 HTTP 服务；state=' + state);
    }
  }

  private probe(p: number, cb: (ok: boolean) => void): void {
    const req = http.createHttp();
    req.request('http://127.0.0.1:' + p + '/', {
      method: http.RequestMethod.GET,
      connectTimeout: 1200,
      readTimeout: 1200
    }).then((res: http.HttpResponse) => {
      req.destroy();
      cb(res.responseCode > 0 && res.responseCode < 500);
    }).catch((e: BusinessError) => {
      req.destroy();
      cb(false);
    });
  }

  // ---------------- UI ----------------
  build() {
    Column() {
      Row() {
        Text(this.stage)
          .fontSize(14)
          .fontColor(this.ready ? '#22c55e' : '#eab308')
          .layoutWeight(1)
        Button(this.importing ? '导入中…' : '导入手机文件夹')
          .fontSize(12)
          .enabled(!this.importing)
          .onClick(() => { this.importFolder(); })
        Button(this.showLog ? '隐藏日志' : '日志')
          .margin({ left: 8 })
          .fontSize(12)
          .onClick(() => {
            this.showLog = !this.showLog;
          })
        Button('重开')
          .fontSize(12)
          .margin({ left: 8 })
          .onClick(() => {
            // ★ 一个进程内 node::Start 只能调用一次（node.cc:827 断言），
            //   所以这里不可能"重启 node" —— 只能提示用户从最近任务里划掉应用再打开。
            promptAction.showToast({ message: 'Node 在本次进程内已启动过；请从最近任务划掉应用后重开' });
            this.log('提示：Node 只能在本进程内启动一次，请划掉应用重开');
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      .backgroundColor('#12161c')

      if (this.detail.length > 0) {
        Text(this.detail + (this.port > 0 ? '   port=' + this.port : '') + '   ' + this.backend)
          .fontSize(11)
          .fontColor('#8b93a1')
          .width('100%')
          .padding({ left: 12, right: 12, bottom: 6 })
          .maxLines(2)
      }

      Stack() {
        if (this.ready) {
          Web({ src: this.webUrl.length > 0 ? this.webUrl : ('http://127.0.0.1:' + this.port + '/'), controller: this.controller })
            .javaScriptAccess(true)
            .domStorageAccess(true)
            .mixedMode(MixedMode.All)
            .onConsole((e) => {
              const m = e.message;
              this.log('[web] ' + m.getMessage());
              return true;
            })
            .onHttpErrorReceive((e) => {
              this.log('[web-http] ' + e.response.getResponseCode() + ' ' + e.request.getRequestUrl());
            })
        } else {
          Column() {
            LoadingProgress().width(36).height(36).color('#4d7cfe')
            Text(this.stage).fontSize(13).fontColor('#8b93a1').margin({ top: 12 })
            Text('（Node 起来后这里会自动显示它的页面）').fontSize(11).fontColor('#5f6875').margin({ top: 6 })
          }
          .width('100%')
          .height('100%')
          .justifyContent(FlexAlign.Center)
        }

        if (this.showLog) {
          Scroll() {
            Text(this.logText.length > 0 ? this.logText : '(暂无日志)')
              .fontSize(10)
              .fontColor('#c9d1dc')
              .width('100%')
              .textAlign(TextAlign.Start)
          }
          .width('100%')
          .height('100%')
          .padding(10)
          .backgroundColor('#0b0d11')
        }
      }
      .layoutWeight(1)
      .width('100%')
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0f1115')
  }
}
