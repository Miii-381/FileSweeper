# FileSweeper 发布清单

## 用户自行安装的媒体工具

FileSweeper 的 Git 仓库、NSIS 安装包、更新包和本项目脚本均不包含、不下载、不镜像 FFmpeg、FFprobe 或 ffmpegthumbnailer 二进制文件。用户必须自行从上游或可信发行方下载，并对所选构建的许可证负责。

兼容性说明、建议下载地址、文件名和复制方式位于 `README.md`。发布前应检查安装包清单，确认其中没有 `ffmpeg*.exe`、`ffprobe*.exe` 或 `ffmpegthumbnailer*.exe`。

本项目自有源代码使用 MIT 许可证。`LICENSES` 作为 Tauri bundle resource 随安装包提供，其中包含项目许可证以及用户可选安装工具的上游许可证说明；“关于与诊断”中的许可证入口必须能打开该目录。

## 签名与安装验收

1. 在隔离 Windows 环境执行 `npm run check`、生成 NSIS 安装包，并对安装器与主程序执行代码签名。
2. 核验签名链、时间戳、版本号、安装包不含媒体二进制文件，以及许可证目录。
3. 覆盖默认安装、自定义安装、覆盖升级、卸载、文件占用失败和取消卸载。升级必须保留 `data`；普通卸载必须删除安装目录中的 `data`。
4. 完成 `VALIDATION.md` 的 Explorer、播放器、目录树、DPI/主题和大目录桌面矩阵后，才能标记发布候选。
