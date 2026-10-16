/**
 * @local/dsh-tool-phone-fs —— 给端上 agent 补上【纯 JS 的文件系统操作】能力。
 *
 * 为什么需要它：鸿蒙 seccomp 禁止 app spawn 任何外部程序（连 /bin/sh 都是 EACCES），
 * 所以 DSH 自带的 bash/终端类工具在手机上没有"手"；而内置的 read/write/glob/grep
 * 覆盖不了 删除/移动/复制/建目录 —— 实测 agent 曾明确报告
 * "no delete tool available, so I could not remove it"。
 *
 * 安全红线（本项目铁律：绝不删改用户手机里的任何数据）：
 *   所有路径都强制解析到【会话工作区】之内，越界立即抛错，绝不触碰工作区之外的任何文件。
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const zipZlib = zlib;

/** ---------- CRC32（zip 需要） ---------- */
const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
		t[n] = c >>> 0;
	}
	return t;
})();
/** 计算一段字节的 CRC32。 */
function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
/** ---------- 最小 ZIP 写入器（stored / deflate 都支持） ---------- */
/**
 * 把若干 {name, data} 打包成 zip。
 * @param entries - 条目数组（名字用正斜杠）。
 * @returns zip 的 Buffer。
 */
function zipWrite(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const e of entries) {
		const nameBuf = Buffer.from(e.name, "utf8");
		const crc = crc32(e.data);
		const comp = zipZlib.deflateRawSync(e.data);
		const useDeflate = comp.length < e.data.length;
		const payload = useDeflate ? comp : e.data;
		const method = useDeflate ? 8 : 0;
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);
		lh.writeUInt16LE(0x0800, 6);
		lh.writeUInt16LE(method, 8);
		lh.writeUInt16LE(0, 10);
		lh.writeUInt16LE(0, 12);
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(payload.length, 18);
		lh.writeUInt32LE(e.data.length, 22);
		lh.writeUInt16LE(nameBuf.length, 26);
		lh.writeUInt16LE(0, 28);
		locals.push(lh, nameBuf, payload);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4);
		ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(0x0800, 8);
		ch.writeUInt16LE(method, 10);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(payload.length, 20);
		ch.writeUInt32LE(e.data.length, 24);
		ch.writeUInt16LE(nameBuf.length, 28);
		ch.writeUInt32LE(offset, 42);
		centrals.push(ch, nameBuf);
		offset += lh.length + nameBuf.length + payload.length;
	}
	const localBuf = Buffer.concat(locals);
	const centralBuf = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(localBuf.length, 16);
	return Buffer.concat([localBuf, centralBuf, eocd]);
}
/** 递归统计目录体积，返回 {bytes, files, dirs}。 */
async function duWalk(dir, acc) {
	const items = await fsp.readdir(dir, { withFileTypes: true });
	for (const it of items) {
		const p = path.join(dir, it.name);
		if (it.isDirectory()) {
			acc.dirs++;
			await duWalk(p, acc);
		} else {
			try {
				const st = await fsp.lstat(p);
				acc.files++;
				acc.bytes += st.size;
			} catch { }
		}
	}
	return acc;
}

