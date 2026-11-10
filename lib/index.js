/**
 * dsh-video-clip —— DSH 插件入口。
 *
 * 注册三件事：
 *  1. 工具 `video_clip_download`：按时间区间下载视频片段（yt-dlp 分段；DASH 定位失败自动回退 HLS）。
 *  2. 工具 `video_clip_verify`：ffprobe 元数据 + 音量 + 抽帧拼图，供模型核对边界与内容。
 *  3. 工具 `file_share`：把文件/目录起成带 Range 的临时 HTTP 服务，返回内网下载链接。
 * 另附 skill `video-clip`：告诉模型什么时候用、怎么串起这三步。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
	VERSION,
	downloadClip,
	listShares,
	message,
	parseTime,
	startShare,
	stopShare,
	verifyClip,
} from "./clip.mjs";

export const name = "dsh-video-clip";

/**
 * cordis 服务依赖：工具注册表、skill 注册表、会话工作目录。
 * 缺任何一个都会在宿主启动阶段报 `cannot get property "…" without inject`。
 */
export const inject = ["tools", "skills", "workingDirectory"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_NAME = "video-clip";

/** 去掉值为 undefined 的键：output schema 是封闭对象，undefined 会导致快照失败。 */
function compact(value) {
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined) out[key] = item;
	}
	return out;
}

async function sessionCwd(ctx, exec) {
	try {
		const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
		return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
	} catch {
		return undefined;
	}
}

const DOWNLOAD_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		ok: { type: "boolean" },
		error: { type: "string" },
		file: { type: "string" },
		dir: { type: "string" },
		title: { type: "string" },
		uploader: { type: "string" },
		start: { type: "string" },
		end: { type: "string" },
		expectedDuration: { type: "number" },
		actualDuration: { type: "number" },
		sizeBytes: { type: "number" },
		width: { type: "number" },
		height: { type: "number" },
		videoCodec: { type: "string" },
		audioCodec: { type: "string" },
		usedFormat: { type: "string" },
		report: { type: "string" },
		warnings: { type: "array", items: { type: "string" } },
	},
};

const VERIFY_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		ok: { type: "boolean" },
		error: { type: "string" },
		file: { type: "string" },
		dir: { type: "string" },
		framesDir: { type: "string" },
		sheetFile: { type: "string" },
		duration: { type: "number" },
		sizeBytes: { type: "number" },
		width: { type: "number" },
		height: { type: "number" },
		fps: { type: "string" },
		videoCodec: { type: "string" },
		audioCodec: { type: "string" },
		audioMeanDb: { type: "number" },
		hasAudio: { type: "boolean" },
		sampleTimes: { type: "array", items: { type: "string" } },
		report: { type: "string" },
	},
};

const SHARE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		ok: { type: "boolean" },
		error: { type: "string" },
		action: { type: "string" },
		shareId: { type: "string" },
		port: { type: "number" },
		urls: { type: "array", items: { type: "string" } },
		expiresAt: { type: "string" },
		file: { type: "string" },
		active: { type: "array", items: { type: "string" } },
		report: { type: "string" },
	},
};

function humanSize(bytes) {
	const value = Number(bytes) || 0;
	if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
	if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
	if (value >= 1024) return `${(value / 1024).toFixed(0)} KiB`;
	return `${value} B`;
}

