# FileSweeper 架构

> 最后更新：2026-07-31。本文描述 FileSweeper v1.3 当前实现，不包含历史路线图。

## 1. 系统边界

FileSweeper 是 Windows 本地文件管理与预览应用：

- 真实文件系统是文件状态的唯一权威，不建立媒体库或业务数据库。
- 工作区只枚举当前目录的直接子项；目录树按需加载直接子目录。
- 文件读取、预览、缩略图、缓存和日志均在本机完成。
- 本地预览服务只绑定 `127.0.0.1`。
- FFmpeg、FFprobe 和 ffmpegthumbnailer 由用户自行安装，仓库和安装包不包含这些二进制。

## 2. 技术组成

| 层 | 实现 |
| --- | --- |
| 桌面壳 | Tauri v2、WebView2、Windows NSIS |
| 前端 | React 19、TypeScript、Vite |
| 布局 | `react-resizable-panels` |
| 虚拟化 | `@tanstack/react-virtual` |
| 图片交互 | `react-zoom-pan-pinch` |
| 文本高亮 | PrismJS |
| PDF | PDF.js Worker + 本地 WASM 解码资源 |
| 后端 | Rust、Tauri commands |
| 本地流服务 | Axum、Tower HTTP |
| 文件监听 | `notify` 非递归监听 |
| 持久化 | 原子写入的 JSON 文件 |

项目不使用全局前端状态库、业务 SQLite、云端服务或远程遥测。

## 3. 目录结构

```text
src/
  App.tsx                         应用组合、跨域状态和顶层副作用
  app-types.ts                    前后端传输模型对应的前端类型
  app-utils.ts                    通用格式化、错误和日志工具
  components/                     可复用界面组件
  features/
    navigation/                   标题栏、收藏和目录树
    workspace/                    扫描结果、选择、排序、文件任务和监听
    preview/                      视频、音频、图片、文本、PDF 和详情
    settings/                     偏好、日志与维护界面

src-tauri/src/
  main.rs                         运行时装配、Tauri 注册和共享依赖
  domain.rs                       无状态领域规则与纯函数
  models.rs                       配置、传输和缓存模型
  config_store.rs                 配置与工作区状态存储
  workspace.rs                    目录树和工作区扫描
  file_commands.rs                文件相关 IPC 命令
  file_operations.rs              文件任务线程和复制/移动实现
  windows_shell.rs                Shell、OLE、剪贴板和拖放
  media_commands.rs               媒体相关 IPC 命令
  media_processing.rs             元数据、缩略图和 Sidecar 调度
  media_stream.rs                 本地文件流和转码流
  storage.rs                      缓存、日志路径和原子文件操作
  maintenance_commands.rs         背景、诊断和数据清理
```

`domain.rs` 集中保存扩展名规范化、Windows 文件名校验、路径包含关系、URL 编码、排序键校验和缓存标识等纯逻辑。调用模块直接依赖这些规则，不再建立无行为的单行透传层。

## 4. 前端状态与导航

`App.tsx` 负责组合各功能 Hook，但具体行为按领域拆分：

- `useWorkspaceController`：打开、刷新和断连工作区。
- `useWorkspaceViewState`：搜索、排序、虚拟化、焦点和滚动恢复。
- `useWorkspaceGestures`：多选、框选、自动滚动和文件拖动。
- `useFileTasks`：重命名、回收站、复制、移动和剪贴板。
- `useThumbnailQueue`：可见项缩略图调度与结果覆盖。
- `useMediaMetadata`：选中项与排序所需媒体元数据。
- `useWorkspaceMonitoring`：文件监听、周期校准和外部拖入。

目录切换使用请求代次编号；过期扫描或刷新结果不能覆盖新工作区。导航前按“目录路径 + 视图模式”记录滚动偏移，后退或前进时优先恢复原位置。滚动记忆只属于当前运行会话；排序和文件焦点由设置开关控制是否持久化。

没有保存过排序的工作区默认按名称升序排列；已有工作区排序继续优先。

## 5. 工作区与元数据流

```text
选择目录
  → Rust 扫描直接子项
  → 前端按查询过滤和排序
  → 网格/列表虚拟化渲染
  → 可见卡片按需请求缩略图
```

工作区扫描返回文件种类、时间、大小、预览能力和已有缓存元数据。普通浏览不会预先探测所有媒体；只有选中音视频或按时长、分辨率排序时才补充读取。

