/**
 * dsh-video-clip —— 核心实现（与 DSH 运行时解耦，便于单独测试）。
 *
 * 三块能力：
 *   1. downloadClip  按时间区间下载（yt-dlp --download-sections；DASH 直链无法定位时自动回退 HLS）
 *   2. verifyClip    ffprobe 元数据 + 音量检测 + 关键帧/拼图，供模型核对边界与内容
 *   3. startShare    把文件/目录通过带 Range 的临时 HTTP 服务分享到内网，返回下载链接
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.1.0";

/** 把任意错误转成一行可读文本。 */
export function message(error) {
	return error instanceof Error ? error.message : String(error);
}

function tail(text, lines = 12) {
	const all = String(text ?? "").trimEnd().split(/\r?\n/);
	return all.slice(-lines).join("\n");
}

/** 命令失败时携带 stderr，便于上层判断是否该回退 HLS。 */
export class CmdError extends Error {
	constructor(cmd, args, code, stdout, stderr) {
		super(`${cmd} ${args.join(" ")} 退出码 ${code}\n${tail(stderr)}`);
		this.name = "CmdError";
		this.code = code;
		this.stdout = stdout;
		this.stderr = stderr;
	}
}

/** 运行一个子进程，收集 stdout/stderr；支持协作式取消与超时。 */
export function run(cmd, args, { signal, timeoutMs = 0, cwd, env, failOn } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd,
			env: env ? { ...process.env, ...env } : process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timer;
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener?.("abort", onAbort);
			fn(value);
		};
		const onAbort = () => {
			try {
				child.kill("SIGKILL");
			} catch {}
			finish(reject, new Error(`调用被取消：${cmd} ${args.slice(0, 3).join(" ")}…`));
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {}
				finish(reject, new Error(`命令超时（${Math.round(timeoutMs / 1000)}s）：${cmd}`));
			}, timeoutMs);
			timer.unref?.();
		}
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (failOn instanceof RegExp && failOn.test(String(chunk))) {
				try {
					child.kill("SIGKILL");
				} catch {}
				finish(reject, new CmdError(cmd, args, "ABORTED", stdout, stderr));
			}
		});
		child.on("error", (error) => finish(reject, error));
		child.on("close", (code) => {
			if (code === 0) finish(resolve, { stdout, stderr });
			else finish(reject, new CmdError(cmd, args, code, stdout, stderr));
		});
	});
}

/** 解析 "HH:MM:SS" / "MM:SS" / "1234.5" 为秒；无法解析返回 NaN。 */
export function parseTime(text) {
	if (typeof text === "number") return Number.isFinite(text) ? text : NaN;
	if (typeof text !== "string") return NaN;
	const value = text.trim();
	if (value === "") return NaN;
	if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value);
	const parts = value.split(":");
	if (parts.length < 2 || parts.length > 3) return NaN;
	const nums = parts.map((part) => Number(part));
	if (nums.some((n) => !Number.isFinite(n))) return NaN;
	return nums.reduce((acc, n) => acc * 60 + n, 0);
}