export function apply(ctx) {
	// -------------------------------------------------------------------
	// 1. 下载工具
	// -------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "video_clip_download",
		description: [
			"按时间区间下载视频片段（yt-dlp 支持的站点，如 YouTube、B 站），只下载需要的那一段，不会先下整片。",
			"适用于：1 小时视频只要中间 20 分钟、长直播回放里截某场演讲、从视频里取某个话题的片段。",
			"开始/结束时间支持 HH:MM:SS 或秒数；返回本地文件路径、实际时长、大小与告警。",
			"DASH 直链在当前网络无法定位时会自动回退 HLS 分片，不需要手动处理。",
			"下载后建议再用 video_clip_verify 核对边界与音轨，需要分享时用 file_share。",
		].join(" "),
		timeoutMs: 45 * 60_000,
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "视频地址，例如 https://www.youtube.com/watch?v=xxxx",
			},
			start: {
				type: "string",
				required: true,
				description: "开始时间，HH:MM:SS 或秒数，例如 05:06:50 或 18410",
			},
			end: {
				type: "string",
				required: true,
				description: "结束时间，HH:MM:SS 或秒数，例如 05:31:34 或 18934",
			},
			quality: {
				type: "string",
				description: "清晰度上限，默认 1080p；可写 720p / 480p / best",
			},
			format: {
				type: "string",
				description: "高级：直接指定 yt-dlp -f 格式串（如 137+140），指定后不再自动回退 HLS",
			},
			outDir: {
				type: "string",
				description: "输出目录；相对路径基于会话工作目录，默认 <工作目录>/download",
			},
			audioOnly: {
				type: "boolean",
				description: "只下载音频",
			},
			forceKeyframes: {
				type: "boolean",
				description: "在切点强制关键帧（分秒精确，但会重编码、慢很多）",
			},
		},
		output: {
			schema: DOWNLOAD_SCHEMA,
			render: (_args, value) => [{ type: "text", text: value.report ?? (value.ok ? "下载完成" : value.error ?? "下载失败") }],
		},
		async execute(args, exec) {
			const cwd = await sessionCwd(ctx, exec);
			const seconds = parseTime(args.start);
			const endSeconds = parseTime(args.end);
			if (!Number.isFinite(seconds) || !Number.isFinite(endSeconds)) {
				return { ok: false, error: "start / end 时间格式无法解析（用 HH:MM:SS 或秒数）" };
			}
			try {
				const result = await downloadClip({
					url: args.url,
					start: args.start,
					end: args.end,
					quality: args.quality,
					format: args.format,
					outDir: args.outDir,
					audioOnly: args.audioOnly === true,
					forceKeyframes: args.forceKeyframes === true,
					cwd,
					signal: exec.signal,
				});
				const lines = [
					`已下载：${result.file}`,
					`标题：${result.title ?? "(未知)"}${result.uploader ? `（${result.uploader}）` : ""}`,
					`区间：${result.start} → ${result.end}（请求 ${result.expectedDuration.toFixed(1)}s，实际 ${Number(result.actualDuration).toFixed(1)}s）`,
					`规格：${result.width ?? "?"}x${result.height ?? "?"} ${result.videoCodec ?? ""}/${result.audioCodec ?? "无音轨"}，${humanSize(result.sizeBytes)}`,
					`格式：${result.usedFormat}`,
					...result.warnings.map((w) => `注意：${w}`),
					"下一步：可用 video_clip_verify 抽帧核对内容边界，或 file_share 生成内网下载链接。",
				];
				return compact({
					ok: true,
					file: result.file,
					dir: result.dir,
					title: result.title,
					uploader: result.uploader,
					start: result.start,
					end: result.end,
					expectedDuration: result.expectedDuration,
					actualDuration: result.actualDuration,
					sizeBytes: result.sizeBytes,
					width: result.width,
					height: result.height,
					videoCodec: result.videoCodec,
					audioCodec: result.audioCodec,
					usedFormat: result.usedFormat,
					warnings: result.warnings.length > 0 ? result.warnings : undefined,
					report: lines.join("\n"),
				});
			} catch (error) {
				return { ok: false, error: message(error) };
			}
		},
	}));

	// -------------------------------------------------------------------
	// 2. 校验工具
	// -------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "video_clip_verify",
		description: [
			"校验一个本地视频片段：读取真实时长/编码/分辨率/音轨，检测平均音量，按时间均匀抽关键帧并拼成一张接触印相纸。",
			"用来确认「下载的片段起点是不是用户要的画面」「音轨在不在」「时长和请求是否一致」。",
			"返回 sheetFile（拼图）与 framesDir（单帧目录）：先读拼图通读，再对关键格回读单帧核对文字。",
		].join(" "),
		timeoutMs: 5 * 60_000,
		parameters: {
			file: {
				type: "string",
				required: true,
				description: "要校验的本地视频路径（绝对路径，或基于会话工作目录）",
			},
			samples: {
				type: "number",
				description: "抽帧数量，默认 6，范围 2–12",
			},
			outDir: {
				type: "string",
				description: "抽帧输出目录；默认与视频同级的 <文件名>_check",
			},
		},
		output: {
			schema: VERIFY_SCHEMA,
			render: (_args, value) => [{ type: "text", text: value.report ?? (value.ok ? "校验完成" : value.error ?? "校验失败") }],
		},
		async execute(args, exec) {
			const cwd = await sessionCwd(ctx, exec);
			try {
				const result = await verifyClip({
					file: args.file,
					samples: args.samples,
					outDir: args.outDir,
					cwd,
					signal: exec.signal,
				});
				const lines = [
					`文件：${result.file}`,
					`时长：${Number(result.duration).toFixed(2)}s，大小：${humanSize(result.sizeBytes)}`,
					`视频：${result.width ?? "?"}x${result.height ?? "?"} ${result.videoCodec ?? ""} ${result.fps ?? ""}`,
					`音频：${result.hasAudio ? `${result.audioCodec ?? ""} 平均音量 ${result.audioMeanDb ?? "?"} dB` : "无音轨"}`,
					result.sheetFile ? `拼图：${result.sheetFile}` : "拼图：生成失败",
					`单帧目录：${result.framesDir}`,
					...result.frames.map((frame) => `- ${frame.time} → ${frame.file}`),
					"先读拼图通读一遍；涉及文字/数字的格子再回读对应单帧。",
				];
				return compact({
					ok: true,
					file: result.file,
					dir: result.dir,
					framesDir: result.framesDir,
					sheetFile: result.sheetFile,
					duration: result.duration,
					sizeBytes: result.sizeBytes,
					width: result.width,
					height: result.height,
					fps: result.fps,
					videoCodec: result.videoCodec,
					audioCodec: result.audioCodec,
					audioMeanDb: result.audioMeanDb,
					hasAudio: result.hasAudio,
					sampleTimes: result.frames.map((frame) => frame.time),
					report: lines.join("\n"),
				});
			} catch (error) {
				return { ok: false, error: message(error) };
			}
		},
	}));

	// -------------------------------------------------------------------
	// 3. 内网分享工具
	// -------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "file_share",
		description: [
			"把本地文件/目录起成一个带 Range 的只读临时 HTTP 服务，返回内网可访问的下载链接（支持断点续传与视频拖动）。",
			"action=start 默认，传 path 即可；action=list 列出活跃分享；action=stop 停止（传 shareId 或全部停止）。",
			"默认 30 分钟后自动关闭；链接里给的是本机所有非内部 IPv4 地址，按需挑一个给用户。",
			"目录分享关闭了列表页，只按具体文件名提供下载；适合把下载好的视频给同一内网的人取走。",
		].join(" "),
		timeoutMs: 2 * 60_000,
		parameters: {
			action: {
				type: "string",
				enum: ["start", "stop", "list"],
				description: "start 起服务（默认）；list 查看；stop 停止",
			},
			path: {
				type: "string",
				description: "要分享的文件或目录（start 必填）；相对路径基于会话工作目录",
			},
			port: {
				type: "number",
				description: "监听端口，默认 0（系统分配）",
			},
			ttlSeconds: {
				type: "number",
				description: "自动关闭秒数，默认 1800，最大 86400",
			},
			bind: {
				type: "string",
				description: "监听地址，默认 0.0.0.0（局域网可访问）；只本机可用 127.0.0.1",
			},
			shareId: {
				type: "string",
				description: "stop 时指定要停止的分享 id；省略则停止全部",
			},
		},
		output: {
			schema: SHARE_SCHEMA,
			render: (_args, value) => [{ type: "text", text: value.report ?? (value.ok ? "完成" : value.error ?? "失败") }],
		},
		async execute(args, exec) {
			const action = args.action ?? "start";
			try {
				if (action === "list") {
					const active = listShares();
					return compact({
						ok: true,
						action,
						active: active.flatMap((item) => item.urls.map((url) => `${item.id} ${url}`)),
						report: active.length === 0
							? "当前没有活跃的分享。"
							: active.flatMap((item) => [`${item.id}（过期：${item.expiresAt}）`, ...item.urls.map((url) => `  ${url}`)]).join("\n"),
					});
				}
				if (action === "stop") {
					const result = stopShare({ id: args.shareId });
					return compact({
						ok: true,
						action,
						active: result.remaining,
						report: result.stopped.length > 0
							? `已停止：${result.stopped.join(", ")}${result.remaining.length > 0 ? `；仍在运行：${result.remaining.join(", ")}` : ""}`
							: "没有匹配的活跃分享。",
					});
				}
				const cwd = await sessionCwd(ctx, exec);
				const result = await startShare({
					target: args.path,
					port: args.port,
					ttlSeconds: args.ttlSeconds,
					bind: args.bind,
					cwd,
					signal: exec.signal,
				});
				const isDirectory = result.urls.every((url) => url.endsWith("/")) || result.urls.length === 0;
				const lines = [
					`分享已启动：${result.id}（端口 ${result.port}，${result.expiresAt} 自动关闭）`,
					`文件：${result.file}`,
					...result.urls.map((url) => `链接：${url}`),
					isDirectory ? "这是目录分享：把具体文件名接在链接后面下载（目录列表不对外）。" : "",
					"提醒用户：链接只在同一内网/可达网段有效；用完可以 file_share action=stop 关闭。",
				].filter(Boolean);
				return compact({
					ok: true,
					action,
					shareId: result.id,
					port: result.port,
					urls: result.urls,
					expiresAt: result.expiresAt,
					file: result.file,
					report: lines.join("\n"),
				});
			} catch (error) {
				return { ok: false, action, error: message(error) };
			}
		},
	}));

	// -------------------------------------------------------------------
	// 4. Skill：什么时候用、怎么串起来
	// -------------------------------------------------------------------
	ctx.skills.register({
		name: SKILL_NAME,
		description:
			"按时间区间下载视频片段：给定视频链接和起止时间，只下这一段；下载后抽帧核对边界，需要时生成内网下载链接。",
		source: `plugin:${name}`,
		content: SKILL_BODY,
		resourceBase: { kind: "directory", path: HERE },
	});

	// 插件卸载时关掉还在跑的分享，避免端口泄漏。
	ctx.on("dispose", () => {
		try {
			stopShare();
		} catch {}
	});
}

