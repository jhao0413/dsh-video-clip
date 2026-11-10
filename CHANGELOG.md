# Changelog

## 0.1.0

- 首个版本：`video_clip_download` / `video_clip_verify` / `file_share` 三个工具 + `video-clip` skill。
- 按时间区间下载（yt-dlp `--download-sections`），只传输所需分片。
- 长视频（>30 分钟）默认优先 HLS（m3u8）分片，规避 DASH 直链无法定位时「看起来卡住」的问题。
- 下载尝试链：DASH → HLS 回退 / HLS → DASH 兜底；遇到 `could not seek` 等错误立即中止换路径，单次尝试带超时。
- 下载后自动做时长/音轨校验并给出告警；`video_clip_verify` 提供抽帧与拼图。
- `file_share` 提供带 Range 的只读临时 HTTP 服务，默认 30 分钟自动关闭，支持内网多网卡地址列举。