/** 秒 → "HH:MM:SS[.mmm]"。 */
export function formatTime(seconds) {
	const total = Math.max(0, Number(seconds) || 0);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const whole = Math.floor(secs);
	const ms = Math.round((secs - whole) * 1000);
	const base = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}`;
	return ms > 0 ? `${base}.${String(ms).padStart(3, "0")}` : base;
}

/** 文件名里用的紧凑时间戳（HH-MM-SS）。 */
function stamp(seconds) {
	return formatTime(seconds).replace(/\.\d+$/, "").replace(/:/g, "-");
}

/** 候选数据目录：显式配置 → DSH_HOME → 系统临时目录（沙箱里只读时兜底）。 */
function dataDirCandidates() {
	const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
	return [
		process.env.DSH_VIDEO_CLIP_CACHE,
		path.join(home, "cache", "video-clip"),
		path.join(os.tmpdir(), "dsh-video-clip"),
	].filter((item) => typeof item === "string" && item !== "");
}

/** 找到第一个可写的数据目录（不存在则创建）。 */
export async function ensureDataDir() {
	for (const candidate of dataDirCandidates()) {
		try {
			await fsp.mkdir(candidate, { recursive: true });
			await fsp.access(candidate, fs.constants.W_OK);
			return candidate;
		} catch {}
	}
	throw new Error(
		`没有可写的数据目录（尝试过：${dataDirCandidates().join("、")}）。` +
			"请设置 DSH_VIDEO_CLIP_CACHE 指向一个可写目录。",
	);
}

function safeName(text, max = 80) {
	const cleaned = String(text ?? "video")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\s+/g, " ")
		.trim();
	return (cleaned || "video").slice(0, max).replace(/[. ]+$/, "");
}

async function exists(target) {
	try {
		await fsp.access(target);
		return true;
	} catch {
		return false;
	}
}

let cachedYtDlp;
/** 找到可用的 yt-dlp：PATH 二进制 → python 模块 → 本地 --target 安装（必要时自动 pip 安装）。 */
export async function resolveYtDlp(signal) {
	if (cachedYtDlp) return cachedYtDlp;
	const candidates = [
		{ cmd: "yt-dlp", args: [], env: {} },
		{ cmd: "python3", args: ["-m", "yt_dlp"], env: {} },
	];
	const local = path.join(await ensureDataDir(), "ytdlp");
	if (await exists(path.join(local, "yt_dlp"))) {
		candidates.push({ cmd: "python3", args: ["-m", "yt_dlp"], env: { PYTHONPATH: local } });
	}
	for (const candidate of candidates) {
		try {
			await run(candidate.cmd, [...candidate.args, "--version"], {
				signal,
				timeoutMs: 60_000,
				env: candidate.env,
			});
			cachedYtDlp = candidate;
			return candidate;
		} catch {}
	}
	await fsp.mkdir(local, { recursive: true });
	try {
		await run("python3", ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--target", local, "yt-dlp"], {
			signal,
			timeoutMs: 300_000,
		});
	} catch (error) {
		throw new Error(
			`缺少 yt-dlp，自动安装也失败了：${message(error)}\n请手动安装：pip install -U yt-dlp 或 brew install yt-dlp`,
		);
	}
	cachedYtDlp = { cmd: "python3", args: ["-m", "yt_dlp"], env: { PYTHONPATH: local } };
	return cachedYtDlp;
}

let cachedFfmpeg;
/** 确认 ffmpeg / ffprobe 可用。 */
export async function resolveFfmpeg(signal) {
	if (cachedFfmpeg) return cachedFfmpeg;
	const checks = {};
	for (const tool of ["ffmpeg", "ffprobe"]) {
		try {
			await run(tool, ["-version"], { signal, timeoutMs: 30_000 });
			checks[tool] = tool;
		} catch {
			throw new Error(
				`缺少 ${tool}。分段下载与校验都依赖它，请先安装：\n` +
					"  macOS: brew install ffmpeg\n  Debian/Ubuntu: sudo apt install ffmpeg\n  Windows: winget install Gyan.FFmpeg",
			);
		}
	}
	cachedFfmpeg = checks;
	return cachedFfmpeg;
}

function ytdlpEnv(yt) {
	return {
		...(yt.env ?? {}),
		PYTHONIOENCODING: "utf-8",
	};
}

function commonYtDlpArgs() {
	const args = ["--no-warnings", "--no-playlist", "--no-progress", "--newline"];
	const cookies = process.env.DSH_VIDEO_CLIP_COOKIES;
	if (cookies) args.push("--cookies", cookies);
	const browser = process.env.DSH_VIDEO_CLIP_COOKIES_FROM_BROWSER;
	if (browser) args.push("--cookies-from-browser", browser);
	return args;
}

/** 取元数据（不下载）。 */
export async function probeVideo({ url, signal }) {
	const yt = await resolveYtDlp(signal);
	const { stdout } = await run(yt.cmd, [...yt.args, ...commonYtDlpArgs(), "-J", url], {
		signal,
		timeoutMs: 180_000,
		env: ytdlpEnv(yt),
	});
	let info;
	try {
		info = JSON.parse(stdout);
	} catch {
		throw new Error(`解析 yt-dlp 元数据失败：${tail(stdout, 6)}`);
	}
	return {
		id: info.id,
		title: info.title,
		uploader: info.uploader ?? info.channel,
		duration: typeof info.duration === "number" ? info.duration : undefined,
		formats: Array.isArray(info.formats) ? info.formats : [],
		chapters: Array.isArray(info.chapters) ? info.chapters : [],
		webpageUrl: info.webpage_url,
	};
}

function qualityHeight(quality) {
	const text = String(quality ?? "").toLowerCase().trim();
	if (text === "" || text === "best") return 0;
	const match = text.match(/(\d{3,4})/);
	if (match) return Number(match[1]);
	if (text === "4k" || text === "2160p") return 2160;
	if (text === "1440p") return 1440;
	return 1080;
}

function qualityForcesHls(quality) {
	return /hls|m3u8/i.test(String(quality ?? ""));
}

function formatForQuality(quality, audioOnly) {
	if (audioOnly) return "ba/b";
	const height = qualityHeight(quality);
	if (height <= 0) return "bv*+ba/b";
	return `bv*[height<=${height}][ext=mp4][vcodec^=avc1]+ba[ext=m4a]/b[height<=${height}]/bv*[height<=${height}]+ba/b`;
}

/** 从格式表里挑一条 HLS（m3u8）组合，DASH 直链无法 seek 时回退用。 */
export function pickHlsFormat(formats, quality) {
	const height = qualityHeight(quality) || 1080;
	const hls = (formats ?? []).filter((f) => String(f.protocol ?? "").startsWith("m3u8"));
	const videos = hls
		.filter((f) => f.vcodec && f.vcodec !== "none" && (!f.acodec || f.acodec === "none"))
		.sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
	const audios = hls
		.filter((f) => f.acodec && f.acodec !== "none" && (!f.vcodec || f.vcodec === "none"))
		.sort((a, b) => (a.abr ?? 0) - (b.abr ?? 0));
	if (videos.length === 0) return undefined;
	const capped = videos.filter((f) => (f.height ?? 0) <= height);
	const video = (capped.length > 0 ? capped : videos).at(-1);
	const audio = audios.at(-1);
	return audio ? `${video.format_id}+${audio.format_id}` : String(video.format_id);
}

function looksLikeSeekFailure(error) {
	const text = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
	return /could not seek|partial file|Invalid NAL|corrupt input|Error opening input/i.test(text);
}

async function findOutputFile(dir, prefix) {
	const entries = await fsp.readdir(dir).catch(() => []);
	const candidates = [];
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		if (/\.(part|ytdl|temp|tmp)$/i.test(entry)) continue;
		const full = path.join(dir, entry);
		try {
			const stat = await fsp.stat(full);
			if (stat.isFile() && stat.size > 0) candidates.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
		} catch {}
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return candidates[0];
}

async function ffprobeFile(file, signal) {
	const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], {
		signal,
		timeoutMs: 120_000,
	});
	return JSON.parse(stdout);
}

async function audioMeanDb(file, signal) {
	try {
		const { stderr } = await run(
			"ffmpeg",
			["-v", "info", "-i", file, "-t", "60", "-af", "volumedetect", "-f", "null", "-"],
			{ signal, timeoutMs: 120_000 },
		);
		const match = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
		return match ? Number(match[1]) : undefined;
	} catch {
		return undefined;
	}
}

function describeProbe(probe) {
	const video = (probe.streams ?? []).find((s) => s.codec_type === "video");
	const audio = (probe.streams ?? []).find((s) => s.codec_type === "audio");
	return {
		duration: Number(probe.format?.duration ?? 0),
		sizeBytes: Number(probe.format?.size ?? 0),
		video: video
			? {
					codec: video.codec_name,
					width: video.width,
					height: video.height,
					fps: video.r_frame_rate,
				}
			: undefined,
		audio: audio ? { codec: audio.codec_name, channels: audio.channels } : undefined,
	};
}

/**
 * 按区间下载视频片段。
 * @returns 结构化结果（供工具层直接映射到 output schema）。
 */
export async function downloadClip({
	url,
	start,
	end,
	quality = "1080p",
	format,
	outDir,
	audioOnly = false,
	forceKeyframes = false,
	cwd,
	signal,
	log = () => {},
}) {
	if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
		throw new Error("url 必须是 http(s) 链接");
	}
	const startSeconds = parseTime(start);
	const endSeconds = parseTime(end);
	if (!Number.isFinite(startSeconds) || startSeconds < 0) throw new Error(`无法解析开始时间：${start}`);
	if (!Number.isFinite(endSeconds) || endSeconds <= startSeconds) throw new Error(`结束时间必须晚于开始时间：${start} → ${end}`);

	const yt = await resolveYtDlp(signal);
	await resolveFfmpeg(signal);
	log(`读取元数据：${url}`);
	const info = await probeVideo({ url, signal });
	const warnings = [];
	if (typeof info.duration === "number" && endSeconds > info.duration + 1) {
		throw new Error(
			`结束时间 ${formatTime(endSeconds)} 超出视频时长 ${formatTime(info.duration)}（${info.title ?? ""}）`,
		);
	}
	const dir = outDir
		? (path.isAbsolute(outDir) ? outDir : path.join(cwd || process.cwd(), outDir))
		: path.join(cwd || process.cwd(), "download");
	await fsp.mkdir(dir, { recursive: true });
	const prefix = safeName(`${info.title ?? info.id ?? "video"}_${stamp(startSeconds)}-${stamp(endSeconds)}`);
	const outputTemplate = path.join(dir, `${prefix}.%(ext)s`);

	const sections = `*${startSeconds}-${endSeconds}`;
	const hlsFormat = pickHlsFormat(info.formats, quality);
	const height = qualityHeight(quality);
	// 长直播回放里 DASH 直链经常无法按时间定位；有 HLS 就优先走分片（也更稳）。
	const longVideo = typeof info.duration === "number" && info.duration > 1800;
	const preferHls = !format && !audioOnly && hlsFormat !== undefined && (longVideo || qualityForcesHls(quality));

	const runDownload = async (fmt, label, timeoutMs) => {
		const args = [
			...yt.args,
			...commonYtDlpArgs(),
			"-f",
			fmt,
			"--download-sections",
			sections,
			"--merge-output-format",
			"mp4",
			"-o",
			outputTemplate,
			url,
		];
		if (forceKeyframes) args.push("--force-keyframes-at-cuts");
		log(`下载 ${formatTime(startSeconds)} - ${formatTime(endSeconds)}（${label}，格式 ${fmt}）`);
		await run(yt.cmd, args, {
			signal,
			timeoutMs,
			env: ytdlpEnv(yt),
			cwd: dir,
			// 看到这些错误立刻中止，交给上层换路径，而不是等超时。
			failOn: /could not seek|Invalid NAL unit|Error opening input file|could not find codec parameters/i,
		});
	};

	const qualityFormat = format || formatForQuality(quality, audioOnly);
	const attempts = [];
	if (preferHls) {
		attempts.push({ fmt: hlsFormat, label: "HLS", timeoutMs: 20 * 60_000, note: "长视频优先用 HLS 分片下载，DASH 直链在长视频上经常无法定位。" });
		attempts.push({ fmt: qualityFormat, label: "DASH 兜底", timeoutMs: 8 * 60_000 });
	} else {
		attempts.push({ fmt: qualityFormat, label: "DASH", timeoutMs: 8 * 60_000 });
		if (!format && !audioOnly && hlsFormat) {
			attempts.push({ fmt: hlsFormat, label: "HLS 回退", timeoutMs: 20 * 60_000, note: "DASH 直链无法定位，已自动回退到 HLS 分片下载。" });
		}
	}

	let usedFormat;
	let lastError;
	for (const attempt of attempts) {
		try {
			await runDownload(attempt.fmt, attempt.label, attempt.timeoutMs);
			usedFormat = attempt.fmt;
			if (attempt.note) warnings.push(attempt.note);
			lastError = undefined;
			break;
		} catch (error) {
			lastError = error;
			if (attempt.note === undefined && attempts.length > 1) {
				log(`${attempt.label} 失败，尝试下一种路径`);
			}
			// 显式指定了格式时不擅自换格式
			if (format || audioOnly) throw error;
		}
	}
	if (usedFormat === undefined) throw lastError ?? new Error("下载失败");

	const found = await findOutputFile(dir, prefix);
	if (!found) {
		const entries = await fsp.readdir(dir).catch(() => []);
		throw new Error(`下载结束但没找到输出文件（目录：${dir}）\n目录内容：${entries.slice(0, 10).join(", ") || "空"}`);
	}
	const probe = await ffprobeFile(found.file, signal);
	const meta = describeProbe(probe);
	const expected = endSeconds - startSeconds;
	if (Number.isFinite(meta.duration) && Math.abs(meta.duration - expected) > 5) {
		warnings.push(
			`实际时长 ${meta.duration.toFixed(1)}s 与请求的 ${expected.toFixed(1)}s 相差超过 5s，可能边界吸附到关键帧或下载不完整。`,
		);
	}
	if (!meta.audio && !audioOnly) warnings.push("输出文件没有音轨，请检查格式选择。");
	return {
		file: found.file,
		dir,
		title: info.title,
		uploader: info.uploader,
		videoDuration: info.duration,
		start: formatTime(startSeconds),
		end: formatTime(endSeconds),
		expectedDuration: expected,
		actualDuration: meta.duration,
		sizeBytes: meta.sizeBytes,
		videoCodec: meta.video?.codec,
		width: meta.video?.width,
		height: meta.video?.height,
		audioCodec: meta.audio?.codec,
		usedFormat,
		warnings,
	};
}

/**
 * 校验一个本地片段：时长/编码/音量 + 抽帧与拼图。
 */
export async function verifyClip({ file, samples = 6, outDir, cwd, signal }) {
	if (typeof file !== "string" || file.trim() === "") throw new Error("缺少 file（本地视频路径）");
	const target = path.isAbsolute(file) ? file : path.join(cwd || process.cwd(), file);
	if (!(await exists(target))) throw new Error(`文件不存在：${target}`);
	const probe = await ffprobeFile(target, signal);
	const meta = describeProbe(probe);
	const meanDb = await audioMeanDb(target, signal);

	const count = Math.max(2, Math.min(12, Math.floor(Number(samples) || 6)));
	const dir = outDir
		? (path.isAbsolute(outDir) ? outDir : path.join(cwd || process.cwd(), outDir))
		: path.join(path.dirname(target), `${path.basename(target, path.extname(target))}_check`);
	const framesDir = path.join(dir, "frames");
	await fsp.mkdir(framesDir, { recursive: true });

	const duration = meta.duration || 0;
	const times = [];
	if (duration > 0) {
		for (let i = 0; i < count; i += 1) {
			const at = duration * ((i + 0.5) / count);
			times.push(Math.min(Math.max(0, at), Math.max(0, duration - 0.5)));
		}
	}
	const frames = [];
	for (let i = 0; i < times.length; i += 1) {
		const frameFile = path.join(framesDir, `f_${String(i + 1).padStart(3, "0")}.jpg`);
		try {
			await run(
				"ffmpeg",
				["-v", "error", "-ss", String(times[i].toFixed(3)), "-i", target, "-frames:v", "1", "-vf", "scale=720:-2", "-y", frameFile],
				{ signal, timeoutMs: 120_000 },
			);
			frames.push({ time: formatTime(times[i]), file: frameFile });
		} catch {}
	}

	let sheet;
	if (frames.length >= 2) {
		sheet = path.join(dir, "sheet.jpg");
		const columns = frames.length >= 6 ? 3 : 2;
		const rows = Math.ceil(frames.length / columns);
		try {
			await run(
				"ffmpeg",
				[
					"-v", "error",
					"-start_number", "1",
					"-i", path.join(framesDir, "f_%03d.jpg"),
					"-filter_complex", `tile=${columns}x${rows}:padding=6:color=white`,
					"-frames:v", "1",
					"-y", sheet,
				],
				{ signal, timeoutMs: 120_000 },
			);
		} catch {
			sheet = undefined;
		}
	}

	return {
		file: target,
		dir,
		framesDir,
		sheetFile: sheet,
		frames,
		duration: meta.duration,
		sizeBytes: meta.sizeBytes,
		videoCodec: meta.video?.codec,
		width: meta.video?.width,
		height: meta.video?.height,
		fps: meta.video?.fps,
		audioCodec: meta.audio?.codec,
		audioMeanDb: meanDb,
		hasAudio: meta.audio !== undefined,
	};
}

// ---------------------------------------------------------------------------
// 内网分享：带 Range 的只读 HTTP 服务
// ---------------------------------------------------------------------------

const shares = new Map();
let shareSeq = 0;

function lanUrls(port, name, isDirectory = false) {
	const urls = [];
	const interfaces = os.networkInterfaces();
	const suffix = isDirectory ? "" : encodeURIComponent(name);
	for (const [ifname, addresses] of Object.entries(interfaces)) {
		if (/^(lo|docker|br-|veth|virbr|zt|tun|wg)/i.test(ifname)) continue;
		for (const address of addresses ?? []) {
			if (address.family !== "IPv4" || address.internal) continue;
			urls.push(`http://${address.address}:${port}/${suffix}`);
		}
	}
	return urls;
}

