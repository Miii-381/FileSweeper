# VideoSweeper

VideoSweeper 是一个 **Windows 端** 本地视频管理应用。本项目的自有源代码使用 [MIT 许可证](LICENSE)。

> 项目仓库、NSIS 安装包、更新包和安装脚本均不包含、不下载、不镜像 FFmpeg、FFprobe 或 ffmpegthumbnailer 二进制文件。用户自行取得、安装并承担所选二进制文件的许可证义务。

## 1. 开发前置条件

目标环境为 Windows x64。构建机器需要安装：

- Node.js 与 npm
- Rust stable MSVC 工具链
- Visual Studio Build Tools（Desktop development with C++）
- Windows 10/11 SDK
- Microsoft Edge WebView2 Runtime

```powershell
node --version
npm --version
rustc --version
cargo --version
npm install
```

## 2. 用户自行安装媒体工具

FFmpeg 和 FFprobe 是完整媒体预览、元数据读取与缩略图回退所需的工具；ffmpegthumbnailer 可选，缺失时应用会回退到 FFmpeg 生成缩略图。

### 下载地址与许可证

- FFmpeg/FFprobe： [FFmpeg 官方 Windows 下载说明](https://ffmpeg.org/download.html#build-windows)。可选择其中列出的可信 Windows 构建来源；若选择 Gyan 的 full build，需注意其构建可能启用 GPL 组件。
- ffmpegthumbnailer： [上游 Releases](https://github.com/dirkvdb/ffmpegthumbnailer/releases)，上游许可证为 GPLv2+。
- FFmpeg 构建的许可证取决于实际 `configure` 参数。若需要 LGPL-only 构建，运行 `ffmpeg -version` 后确认输出不含 `--enable-gpl` 与 `--enable-nonfree`；请同时保留该发行方提供的许可证和源代码获取说明。

项目不为这些工具指定或重新授权许可证。下载后请自行核验来源、版本、哈希和适用许可证。

若所选构建为 GPL 许可，其对应源码及构建脚本应从同一发行方获取；项目不为第三方构建提供源码托管或验证服务。

### 安装位置与文件名

将已下载的可执行文件复制到 **VideoSweeper 安装目录** 下的 `sidecars` 目录。默认当前用户安装通常位于 `%LOCALAPPDATA%\VideoSweeper`；使用自定义安装位置时，以你实际选择的 `VideoSweeper` 目录为准。

```text
<VideoSweeper 安装目录>\sidecars\
  ffmpeg-x86_64-pc-windows-msvc.exe
  ffprobe-x86_64-pc-windows-msvc.exe
  ffmpegthumbnailer-x86_64-pc-windows-msvc.exe   （可选）
```

下载包内一般是 `ffmpeg.exe`、`ffprobe.exe`，或位于 `bin` 子目录；请复制后按上述名称重命名。不要把文件放入应用的 `data` 目录。

> 此文件名为应用内部硬性约定，请勿更改为其他名称，否则无法正常识别。

仓库提供的脚本只复制你已经手动下载的文件，不访问网络也不下载任何二进制。以 PowerShell 7 为例：

```powershell
# 参数说明：<FFmpeg bin目录> <VideoSweeper安装目录> [ffmpegthumbnailer路径]
pwsh -File .\scripts\install-local-media-tools.ps1 `
  "C:\Users\你的用户名\Downloads\ffmpeg\bin" `
  "$env:LOCALAPPDATA\VideoSweeper" `
  "C:\Users\你的用户名\Downloads\ffmpegthumbnailer.exe"
```

前两个位置参数分别为包含 `ffmpeg.exe` 与 `ffprobe.exe` 的目录、VideoSweeper 安装目录；第三个位置参数可省略。脚本会复制并重命名到 `sidecars`，保留用户的原始下载文件。

## 3. 本地开发

开发运行时同样从项目根目录的 `sidecars` 子目录读取用户自行准备的文件。先按上一节放入文件，再执行：

```powershell
npm run check
npm run tauri dev
```

缺少 FFmpeg/FFprobe 时，应用将在日志和控制台输出错误信息，相关媒体功能将被禁用；ffmpegthumbnailer 缺失仅触发缩略图生成回退，不影响核心功能。

## 4. 图标与 NSIS 构建

Tauri 打包 Windows 应用前必须存在 `src-tauri/icons/icon.ico`。可从项目根目录运行：

```powershell
npm run tauri icon app-icon.png
npm run tauri build
```

构建产物通常位于 `src-tauri/target/release/bundle/nsis/`。发布前确认安装包中不含 `ffmpeg*.exe`、`ffprobe*.exe` 或 `ffmpegthumbnailer*.exe`；用户在安装完成后再按第二节自行安装媒体工具。

## 5. 许可证边界

- `LICENSE`：VideoSweeper 项目自有代码的 MIT 许可证。
- `LICENSES/`：随应用携带的项目许可证副本，以及用户可选安装媒体工具的上游许可证说明。
- 用户自行下载的 FFmpeg、FFprobe、ffmpegthumbnailer 不会因被本项目调用、复制或重命名而改变原有许可证。
