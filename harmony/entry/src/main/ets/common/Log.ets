// Harness 手机端日志库
//
// 为什么要有它：手机端出问题时，"看不到现场"是最贵的成本。
// 本库同时做三件事：
//   ① 写 hilog        → 电脑上 `hdc shell hilog` 即可读到（无需权限、不受沙箱限制）
//   ② 落盘到 App 私有目录 → 重启不丢，能看出"每次冷启动都复现"这类模式
//   ③ 内存环形缓冲     → App 内可查看/一键复制，随手就能发给别人
//
// 用法：
//   Log.init(ctx)                  // Ability 里调一次
//   Log.i('Web', 'pageEnd ' + url)  // 记录
//   Log.all()                       // 取全部文本（用于复制/展示）
//
// 约定：tag 用短词，便于 grep：App / Web / Net / WD / UI / Set
import { hilog } from '@kit.PerformanceAnalysisKit';
import util from '@ohos.util';
import fs from '@ohos.file.fs';
import common from '@ohos.app.ability.common';

const DOMAIN: number = 0x2A11;
const HILOG_TAG: string = 'HarnessMobile';
const FILE_NAME: string = 'harness.log';
const MEM_MAX: number = 800;          // 内存中保留条数
const FILE_MAX: number = 256 * 1024;  // 落盘上限，超过则保留后半
const FILE_KEEP: number = 128 * 1024;

export enum Lv { D = 0, I = 1, W = 2, E = 3 }

export class Log {
  private static ctx: common.UIAbilityContext | null = null;
  private static path: string = '';
  private static mem: Array<string> = [];
  private static writes: number = 0;
  private static ready: boolean = false;

  /** 在 ability 的 onCreate / onWindowStageCreate 里调用一次 */
  static init(ctx: common.UIAbilityContext): void {
    try {
      Log.ctx = ctx;
      Log.path = ctx.filesDir + '/' + FILE_NAME;
      Log.ready = true;
      // 把上次的日志尾部读回内存，形成"跨重启连续"的日志
      try {
        if (fs.accessSync(Log.path)) {
          const st = fs.statSync(Log.path);
          const from = st.size > FILE_KEEP ? st.size - FILE_KEEP : 0;
          const f = fs.openSync(Log.path, fs.OpenMode.READ_ONLY);
          const buf = new ArrayBuffer(st.size - from);
          fs.readSync(f.fd, buf, { offset: from, length: st.size - from });
          fs.closeSync(f);
          const dec = util.TextDecoder.create('utf-8');
          const txt = dec.decodeToString(new Uint8Array(buf));
          const lines = txt.split('\n').filter((l: string) => l.length > 0);
          Log.mem = lines.slice(-MEM_MAX);
        }
      } catch (e) {
        // 读旧日志失败不影响新日志
      }
      Log.w('App', '===== APP START (日志库就绪) =====');
    } catch (e) {
      Log.ready = false;
    }
  }

  private static stamp(): string {
    const d = new Date();
    const p2 = (n: number): string => (n < 10 ? '0' : '') + n;
    const p3 = (n: number): string => (n < 100 ? (n < 10 ? '00' : '0') : '') + n;
    return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + '.' + p3(d.getMilliseconds());
  }

  private static line(lv: Lv, tag: string, msg: string): string {
    const name = lv === Lv.E ? 'E' : (lv === Lv.W ? 'W' : (lv === Lv.I ? 'I' : 'D'));
    return Log.stamp() + ' [' + name + '] ' + tag + ' | ' + msg;
  }

  private static write(lv: Lv, tag: string, msg: string): void {
    const s = Log.line(lv, tag, msg);
    // ① 内存
    Log.mem.push(s);
    if (Log.mem.length > MEM_MAX) {
      Log.mem.shift();
    }
    // ② hilog（电脑上: hdc shell hilog | grep HarnessMobile）
    try {
      if (lv === Lv.E) {
        hilog.error(DOMAIN, HILOG_TAG, '%{public}s', s);
      } else if (lv === Lv.W) {
        hilog.warn(DOMAIN, HILOG_TAG, '%{public}s', s);
      } else {
        hilog.info(DOMAIN, HILOG_TAG, '%{public}s', s);
      }
    } catch (e) {
      // 忽略
    }
    // ③ 落盘
    if (Log.ready) {
      try {
        const f = fs.openSync(Log.path, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.APPEND);
        fs.writeSync(f.fd, s + '\n');
        fs.closeSync(f);
        Log.writes++;
        if (Log.writes % 100 === 0) {
          Log.rotate();
        }
      } catch (e) {
        // 忽略
      }
    }
  }

  /** 超过上限就保留后半，避免无限增长 */
  private static rotate(): void {
    try {
      if (!fs.accessSync(Log.path)) {
        return;
      }
      const st = fs.statSync(Log.path);
      if (st.size <= FILE_MAX) {
        return;
      }
      const from = st.size - FILE_KEEP;
      const fr = fs.openSync(Log.path, fs.OpenMode.READ_ONLY);
      const buf = new ArrayBuffer(st.size - from);
      fs.readSync(fr.fd, buf, { offset: from, length: st.size - from });
      fs.closeSync(fr);
      const fw = fs.openSync(Log.path, fs.OpenMode.READ_WRITE | fs.OpenMode.TRUNC);
      fs.writeSync(fw.fd, '[日志已轮转，以上为较早内容]\n');
      fs.writeSync(fw.fd, buf);
      fs.closeSync(fw);
    } catch (e) {
      // 忽略
    }
  }

  /** 网页 console 专用：按级别分流，并把来源文件/行号带上 */
  static write_console(level: string, msg: string, src: string, line: number): void {
    const where: string = src.length > 0 ? (' @' + src + ':' + line) : '';
    const m: string = msg.length > 300 ? msg.substring(0, 300) + '…' : msg;
    if (level === 'error' || level === 'Error') {
      Log.write(Lv.E, 'JS', m + where);
    } else if (level === 'warn' || level === 'Warn') {
      Log.write(Lv.W, 'JS', m + where);
    } else {
      Log.write(Lv.D, 'JS', m + where);
    }
  }

  static d(tag: string, msg: string): void { Log.write(Lv.D, tag, msg); }
  static i(tag: string, msg: string): void { Log.write(Lv.I, tag, msg); }
  static w(tag: string, msg: string): void { Log.write(Lv.W, tag, msg); }
  static e(tag: string, msg: string): void { Log.write(Lv.E, tag, msg); }

  /** 全部日志文本（最新在最后） */
  static all(): string {
    return Log.mem.join('\n');
  }

  /** 最近 n 条 */
  static tail(n: number): string {
    return Log.mem.slice(Math.max(0, Log.mem.length - n)).join('\n');
  }

  static count(): number {
    return Log.mem.length;
  }

  static filePath(): string {
    return Log.path;
  }

  /** 清空内存与文件（用于"从现在开始记"） */
  static clear(): void {
    Log.mem = [];
    try {
      if (Log.ready && fs.accessSync(Log.path)) {
        fs.unlinkSync(Log.path);
      }
    } catch (e) {
      // 忽略
    }
    Log.w('App', '日志已清空');
  }
}
