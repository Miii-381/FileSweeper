# Sidecar binaries

此目录在版本控制中只保留说明文件。构建或运行 Tauri 桌面程序前，请在本机放入以下 x64 Windows
二进制文件：

```text
ffmpeg-x86_64-pc-windows-msvc.exe
ffprobe-x86_64-pc-windows-msvc.exe
ffmpegthumbnailer-x86_64-pc-windows-msvc.exe
```

文件名必须与 `src-tauri/tauri.conf.json` 的 `externalBin` 和当前 Rust target triple 一致。
请使用兼容许可证的受信任发布包；这些可执行文件以及完整 FFmpeg 下载目录不纳入 Git。