const SKILL_BODY = `# 视频分段下载

用户给了视频链接和时间范围（例如「05:06:50 到 05:31:34」），只想要这一段时用本插件。

## 流程

1. **先看清请求**：确认 URL、起止时间（HH:MM:SS 或秒）与清晰度期望。时间不完整时按「从 X 到片尾」或先 probe 时长再补。
2. **下载**：调用 \`video_clip_download\`，至少传 \`url\`/\`start\`/\`end\`。
   - 默认 1080p；要小体积传 \`quality: "720p"\`。
   - 长视频（>30 分钟）默认走 HLS 分片，DASH 直链不可靠时工具会自己切换并说明，不用手动重试。
   - 只要音频传 \`audioOnly: true\`。
3. **核对边界**：调用 \`video_clip_verify\`，传下载得到的 \`file\`。
   - 先读 \`sheetFile\` 拼图通读全片；涉及文字、数字、标题的格子再回读 \`framesDir\` 里对应单帧。
   - 检查：起点是不是用户要的画面、终点是否落在正确位置、时长是否≈ end-start、\`hasAudio\` 是否为 true。
   - 边界偏差多半是吸附到关键帧；若用户要分秒精确，用 \`forceKeyframes: true\` 重下（会重编码，慢）。
4. **交付**：产物路径直接给用户；需要别人的机器取走时用 \`file_share\`（\`action: "start"\`, \`path\` 指向文件），把返回的 URL 给用户，并说明是临时服务、多久自动关闭。用完可 \`action: "stop"\`。

## 参数速查

\`\`\`
video_clip_download { url, start, end, quality?, format?, outDir?, audioOnly?, forceKeyframes? }
video_clip_verify   { file, samples?, outDir? }
file_share          { action?: start|stop|list, path?, port?, ttlSeconds?, bind?, shareId? }
\`\`\`

## 常见坑

- **时间格式**：\`05:06:50\` 是 5 小时 6 分 50 秒，不是 5 分 6 秒；也接受 \`18410\` 这种秒数。
- **长视频**：先看工具返回的 \`videoDuration\` 确认区间没超出片尾。
- **边界吸附**：不加 \`forceKeyframes\` 时起点可能早/晚 1–2 帧到数秒；对 25 分钟片段重编码代价很大，先用 verify 判断是否可接受。
- **长视频策略**：超过 30 分钟的视频默认优先 HLS（m3u8）分片，因为 YouTube 长回放的 DASH 直链经常无法按时间定位、会一直读远端；想让工具换路径可在 \`quality\` 里写 \`hls\`。
- **登录/机器人验证**：YouTube 报 "Sign in to confirm you're not a bot" 时，给插件设环境变量 \`DSH_VIDEO_CLIP_COOKIES_FROM_BROWSER=chrome\`（或 \`DSH_VIDEO_CLIP_COOKIES=/path/cookies.txt\`）后让宿主重启。
- **依赖**：需要 ffmpeg/ffprobe；yt-dlp 缺失时插件会自动 pip 安装到 \`$DSH_HOME/cache/video-clip/ytdlp\`。
- **分享链接**：默认只监听 \`0.0.0.0\` 且 30 分钟自动关闭；跨网段/防火墙不通时换端口或改 \`bind\`。
`;

export { VERSION };
