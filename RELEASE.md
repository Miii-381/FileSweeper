# VideoSweeper 发布清单

## Sidecar 固定清单（2026-07-19）

发布前必须从受信任的发行包重新核验版本、来源和许可证，并对待打包文件计算 SHA-256。不得仅复用开发机缓存。当前仓库校验的 FFmpeg/ffprobe 二进制启用了 `--enable-gpl --enable-version3`，因此发布物必须按 GPLv3 或更高版本履行许可证义务，不能标注为 LGPL 构建。

| 文件 | SHA-256 |
| --- | --- |
| `ffmpeg-x86_64-pc-windows-msvc.exe` | `84FCD000595E14E53570905A006E52F98C91FD5A94268574F558019692150179` |
| `ffprobe-x86_64-pc-windows-msvc.exe` | `85BC494F3E74AF0AC248BB1579E1F58042B7F3AF7525B42F7DAC4231CF7B519F` |
| `ffmpegthumbnailer-x86_64-pc-windows-msvc.exe` | `C29D6A7ACA71499E535D9D6971A000437A0A59B472394819F0D857A37BEC383F` |

`LICENSES` 作为 Tauri bundle resource 随安装包提供；“关于与诊断”中的许可证入口必须能打开该目录。替换 sidecar 时必须同时更新其中的上游来源、许可证文本/获取方式和此表的哈希。

## 签名与安装验收

1. 在隔离 Windows 环境执行 `npm run check`、生成 NSIS 安装包，并对安装器与主程序执行代码签名。
2. 核验签名链、时间戳、版本号、sidecar 哈希和许可证目录。
3. 覆盖默认安装、自定义安装、覆盖升级、卸载、文件占用失败和取消卸载。升级必须保留 `data`；普通卸载必须删除安装目录中的 `data`。
4. 完成 `VALIDATION.md` 的 Explorer、播放器、目录树、DPI/主题和大目录桌面矩阵后，才能标记发布候选。
