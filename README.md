# VideoSweeper 部署教程

## 1. 部署前置条件

目标环境为 Windows x64。打包机器需要安装：

- Node.js 与 npm
- Rust stable MSVC 工具链
- Visual Studio Build Tools，并勾选 Desktop development with C++
- Windows 10/11 SDK
- Microsoft Edge WebView2 Runtime

确认工具链：

```powershell
node --version
npm --version
rustc --version
cargo --version
```

## 2. 准备 npm

使用项目默认 npm 配置安装依赖：

```powershell
npm install
```

若 registry 无法下载 Tauri 依赖，可在本机创建未纳入版本控制的 `.npmrc`，例如：

```ini
registry=https://registry.npmjs.org/
```

## 3. 准备应用图标

Tauri 打包 Windows 应用前必须存在：

```text
src-tauri/icons/icon.ico
```

推荐准备一张至少 `1024 x 1024` 的 PNG 图标，例如 `app-icon.png`，在项目根目录执行：

```powershell
npm run tauri icon app-icon.png
```

该命令会生成 `src-tauri/icons/icon.ico` 及其他平台图标资源。

## 4. 检查 FFmpeg sidecar

发布包会内置 FFmpeg、ffprobe 和 ffmpegthumbnailer。由于这些二进制文件体积较大，仓库仅保留
`sidecars/README.md`，实际 `.exe` 由构建机器自行准备。确认以下文件存在：

```text
sidecars/ffmpeg-x86_64-pc-windows-msvc.exe
sidecars/ffprobe-x86_64-pc-windows-msvc.exe
sidecars/ffmpegthumbnailer-x86_64-pc-windows-msvc.exe
```

它们的文件名必须与当前 Rust target triple 一致。可从受信任的 LGPL FFmpeg 构建和
ffmpegthumbnailer 发布包取得，将文件复制并重命名为上述名称；不要将完整下载目录或 `.exe`
提交到 Git。

## 5. 本地验收

先执行前端构建检查：

```powershell
npm run build
```

启动完整 Tauri 桌面应用进行验收：

```powershell
npm run tauri dev
```

重点确认应用能启动、主题色设置可用、窗口单实例行为正常，以及 FFmpeg sidecar 可被识别。

## 6. 构建 NSIS 安装包

执行：

```powershell
npm run tauri build
```

项目已配置为 NSIS 当前用户安装模式。构建完成后，安装包通常位于：

```text
src-tauri/target/release/bundle/nsis/
```

发布时分发该目录中的 `.exe` 安装程序。

## 7. 安装后验收

在干净的 Windows 用户环境中执行安装程序，并确认：

1. 安装器在所选位置创建 `VideoSweeper` 目录。
2. 应用可以启动，且系统存在 WebView2 Runtime。
3. 应用目录中保留 FFmpeg 和 ffprobe sidecar。
4. 应用可在安装目录旁创建 `data` 目录。
5. 卸载行为符合发布策略：会删除应用目录及其中数据。

## 8. 发布前检查

```powershell
npm run build
npm run tauri build
```

确认没有缺失 `icon.ico`、FFmpeg sidecar、Windows C++ 工具链或 npm 依赖后，再交付 NSIS 安装程序。