const MIME_BY_EXT = {
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".wav": "audio/wav",
	".zip": "application/zip",
	".tgz": "application/gzip",
	".gz": "application/gzip",
	".pdf": "application/pdf",
	".json": "application/json",
	".txt": "text/plain; charset=utf-8",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
};

function serveFile(req, res, file, stat) {
	const size = stat.size;
	const range = req.headers.range;
	let start = 0;
	let end = size - 1;
	let status = 200;
	if (range) {
		const match = /bytes=(\d*)-(\d*)/.exec(String(range));
		if (match) {
			if (match[1] !== "") {
				start = Number(match[1]);
				end = match[2] !== "" ? Number(match[2]) : size - 1;
			} else if (match[2] !== "") {
				start = Math.max(0, size - Number(match[2]));
			}
			end = Math.min(end, size - 1);
			if (start > end || start >= size) {
				res.writeHead(416, { "Content-Range": `bytes */${size}` });
				res.end();
				return;
			}
			status = 206;
		}
	}
	const headers = {
		"Content-Type": MIME_BY_EXT[path.extname(file).toLowerCase()] ?? "application/octet-stream",
		"Content-Length": String(end - start + 1),
		"Accept-Ranges": "bytes",
		"Last-Modified": stat.mtime.toUTCString(),
		"Cache-Control": "no-store",
	};
	for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
	if (status === 206) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
	res.writeHead(status);
	if (req.method === "HEAD") {
		res.end();
		return;
	}
	const stream = fs.createReadStream(file, { start, end });
	stream.on("error", () => res.destroy());
	stream.pipe(res);
}

