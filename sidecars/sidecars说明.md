# 用户自行安装的媒体工具

此目录在版本控制中只保留说明文件，安装包和 Git 仓库均不包含 FFmpeg、FFprobe 或 ffmpegthumbnailer 二进制文件。用户手动下载后，可将文件放在已安装应用目录的 `sidecars` 子目录：

```text
ffmpeg-x86_64-pc-windows-msvc.exe
ffprobe-x86_64-pc-windows-msvc.exe
ffmpegthumbnailer-x86_64-pc-windows-msvc.exe
```

文件名与当前 Windows x64 运行时约定一致。项目会在应用目录的 `sidecars` 子目录中查找它们；`ffmpegthumbnailer` 可选，缺失时缩略图会回退到 FFmpeg。

请从上游或可信发行方自行取得所需版本，并自行遵守该二进制文件的许可证。可使用项目根目录的 `scripts/install-local-media-tools.ps1` 将已下载文件复制、重命名到此目录；脚本不下载、不打包、也不再分发任何二进制文件。