后端使用单个非递归监听器监控活动工作区。文件事件在前端合并后触发刷新，并由 30 秒周期校准兜底。可访问性探测发现目录断连时保留路径但停止预览；恢复后重新扫描。

## 6. 预览架构

`PreviewPanel` 根据统一 `DirectoryItem` 模型选择具体预览器：

- 视频：原文件直连 `<video>`；浏览器无法解码时启动 FFmpeg H.264/AAC fragmented MP4 转码。
- 音频：本地流、播放控制、内嵌封面和 Web Audio 实时频谱。
- 图片：本地短 URL、适应窗口、缩放、平移和旋转。
- 文本/代码：完整文件读取、编码识别、虚拟滚动和按需 Prism 主题。
- PDF：独立 PDF.js Worker、本地 WASM、页面虚拟化、密码会话和最多两页并发渲染。

PDF 适应宽度不受手动缩放下限限制；页面宽于预览栏时会按真实可用宽度缩小并完整显示。手动缩放仍限制在 25%–400%。

所有预览会话以文件路径作为生命周期边界。切换文件时取消旧加载、渲染、媒体请求或 Worker，避免过期结果回写。

## 7. 文件操作与 Windows Shell

复制、移动、重命名和回收站操作进入专用文件任务线程：

- 任务具有 ID、状态、逐项目结果和取消标记。
- 复制先写临时目标，校验长度后以不覆盖方式提交。
- 移动只在目标提交成功后删除源文件；失败时保留或回滚目标。
- 同名目标使用递增名称，不覆盖用户文件。

系统文件剪贴板使用独立 STA/OLE 线程，发布 Shell `IDataObject` 并持续消息循环，使 Explorer 可以跨进程读取。应用内拖出使用 Shell 数据对象和 `DoDragDrop`，只协商复制效果。

普通权限 Explorer 无法向管理员权限应用拖入文件，这是 Windows UIPI 限制；启动时会检测并提示。

## 8. 媒体后台与缓存

`ffprobe`、`ffmpegthumbnailer` 和缩略图 FFmpeg 回退共享可调的 Sidecar 许可池。播放器实时转码、文件操作、OLE 和剪贴板线程不进入该池。

前端维护 FIFO 逻辑队列；滚动期间只暂停发现新任务，不取消已排队或运行中的任务。视频缩略图优先使用 ffmpegthumbnailer，失败后回退 FFmpeg；图片和音频封面使用各自处理路径。

媒体缓存索引保存在 `data/thumbnails/index.json`，源文件指纹包含规范化路径、大小和修改时间。缩略图与元数据条目相互独立；删除索引不会影响原文件。

## 9. 持久化与恢复

应用数据目录位于可执行文件同级 `data/`：

```text
data/
  config.json                    设置、收藏和最后工作区
  workspace-state.json           各工作区排序与文件焦点
  thumbnails/                    JPEG 与版本化媒体缓存索引
  backgrounds/                   导入的受管背景
  logs/                          文件日志
  backups/                       损坏配置或索引备份
```

配置和工作区状态由单一 `ConfigStore` 持有，但写入不同文件。所有 JSON 先写唯一临时文件并刷新，再使用 Windows `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` 原子替换。损坏文件会备份并以默认值或可重建状态恢复。

背景图片复制到受管目录后通过短的本地协议 URL 提供，避免大型 Data URL 的长度和内存问题。

## 10. 日志、诊断与验证

前端行为通过 Tauri 日志插件写入文件与控制台；日志面板按文件哈希轮询，只在内容变化时更新。诊断导出包含配置摘要、日志尾部、版本和 Sidecar 探测信息，不包含用户文件内容。

统一验证入口：

```powershell
npm run check
```

该命令覆盖 TypeScript、Vite 构建、Vitest、Rustfmt、Clippy 和 Rust 测试。发布前还需要在真实 Windows 桌面环境验证：

- 安装、卸载和 WebView2 启动
- Explorer 拖入、拖出和系统剪贴板
- 大目录滚动与导航位置恢复
- 音视频直连与转码回退
- 图片、文本和 PDF 的极窄预览栏布局
- 无媒体 Sidecar 时的降级提示

## 11. 维护原则

1. 文件系统是权威状态，缓存必须可删除、可重建。
2. 异步结果必须具备会话或请求代次边界。
3. 纯领域规则集中复用；没有额外行为的透传函数直接删除。
4. 只在多个调用方具有稳定且相同语义时抽象，避免把相似 JSX 强行包装为条件组件。
5. 用户文件操作优先保证不覆盖、可回收和失败后状态可解释。