/**
 * 起一个临时分享。
 * @returns {Promise<object>} { id, port, urls, expiresAt, file }
 */
export async function startShare({ target, port = 0, ttlSeconds = 1800, bind = "0.0.0.0", cwd, signal }) {
	if (typeof target !== "string" || target.trim() === "") throw new Error("缺少 target（要分享的文件或目录）");
	const resolved = path.isAbsolute(target) ? target : path.join(cwd || process.cwd(), target);
	const stat = await fsp.stat(resolved).catch(() => undefined);
	if (!stat) throw new Error(`路径不存在：${resolved}`);
	const root = stat.isDirectory() ? resolved : path.dirname(resolved);
	const single = stat.isFile() ? path.basename(resolved) : undefined;

	const server = createServer((req, res) => {
		try {
			if (req.method !== "GET" && req.method !== "HEAD") {
				res.writeHead(405, { Allow: "GET, HEAD" });
				res.end();
				return;
			}
			const rawPath = decodeURIComponent(String(req.url ?? "/").split("?")[0]);
			let relative;
			if (rawPath === "/" || rawPath === "") {
				if (single === undefined) {
					res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("目录列表已关闭，请使用具体文件名。");
					return;
				}
				relative = single;
			} else {
				relative = rawPath.replace(/^\/+/, "");
			}
			if (single !== undefined && relative !== single) {
				res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Not found");
				return;
			}
			const normalized = path.normalize(relative);
			if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
				res.writeHead(403);
				res.end();
				return;
			}
			const file = path.join(root, normalized);
			if (!file.startsWith(root + path.sep) && file !== root) {
				res.writeHead(403);
				res.end();
				return;
			}
			fs.stat(file, (error, fileStat) => {
				if (error || !fileStat.isFile()) {
					res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					res.end("Not found");
					return;
				}
				serveFile(req, res, file, fileStat);
			});
		} catch {
			res.writeHead(500);
			res.end();
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(Number(port) || 0, bind, () => resolve());
	});
	const actualPort = server.address().port;
	const name = single ?? path.basename(root);
	const id = `share-${++shareSeq}`;
	const ttl = Math.max(30, Math.min(Number(ttlSeconds) || 1800, 24 * 3600));
	const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
	const timer = setTimeout(() => {
		try {
			server.close();
		} catch {}
		shares.delete(id);
	}, ttl * 1000);
	timer.unref?.();
	const record = {
		id,
		server,
		timer,
		root,
		single,
		port: actualPort,
		expiresAt,
		urls: lanUrls(actualPort, name, single === undefined),
	};
	shares.set(id, record);
	signal?.addEventListener?.("abort", () => stopShare({ id }), { once: true });
	return {
		id,
		port: actualPort,
		urls: record.urls,
		expiresAt,
		ttlSeconds: ttl,
		file: single ? path.join(root, single) : root,
	};
}

/** 停掉一个或全部分享。 */
export function stopShare({ id } = {}) {
	const ids = id ? [id] : [...shares.keys()];
	const stopped = [];
	for (const shareId of ids) {
		const record = shares.get(shareId);
		if (!record) continue;
		try {
			record.server.close();
		} catch {}
		clearTimeout(record.timer);
		shares.delete(shareId);
		stopped.push(shareId);
	}
	return { stopped, remaining: [...shares.keys()] };
}

/** 列出当前活跃的分享。 */
export function listShares() {
	return [...shares.values()].map((record) => ({
		id: record.id,
		port: record.port,
		urls: record.urls,
		expiresAt: record.expiresAt,
		file: record.single ? path.join(record.root, record.single) : record.root,
	}));
}
