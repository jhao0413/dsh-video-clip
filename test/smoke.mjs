/**
 * 本地冒烟测试（不依赖 DSH 宿主）：
 *   NODE_PATH=<dsh>/node_modules node test/smoke.mjs
 * 若想连真实网络下 10 秒片段：SMOKE_NETWORK=1 node test/smoke.mjs
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
	formatTime,
	listShares,
	parseTime,
	startShare,
	stopShare,
	verifyClip,
} from "../lib/clip.mjs";
import { apply } from "../lib/index.js";

const results = [];
async function step(name, fn) {
	try {
		await fn();
		results.push([name, "PASS"]);
		console.log(`PASS ${name}`);
	} catch (error) {
		results.push([name, `FAIL ${error?.message ?? error}`]);
		console.error(`FAIL ${name}\n  ${error?.stack ?? error}`);
	}
}

await step("parseTime / formatTime", () => {
	assert.equal(parseTime("05:06:50"), 5 * 3600 + 6 * 60 + 50);
	assert.equal(parseTime("20:00"), 20 * 60);
	assert.equal(parseTime("18410"), 18410);
	assert.equal(parseTime("1:02:03.5"), 3723.5);
	assert.ok(Number.isNaN(parseTime("abc")));
	assert.equal(formatTime(18410), "05:06:50");
	assert.equal(formatTime(3723.5), "01:02:03.500");
});

const tools = new Map();
const skills = [];
const fakeCtx = {
	tools: { register: (tool) => tools.set(tool.name, tool) },
	skills: { register: (skill) => skills.push(skill) },
	workingDirectory: { ensure: async () => process.cwd() },
	on: () => {},
};

await step("apply() 注册 3 个工具 + 1 个 skill", () => {
	apply(fakeCtx);
	assert.deepEqual([...tools.keys()].sort(), ["file_share", "video_clip_download", "video_clip_verify"]);
	assert.equal(skills.length, 1);
	assert.equal(skills[0].name, "video-clip");
	assert.equal(typeof skills[0].source, "string");
	for (const tool of tools.values()) {
		assert.equal(typeof tool.output.schema, "object");
		assert.equal(typeof tool.output.render, "function");
		assert.equal(typeof tool.execute, "function");
		assert.ok(tool.timeoutMs > 0);
		// output schema 不允许出现 required（宿主会拒绝）
		assert.equal(JSON.stringify(tool.output.schema).includes('"required"'), false);
	}
});

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-video-clip-test-"));
const payload = Buffer.alloc(1024 * 1024);
for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
const demoFile = path.join(tmp, "demo.mp4");
await fsp.writeFile(demoFile, payload);

await step("file_share start / Range / stop", async () => {
	const controller = new AbortController();
	const shareTool = tools.get("file_share");
	const started = await shareTool.execute(
		{ action: "start", path: demoFile, ttlSeconds: 60 },
		{ signal: controller.signal, agent: undefined },
	);
	assert.equal(started.ok, true, started.error);
	assert.ok(started.urls.length > 0, "没有可用网卡地址？");
	const url = started.urls[0];
	assert.deepEqual(listShares().map((item) => item.id), [started.shareId]);

	const head = await fetch(url, { headers: { Range: "bytes=0-99" } });
	assert.equal(head.status, 206);
	assert.equal(head.headers.get("content-range"), `bytes 0-99/${payload.length}`);
	const body = Buffer.from(await head.arrayBuffer());
	assert.equal(body.length, 100);
	assert.deepEqual(body, payload.subarray(0, 100));

	const full = await fetch(url);
	assert.equal(full.status, 200);
	assert.equal(full.headers.get("accept-ranges"), "bytes");
	const all = Buffer.from(await full.arrayBuffer());
	assert.equal(all.length, payload.length);

	const stopped = await shareTool.execute(
		{ action: "stop", shareId: started.shareId },
		{ signal: controller.signal, agent: undefined },
	);
	assert.equal(stopped.ok, true);
	assert.equal(listShares().length, 0);
});

await step("file_share 目录分享不暴露列表", async () => {
	const controller = new AbortController();
	const shareTool = tools.get("file_share");
	const started = await shareTool.execute(
		{ action: "start", path: tmp, ttlSeconds: 60 },
		{ signal: controller.signal, agent: undefined },
	);
	assert.equal(started.ok, true, started.error);
	const base = started.urls[0];
	assert.ok(base.endsWith("/"), `目录分享应返回基础链接：${base}`);
	assert.equal((await fetch(base)).status, 403);
	const direct = await fetch(`${base}demo.mp4`);
	assert.equal(direct.status, 200);
	assert.equal((await fetch(`${base}missing.mp4`)).status, 404);
	stopShare({ id: started.shareId });
});

const sampleVideo = "/data/bitlab-2026-11/download/2026未来科学大奖周-科学峰会2_050650-053134.mp4";
if (fs.existsSync(sampleVideo)) {
	await step("video_clip_verify 抽帧拼图", async () => {
		const controller = new AbortController();
		const outDir = path.join(tmp, "check");
		const result = await verifyClip({ file: sampleVideo, samples: 3, outDir, signal: controller.signal });
		assert.ok(Math.abs(result.duration - 1484) < 2, `时长异常：${result.duration}`);
		assert.equal(result.hasAudio, true);
		assert.equal(result.height, 1080);
		assert.ok(result.frames.length >= 2);
		assert.ok(result.sheetFile && fs.existsSync(result.sheetFile));
		for (const frame of result.frames) assert.ok(fs.existsSync(frame.file));
	});
}

if (process.env.SMOKE_NETWORK === "1") {
	await step("video_clip_download 真实网络下载 10 秒片段", async () => {
		const controller = new AbortController();
		const outDir = path.join(tmp, "download");
		const downloadTool = tools.get("video_clip_download");
		const result = await downloadTool.execute(
			{
				url: "https://www.youtube.com/watch?v=0TBBRmDhnc4",
				start: "05:06:50",
				end: "05:07:00",
				quality: "720p",
				outDir,
			},
			{ signal: controller.signal, agent: undefined },
		);
		assert.equal(result.ok, true, result.error);
		assert.ok(fs.existsSync(result.file));
		assert.ok(Math.abs(result.actualDuration - 10) < 3, `片段时长异常：${result.actualDuration}`);
	});
}

await fsp.rm(tmp, { recursive: true, force: true });
const failed = results.filter(([, status]) => status.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
