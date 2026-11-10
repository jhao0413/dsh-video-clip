# dsh-video-clip

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的插件：
**按时间区间下载视频片段，只下需要的那一段，下载完还能抽帧核对边界、直接给出内网下载链接。**

长视频（发布会、论坛直播回放、8 小时的议程视频）里往往只想要其中一场演讲。
这个插件把「整片下下来再剪」换成「只请求那 20 分钟」——一小时视频取中间 20 分钟，
实际传输量是整片的 1/3，而不是先下完再删。

## 注册了什么

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `video_clip_download` | 工具 | 按 `start`–`end` 下载片段；DASH 直链无法定位时自动回退 HLS 分片 |
| `video_clip_verify` | 工具 | ffprobe 时长/编码/音轨 + 平均音量 + 均匀抽帧拼图，核对起止边界 |
| `file_share` | 工具 | 把文件/目录起成带 Range 的临时 HTTP 服务，返回内网下载链接 |
| `video-clip` | skill | 告诉模型什么时候用、怎么把三步串起来 |

## 装好之后

> 你：把这个视频从 05:06:50 到 05:31:34 下下来 `https://www.youtube.com/watch?v=0TBBRmDhnc4`
>
> 助手：调 `video_clip_download` → 只下这 24 分 44 秒 → 调 `video_clip_verify` 抽帧确认
> 起点是演讲标题页、结尾落在 Summary 页 → 把文件路径给你；需要分享时再 `file_share` 出一个链接。

## 安装

```bash
# 从 npm（发布后）
dsh plugin --profile web add dsh-video-clip

# 本地开发：直接指向本目录
dsh plugin --profile web add link:/绝对路径/dsh-video-clip

# 卸载
dsh plugin --profile web remove dsh-video-clip
```

装好后重启 DSH。插件需要 **ffmpeg / ffprobe**；yt-dlp 缺失时会自动 `pip install --target $DSH_HOME/cache/video-clip/ytdlp yt-dlp`。

## 工具参数

### video_clip_download

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | 视频地址（yt-dlp 支持的站点） |
| `start` | 是 | 开始时间，`HH:MM:SS` 或秒数（`18410`） |
| `end` | 是 | 结束时间 |
| `quality` | 否 | 清晰度上限，默认 `1080p`，可 `720p` / `480p` / `best` |
| `format` | 否 | 高级：直接指定 `-f` 格式串（如 `137+140`），指定后不自动回退 |
| `outDir` | 否 | 输出目录，默认 `<会话工作目录>/download` |
| `audioOnly` | 否 | 只下音频 |
| `forceKeyframes` | 否 | 切点强制关键帧（分秒精确，但重编码、慢） |

返回：本地路径、实际时长、大小、分辨率、编码、使用的格式、告警列表。

### video_clip_verify

`file`（必填）+ `samples`（抽帧数，默认 6）+ `outDir`。返回拼图 `sheetFile`、单帧目录 `framesDir`、
时长、音轨与平均音量。先读拼图通读，再对关键格回读单帧核对文字。

### file_share

| action | 参数 | 说明 |
| --- | --- | --- |
| `start`（默认） | `path`、`port`、`ttlSeconds`、`bind` | 起只读 HTTP 服务，返回 `http://<内网IP>:<port>/<文件名>` |
| `list` | — | 列出活跃分享 |
| `stop` | `shareId` | 停止指定分享；省略停止全部 |

默认 30 分钟自动关闭；支持 Range（断点续传、视频拖动）；目录分享不暴露列表页。

## 为什么长视频优先走 HLS

YouTube 的 DASH 直链（`PROTO=https`）是分片 MP4。在部分网络/网关下 ffmpeg 无法对其定位，
`--download-sections` 会报 `could not seek to position …` / `partial file`，然后一直读远端的整段文件
（看起来像「卡住」）。所以插件对**时长超过 30 分钟的视频**（直播回放、论坛全程）默认改走 HLS（m3u8）分片：
分片天然支持按区间取，稳定且只传需要的部分；短片段仍优先 DASH（更省流量）。
显式写 `format` 时插件不擅自换格式；也可以把 `quality` 写成 `720p-hls` 之类强制走 HLS。

## 常见问题

- **YouTube 机器人验证**：`Sign in to confirm you're not a bot` 时设置环境变量
  `DSH_VIDEO_CLIP_COOKIES_FROM_BROWSER=chrome`（或 `DSH_VIDEO_CLIP_COOKIES=/path/cookies.txt`）后重启宿主。
- **边界差几秒**：不加 `forceKeyframes` 时切点吸附到关键帧；25 分钟片段重编码代价很大，先看 verify 结果再决定。
- **分享链接打不开**：确认对方和本机在同一网段、端口没被防火墙挡；可换 `port` 或把 `bind` 改成具体网卡地址。
- **依赖**：`ffmpeg`/`ffprobe` 必须在 PATH 里；没装时工具会返回安装命令。

## 开发

```bash
npm run check        # node --check
npm test                                      # 冒烟测试（不需要网络；会链接本地 peer 依赖）
SMOKE_NETWORK=1 npm test                      # 加上真实网络下载 10 秒片段
```

## 发布

分发只靠 npm；市场（dshopen / dshmarket）只存元数据、安装时仍回 npm。

```bash
# 1) 登录（本机默认没有 npm 凭据；CI 里用 NPM_TOKEN 环境变量）
npm login

# 2) 发布（发布前先 npm pack 看一眼内容）
npm publish --access public

# 3) 验证：任一台机器
dsh plugin --profile web add dsh-video-clip
dsh --profile web --dump-config | grep dsh-video-clip   # 确认 patch 合入
```

上架市场（可选，只为「被发现」）：

```bash
# dshopen 索引：GitHub issue 申请收录（跟 npm latest，发新版本不用重新申请）
gh issue create -R polang233/dsh-plugin-index --template plugin-add.yml \
  --title "[plugin-add] dsh-video-clip" --body "npm 包：dsh-video-clip。按时间区间下载视频片段 + 抽帧核对 + 内网 HTTP 分享。"

# dshmarket：向精选列表提 PR（仓库需公开、建满 1 天、带 dsh-plugin topic）
# 新增 data/plugins/<owner>__<repo>.yml
```

硬性要求（不满足会被 `dsh plugin add` 拒装或不被索引）：

- `package.json` 必须有 `dsh.bundle.patch` 且 patch 文件真的进了发布包（`files` 里）；
- `engines.dsh` / `@deepseek-ai/dsh-*` peer 范围要覆盖目标运行时版本；
- 公开仓库 + `license` 字段 + LICENSE 文件。

没有 npm 凭据时的内网/临时分发方式（仍要求 `dsh.bundle.patch`）：

```bash
dsh plugin --profile web add /abs/path/to/dsh-video-clip        # 本地目录
dsh plugin --profile web add ./dsh-video-clip-0.1.0.tgz         # tarball
dsh plugin --profile web add github:owner/repo#<40位commit>     # 固定提交
```

## License

MIT
