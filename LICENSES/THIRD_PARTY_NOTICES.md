# 第三方组件许可证与来源

此目录会作为 Windows 安装包资源随应用分发。它记录本版本随包的媒体 sidecar，供“关于与诊断”中的“打开许可证”入口访问。

## FFmpeg 与 FFprobe

- 文件：`ffmpeg-x86_64-pc-windows-msvc.exe`、`ffprobe-x86_64-pc-windows-msvc.exe`
- 已核验构建标识：`2026-07-13-git-9c2aabaa34-full_build-www.gyan.dev`
- 上游项目：<https://ffmpeg.org/>
- 二进制发行来源：<https://www.gyan.dev/ffmpeg/builds/>
- 许可证：GNU General Public License，版本 3 或更高版本。

该构建的 `ffmpeg -version` 明确包含 `--enable-gpl --enable-version3`。因此 VideoSweeper 不将其描述为 LGPL 构建；重新替换二进制时，必须重新核验其配置、许可证和源代码获取方式。

完整的 GPLv3 文本及对应源代码获取说明见：

- <https://www.gnu.org/licenses/gpl-3.0.html>
- <https://ffmpeg.org/legal.html>
- <https://www.gyan.dev/ffmpeg/builds/>

## ffmpegthumbnailer

- 文件：`ffmpegthumbnailer-x86_64-pc-windows-msvc.exe`
- 上游项目：<https://github.com/dirkvdb/ffmpegthumbnailer>
- 许可证：GNU General Public License，版本 2 或更高版本。
- 上游许可证文本：<https://github.com/dirkvdb/ffmpegthumbnailer/blob/master/COPYING>

其依赖的 FFmpeg 构建及许可证也必须在替换二进制时重新核验，并随发行包保留完整许可证文本和来源说明。

## 发布约束

1. `RELEASE.md` 中的 SHA-256、构建标识与本目录的来源说明必须来自同一批待发布二进制。
2. 发布人员必须将所选二进制发行包提供的完整许可证文本和源代码获取说明一并保留在本目录；不得以开发机缓存或不明构建替代。
3. 若改用 LGPL-only FFmpeg 构建，必须同步更新本文件、`RELEASE.md`、哈希和“关于”页显示的许可证说明后才能发布。