/** ---------- 纯 JS 的 ZIP 读取（node:zlib，无需 shell） ---------- */
/** 从尾部找 EOCD（0x06054b50），返回中央目录信息。 */
function zipFindEocd(buf) {
	const min = Math.max(0, buf.length - 66000);
	for (let i = buf.length - 22; i >= min; i--) {
		if (buf.readUInt32LE(i) === 0x06054b50) {
			return {
				count: buf.readUInt16LE(i + 10),
				cdOffset: buf.readUInt32LE(i + 16)
			};
		}
	}
	return void 0;
}
/** 列出 zip 内所有条目。 */
function zipList(buf) {
	const eocd = zipFindEocd(buf);
	if (eocd === void 0) throw new Error("不是有效的 zip（找不到 EOCD）");
	const out = [];
	let off = eocd.cdOffset;
	for (let i = 0; i < eocd.count; i++) {
		if (buf.readUInt32LE(off) !== 0x02014b50) break;
		const method = buf.readUInt16LE(off + 10);
		const compSize = buf.readUInt32LE(off + 20);
		const rawSize = buf.readUInt32LE(off + 24);
		const nameLen = buf.readUInt16LE(off + 28);
		const extraLen = buf.readUInt16LE(off + 30);
		const commentLen = buf.readUInt16LE(off + 32);
		const localOff = buf.readUInt32LE(off + 42);
		const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
		out.push({ name, method, compSize, rawSize, localOff });
		off += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}
/** 把 zip 里的条目名归一化成安全的相对路径（同时防 zip-slip）。 */
function zipSafeName(raw) {
	return String(raw)
		.replace(/\\/g, "/")
		.split("/")
		.filter((s) => s !== "" && s !== "." && s !== "..")
		.join("/");
}
/** 取某个条目的内容（stored 或 deflate）。 */
function zipReadEntry(buf, entry) {
	const zlib = zipZlib;
	if (buf.readUInt32LE(entry.localOff) !== 0x04034b50) throw new Error("本地文件头无效: " + entry.name);
	const nameLen = buf.readUInt16LE(entry.localOff + 26);
	const extraLen = buf.readUInt16LE(entry.localOff + 28);
	const dataStart = entry.localOff + 30 + nameLen + extraLen;
	const data = buf.subarray(dataStart, dataStart + entry.compSize);
	if (entry.method === 0) return Buffer.from(data);
	if (entry.method === 8) return zlib.inflateRawSync(data);
	throw new Error("不支持的压缩方式 " + entry.method + "（仅支持 stored/deflate）: " + entry.name);
}

/** Stable Loader identity. */
const name = "tool-phone-fs";
/** 工具与配置。 */
const Config = z.object({ maxEntries: z.number().default(2000) });
/** 只用 tools 服务。 */
const inject = ["tools"];

const OPS = ["ls", "stat", "mkdir", "rm", "mv", "cp", "touch", "head", "tail", "wc", "unzip", "du", "zip"];

/**
 * 把模型给的路径解析并**钉死在工作区内**。
 * @param cwd - 会话工作区（绝对路径）。
 * @param p - 模型给的路径（相对或绝对）。
 * @returns 工作区内的绝对路径。
 */
function safeResolve(cwd, p) {
	const root = path.resolve(cwd);
	const abs = path.resolve(root, p === void 0 || p === "" ? "." : p);
	if (abs !== root && !abs.startsWith(root + path.sep)) {
		throw new Error(
			`phone_fs 拒绝越界：${JSON.stringify(p)} 不在会话工作区内（只允许操作 ${root} 内的文件）`
		);
	}
	return abs;
}

/** 人类可读的大小。 */
function human(n) {
	if (n < 1024) return n + " B";
	if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
	return (n / 1048576).toFixed(1) + " MB";
}

/**
 * Register the phone_fs tool.
 * @param ctx - agent-scoped services.
 * @param config - validated configuration.
 */
function apply(ctx, config) {
	const maxEntries = config.maxEntries;
	ctx.tools.register(defineTool({
		name: "phone_fs",
		description:
			"在工作区内做文件系统操作（纯 JS 实现，不需要 shell —— 手机上没有 shell 可用）。" +
			"op=ls 列目录 / stat 看详情 / mkdir 建目录 / rm 删除（目录需 recursive=true）/ " +
			"mv 移动或改名 / cp 复制 / touch 新建空文件 / " +
			"head 看前 N 行 / tail 看后 N 行 / wc 统计行数词数字节数 / " +
			"unzip 读 zip（list=true 只列目录；给 entry=名字 解出单个文件；给 to=目录 全部解出）/ " +
			"du 统计目录体积 / zip 把文件或目录打包成 zip —— 都不需要 shell。" +
			"所有路径都被强制限制在【会话工作区】内，越界会直接报错。",
		// ★ DSH 的 parameters 不是标准 JSON Schema —— 它就是【属性表本身】
		//   （我照抄 dsh-tool-present 时多包了一层 type/additionalProperties，
		//    导致 defineTool 抛 "parameters.type must be a value schema object"，进而把 DSH 带崩）
		parameters: {
				op: {
					type: "string",
					required: true,
					enum: OPS,
					description: "操作类型。"
				},
				path: {
					type: "string",
					required: true,
					description: "源路径：相对工作区或绝对路径，但必须落在工作区内。"
				},

				recursive: {
					type: "boolean",
					description: "rm 删除目录时必须为 true。"
				},
				lines: {
					type: "integer",
					description: "head / tail 读多少行，默认 40。"
				},
				list: {
					type: "boolean",
					description: "unzip 时只列出条目（不落盘），默认 true。"
				},
				entry: {
					type: "string",
					description: "unzip 时要解出的单个条目名（配合 to 指定输出路径）。"
				},
				to: {
					type: "string",
					description: "目标路径：mv/cp/unzip 用；zip 时是【输出 zip 的路径】。"
				}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					op: { type: "string", required: true },
					ok: { type: "boolean", required: true },
					message: { type: "string", required: true }
				}
			},
			render: (_args, value) => [{ type: "text", text: value.message }]
		},
		async execute(args, exec) {
			const cwd = exec.agent?.session?.header?.cwd ?? process.cwd();
			const abs = safeResolve(cwd, args.path);
			const rel = path.relative(path.resolve(cwd), abs) || ".";
			exec.signal?.throwIfAborted?.();
			switch (args.op) {
				case "ls": {
					const entries = await fsp.readdir(abs, { withFileTypes: true });
					const shown = entries.slice(0, maxEntries);
					const lines = [];
					for (const e of shown) {
						let size = "";
						try {
							const st = await fsp.lstat(path.join(abs, e.name));
							size = e.isDirectory() ? "  <dir>" : "  " + human(st.size);
						} catch { }
						lines.push((e.isDirectory() ? "d " : "- ") + e.name + size);
					}
					const more = entries.length > shown.length ? `\n…（共 ${entries.length} 项，只显示前 ${shown.length}）` : "";
					return { op: args.op, ok: true, message: `${rel}/ 下 ${entries.length} 项：\n${lines.join("\n")}${more}` };
				}
				case "stat": {
					const st = await fsp.lstat(abs);
					return {
						op: args.op, ok: true,
						message: `${rel}\n  type=${st.isDirectory() ? "dir" : st.isFile() ? "file" : "other"}` +
							`\n  size=${st.size} (${human(st.size)})` +
							`\n  mtime=${st.mtime.toISOString()}` +
							`\n  mode=${(st.mode & 0o777).toString(8)}`
					};
				}
				case "mkdir": {
					await fsp.mkdir(abs, { recursive: true });
					return { op: args.op, ok: true, message: `已创建目录 ${rel}` };
				}
				case "touch": {
					await fsp.mkdir(path.dirname(abs), { recursive: true });
					const fh = await fsp.open(abs, "a");
					await fh.close();
					return { op: args.op, ok: true, message: `已创建空文件 ${rel}` };
				}
				case "du": {
					const st = await fsp.lstat(abs);
					if (st.isFile()) {
						return { op: args.op, ok: true, message: rel + "  " + human(st.size) + "（单文件）" };
					}
					const acc = { bytes: 0, files: 0, dirs: 0 };
					await duWalk(abs, acc);
					const lines = [];
					const items = await fsp.readdir(abs, { withFileTypes: true });
					for (const it of items.slice(0, 40)) {
						const sub = { bytes: 0, files: 0, dirs: 0 };
						const sp = path.join(abs, it.name);
						if (it.isDirectory()) { await duWalk(sp, sub); lines.push("  " + String(human(sub.bytes)).padStart(10) + "  " + it.name + "/  (" + sub.files + " 文件)"); }
						else { const s = await fsp.lstat(sp); lines.push("  " + String(human(s.size)).padStart(10) + "  " + it.name); }
					}
					const more = items.length > 40 ? "\n  …（共 " + items.length + " 项）" : "";
					return {
						op: args.op, ok: true,
						message: rel + "/ 合计 " + human(acc.bytes) + "（" + acc.files + " 个文件，" + acc.dirs + " 个子目录）:\n" + lines.join("\n") + more
					};
				}
				case "zip": {
					if (args.to === void 0) throw new Error("phone_fs: zip 需要提供 to=输出 zip 的路径");
					const out = safeResolve(cwd, args.to);
					const entries = [];
					const addFile = async (fp, nameInZip) => {
						const data = await fsp.readFile(fp);
						entries.push({ name: nameInZip.replace(/\\/g, "/"), data });
					};
					const st = await fsp.lstat(abs);
					if (st.isFile()) {
						await addFile(abs, path.basename(abs));
					} else {
						const walk = async (d, prefix) => {
							for (const it of await fsp.readdir(d, { withFileTypes: true })) {
								const sp = path.join(d, it.name);
								if (it.isDirectory()) await walk(sp, prefix + it.name + "/");
								else await addFile(sp, prefix + it.name);
							}
						};
						await walk(abs, "");
					}
					if (entries.length === 0) throw new Error("phone_fs: 没有可打包的文件");
					const buf = zipWrite(entries);
					await fsp.mkdir(path.dirname(out), { recursive: true });
					await fsp.writeFile(out, buf);
					const raw = entries.reduce((s, e) => s + e.data.length, 0);
					return {
						op: args.op, ok: true,
						message: "已打包 " + entries.length + " 个文件（原始 " + human(raw) + " → zip " + human(buf.length) + "）→ " + path.relative(path.resolve(cwd), out)
					};
				}
				case "unzip": {
					const buf = await fsp.readFile(abs);
					const entries = zipList(buf);
					// 只有"没给 entry 也没给 to，且没显式 list=false"时才只列目录
					const wantList = args.list === true ||
						(args.list === void 0 && args.entry === void 0 && args.to === void 0);
					if (wantList) {
						const shown = entries.slice(0, maxEntries);
						const lines = shown.map((e) => "  " + (e.method === 0 ? "stored " : "deflate") + "  " + String(e.rawSize).padStart(12) + "  " + e.name);
						const more = entries.length > shown.length ? "\n  …（共 " + entries.length + " 个条目，只显示前 " + shown.length + "）" : "";
						const total = entries.reduce((s, e) => s + e.rawSize, 0);
						return {
							op: args.op, ok: true,
							message: rel + " 内 " + entries.length + " 个条目，解压后合计 " + human(total) + ":\n" + lines.join("\n") + more
						};
					}
					if (args.entry !== void 0) {
						const e = entries.find((x) => x.name === args.entry) ??
							entries.find((x) => zipSafeName(x.name) === args.entry) ??
							entries.find((x) => path.basename(zipSafeName(x.name)) === args.entry);
						if (e === void 0) throw new Error("phone_fs: zip 里没有条目 " + JSON.stringify(args.entry));
						const target = args.to === void 0 ? path.join(abs + ".out", path.basename(zipSafeName(e.name))) : safeResolve(cwd, args.to);
						await fsp.mkdir(path.dirname(target), { recursive: true });
						await fsp.writeFile(target, zipReadEntry(buf, e));
						return { op: args.op, ok: true, message: "已解出 " + e.name + "（" + human(e.rawSize) + "）→ " + path.relative(path.resolve(cwd), target) };
					}
					if (args.to === void 0) throw new Error("phone_fs: unzip 全部解出需要提供 to=目录");
					const outDir = safeResolve(cwd, args.to);
					let n = 0, bytes = 0;
					for (const e of entries) {
						if (e.name.endsWith("/")) continue;
						const safe = zipSafeName(e.name);
						if (safe === "") continue;
						const target = path.join(outDir, safe);
						// ★ 先归一化再校验：反斜杠条目名曾经能绕过这条检查（zip-slip）
						if (!path.resolve(target).startsWith(path.resolve(cwd) + path.sep)) {
							throw new Error("phone_fs: zip 内条目越界 " + e.name);
						}
						await fsp.mkdir(path.dirname(target), { recursive: true });
						await fsp.writeFile(target, zipReadEntry(buf, e));
						n++;
						bytes += e.rawSize;
					}
					return { op: args.op, ok: true, message: "已解出 " + n + " 个文件（合计 " + human(bytes) + "）→ " + path.relative(path.resolve(cwd), outDir) };
				}
				case "head":
				case "tail": {
					const n = args.lines === void 0 ? 40 : args.lines;
					if (!Number.isSafeInteger(n) || n < 1 || n > maxEntries) {
						throw new Error("phone_fs: lines 必须是 1.." + maxEntries + " 的整数");
					}
					const text = await fsp.readFile(abs, "utf8");
					const all = text.split("\n");
					const picked = args.op === "head" ? all.slice(0, n) : all.slice(Math.max(0, all.length - n));
					return {
						op: args.op, ok: true,
						message: rel + "（共 " + all.length + " 行，" + args.op + " " + picked.length + " 行）:\n" + picked.join("\n")
					};
				}
				case "wc": {
					const text = await fsp.readFile(abs, "utf8");
					const bytes = Buffer.byteLength(text, "utf8");
					// ★ 与 Unix wc -l 一致：数【换行符】个数，而不是 split 后的元素数
					//   （末行带换行时 split 会多出一个空元素 ⇒ 曾经多报 1 行，被端上 agent 发现）
					const lines = (text.match(/\n/g) ?? []).length;
					const words = text.split(/\s+/).filter((w) => w.length > 0).length;
					return { op: args.op, ok: true, message: rel + "\n  行数=" + lines + "  词数=" + words + "  字节=" + bytes + " (" + human(bytes) + ")" };
				}
				case "rm": {
					const st = await fsp.lstat(abs);
					if (st.isDirectory() && args.recursive !== true) {
						throw new Error(`phone_fs: ${rel} 是目录，删除需要 recursive=true`);
					}
					await fsp.rm(abs, { recursive: args.recursive === true, force: false });
					return { op: args.op, ok: true, message: `已删除 ${st.isDirectory() ? "目录" : "文件"} ${rel}` };
				}
				case "mv": {
					if (args.to === void 0) throw new Error("phone_fs: mv 需要提供 to");
					const dst = safeResolve(cwd, args.to);
					await fsp.mkdir(path.dirname(dst), { recursive: true });
					await fsp.rename(abs, dst);
					return { op: args.op, ok: true, message: `已移动 ${rel} → ${path.relative(path.resolve(cwd), dst)}` };
				}
				case "cp": {
					if (args.to === void 0) throw new Error("phone_fs: cp 需要提供 to");
					const dst = safeResolve(cwd, args.to);
					await fsp.mkdir(path.dirname(dst), { recursive: true });
					await fsp.cp(abs, dst, { recursive: true });
					return { op: args.op, ok: true, message: `已复制 ${rel} → ${path.relative(path.resolve(cwd), dst)}` };
				}
				default:
					throw new Error(`phone_fs: 不支持的 op ${JSON.stringify(args.op)}`);
			}
		}
	}));
}

export { Config, apply, inject, name };