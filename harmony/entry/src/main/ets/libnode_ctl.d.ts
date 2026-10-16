// ★ 环境声明（ambient module）—— 关键实验：
//   之前用 `file:` 依赖 + types 包提供类型，结果 ets-loader 把 `import ... from 'libnode_ctl.so'`
//   编译成了【包内相对模块】(@app:.../entry/node_ctl)，运行时解析成 undefined ✗。
//   改成环境声明后，依赖侧没有任何可解析的包，希望 ets-loader 走它内建的 .so 分支
//   （生成 requireNapi('node_ctl')）—— 这一点用 ark_disasm 反汇编即可当场验证。
declare module 'libnode_ctl.so' {
  export interface StartBackendOptions {
    /** libnode.so 的绝对路径；传空串则由 native 用 dladdr 在自身同目录里找 */
    libnode: string;
    /** 入口脚本的绝对路径 */
    script: string;
    /** 只读应用包目录（resfile 根） */
    appDir: string;
    /** 可写数据目录 */
    dataDir: string;
    /** 追加给 node 的参数 */
    args?: string[];
  }

  export type BackendState = 'not-started' | 'starting' | 'running' | 'exited' | 'failed';

  export interface BackendStatus {
    state: BackendState;
    exitCode: number;
    logPath: string;
  }

  export interface NodeCtlApi {
    startBackend(options: StartBackendOptions): string;
    getBackendStatus(): BackendStatus;
    killNode(): string;
    getNodeApiVersion(): number;
  }

  const nodeCtl: NodeCtlApi;
  export default nodeCtl;
}