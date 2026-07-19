# 第三方组件许可证与来源

此目录会作为 Windows 安装包资源随应用分发。VideoSweeper 不随包提供下列媒体 sidecar；本文件仅保留用户可选安装工具的上游许可证与来源说明，供“关于与诊断”中的“打开许可证”入口访问。

## FFmpeg 与 FFprobe

- 文件：`ffmpeg-x86_64-pc-windows-msvc.exe`、`ffprobe-x86_64-pc-windows-msvc.exe`
- 上游项目：<https://ffmpeg.org/>
- 官方 Windows 下载说明：<https://ffmpeg.org/download.html#build-windows>

用户取得的构建可能为 LGPL 或 GPL，取决于其实际配置。若构建包含 `--enable-gpl` 或 `--enable-nonfree`，不得将其标注为 LGPL-only；本项目不对用户自行下载的二进制重新授权。

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

1. 发布人员必须确认安装包不包含本文件列出的可执行文件。
2. 用户自行安装工具时，应核验下载来源、版本、哈希、许可证与源代码获取说明，不得把 GPL 构建标注为 LGPL。
3. 本项目许可证为 MIT；此文件不改变用户自行取得的任何第三方二进制许可证。
