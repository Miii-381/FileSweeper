# FileSweeper

FileSweeper 是一个面向 Windows 10/11 的本地文件管理与多格式预览应用。它直接读取真实文件系统，不建立云端账户、媒体库或数据库；项目自有源代码采用 [MIT 许可证](LICENSE)。

## 功能

- 三栏文件管理界面：收藏与目录树、工作区、文件预览与详情。
- 网格和列表虚拟化视图，支持名称搜索、按名称/日期/大小/时长/分辨率排序。
- 按目录记忆排序与文件焦点；后退、前进时恢复网格或列表滚动位置。
- 图片预览：适应窗口、缩放、平移和旋转。
- 文本与代码预览：大文件虚拟滚动、Prism 语法高亮、可配置中英文字体。
- PDF 预览：本地 PDF.js Worker、连续滚动、页码跳转、缩放和适应宽度。
- 音频预览：内嵌封面、播放控制和实时频谱。
- 视频预览：优先直接播放；不兼容时可使用 FFmpeg 转码回退。
- 文件操作：重命名、复制、移动、回收站、系统文件剪贴板、拖入和拖出。
- 深浅色主题、强调色、背景图片、日志查看和诊断导出。

## 系统要求

运行环境：

- Windows 10/11 x64
- Microsoft Edge WebView2 Runtime

从源码构建还需要：

- Node.js 与 npm
- Rust stable MSVC 工具链
- Visual Studio Build Tools（Desktop development with C++）
- Windows 10/11 SDK

## 可选媒体工具

FileSweeper 仓库、安装包和脚本均不包含、下载或镜像 FFmpeg、FFprobe、ffmpegthumbnailer。图片、文本和 PDF 等核心功能不依赖这些工具；视频转码、媒体元数据与部分缩略图功能需要用户自行安装。

请从上游或可信发行方取得二进制，并自行核验来源、哈希及许可证：

- FFmpeg/FFprobe：[FFmpeg Windows 下载说明](https://ffmpeg.org/download.html#build-windows)
- ffmpegthumbnailer（可选）：[上游 Releases](https://github.com/dirkvdb/ffmpegthumbnailer/releases)

将文件放入 FileSweeper 安装目录的 `sidecars` 子目录，并使用以下文件名：

```text
sidecars/
  ffmpeg-x86_64-pc-windows-msvc.exe
  ffprobe-x86_64-pc-windows-msvc.exe
  ffmpegthumbnailer-x86_64-pc-windows-msvc.exe   （可选）
```

文件查找规则与本地安装脚本用法见 [sidecars 说明](sidecars/sidecars说明.md)。

项目提供的安装脚本只复制并重命名用户已经下载的文件：

```powershell
pwsh -File .\scripts\install-local-media-tools.ps1 `
  "C:\Tools\ffmpeg\bin" `
  "$env:LOCALAPPDATA\FileSweeper" `
  "C:\Tools\ffmpegthumbnailer.exe"
```

第三个参数可省略。FFmpeg 构建的许可证取决于其实际配置；启用了 `--enable-gpl` 或 `--enable-nonfree` 的构建不能标注为 LGPL-only。

## 本地开发

```powershell
npm install
npm run check
npm run tauri dev
```

`npm run check` 会依次执行：

- TypeScript 检查与 Vite 生产构建
- Vitest 前端单元测试
- Rustfmt
- Clippy（警告视为错误）
- Rust 单元与回归测试

开发启动器会协调 Vite 与 Tauri 的实际端口；默认端口占用时会自动选择可用端口。

## 构建

项目已包含 Windows 图标，可直接执行：

```powershell
npm run tauri build
```

NSIS 安装包通常生成在：

```text
src-tauri/target/release/bundle/nsis/
```

发布前应确认安装包中不存在 `ffmpeg*.exe`、`ffprobe*.exe` 或 `ffmpegthumbnailer*.exe`。

## 数据与隐私

- 所有文件扫描和预览都在本机完成。
- 本地 HTTP 预览服务仅绑定 `127.0.0.1`。
- 设置、工作区状态、缓存和日志保存在应用同级 `data/` 目录。
- 删除缓存或损坏的索引不会影响原始文件；应用会按需重建。
- FileSweeper 不上传用户文件，也不集成遥测或云端账户。

## 架构

模块边界、状态流、持久化策略和并发模型见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 许可证

- 项目自有代码：[MIT](LICENSE)
- 随应用使用的第三方组件与 PDF.js WASM 声明：`LICENSES/`
- 用户自行安装的媒体工具继续适用其各自许可证
