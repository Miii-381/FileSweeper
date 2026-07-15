# VideoSweeper 架构设计文档

> 开发状态标记（2026-07-15）：`✅` 已实现，`🟡` 部分实现或仅有占位，`⬜` 未实现。

## 项目概述

一个基于 Tauri v2 的本地视频管理软件，支持缩略图网格浏览、悬浮预览播放、批量文件操作。目标平台：Windows only。

---

## 技术栈

| 层级 | 技术 | 备注 | 状态 |
| :--- | :--- | :--- | :--- |
| 框架 | Tauri v2 (Rust + WebView2) | NSIS 安装器，支持用户自定义安装路径 | ✅ |
| 前端 | React 19 + Vite + TypeScript | 生态丰富，组件库最多 | ✅ |
| UI 组件库 | shadcn/ui + Tailwind CSS v4 | 暗色模式开箱即用 | 🟡 Tailwind 已接入，未使用 shadcn/ui 组件 |
| 布局面板 | `react-resizable-panels` | Vercel 维护，和 shadcn/ui 同生态 | ✅ 三栏宽度调整与本地持久化 |
| 虚拟滚动 | `@tanstack/react-virtual` | 万级缩略图不卡顿 | ✅ 网格和列表仅挂载可见行及少量缓冲项 |
| 状态管理 | Zustand（多 store 拆分） | 按领域拆分，精确 selector 避免不必要渲染 | ⬜ |
| 数据库 | SQLite (tauri-plugin-sql) | 存储视频元数据、缩略图路径、文件夹配置 | 🟡 插件已注册；缩略图目前采用内存 JSON 索引，尚未建立 SQLite 数据模型 |
| 缩略图 | `ffmpegthumbnailer` + FFmpeg/FFprobe sidecar | 480px JPEG、缓存索引、视口批处理和兼容回退 | ✅ |
| 视频流 | 内嵌本地 HTTP 服务器 | `127.0.0.1` 限制、Range/HEAD 请求与自建播放器控件 | ✅ |
| 文件监听 | tauri-plugin-fs watch | 当前工作区 300ms 防抖 → 保留交互状态的目录刷新 | ✅ |
| 样式方案 | Tailwind CSS + CSS Variables | 主题切换用 CSS 变量 | ✅ 语义 CSS 变量由主题配置统一注入 |

---

## UI 布局

VSCode 风格三栏布局，左、中、右栏可拖拽调整宽度（高度调整尚未实现）：

```
┌───────────┬────────────────────────┬──────────────┐
│           │  Toolbar               │              │
│  目录树   │  (搜索/排序/视图切换)    │  视频预览窗   │
│  ───────  │  ────────────────────  │  (可折叠)    │
│  收藏区   │                        │  ┌────────┐  │
│  ★ 电影   │  缩略图网格            │  │ <video>│  │
│  ★ 素材   │  ┌──┐ ┌──┐ ┌──┐ ┌──┐ │  │  播放器 │  │
│  ───────  │  │  │ │  │ │  │ │  │ │  └────────┘  │
│  目录树   │  └──┘ └──┘ └──┘ └──┘ │  ┌────────┐  │
│  📁 C:\  │  ┌──┐ ┌──┐ ┌──┐       │  │ 文件信息│  │
│  📁 D:\  │  │  │ │  │ │  │       │  │ 时长/分辨率│ │
│           │  └──┘ └──┘ └──┘       │  │ 大小/编码 │  │
│           │                        │  └────────┘  │
└───────────┴────────────────────────┴──────────────┘
```

- **左栏**：收藏区（用户手动添加，持久化）+ 目录树（实时文件系统导航），焦点机制控制工作区显示 `✅`
- **中栏**：网格/列表视图 + 顶部工具栏（搜索、排序、视图切换） `✅`；真实缩略图、索引缓存、按视口生成和虚拟滚动已完成
- **右栏**：文件信息与可折叠面板 `✅`；选中后先显示缩略图，视频可播放时再替换为内嵌播放器

---

## 文件夹管理模型

### 双区导航

- **收藏区**：用户手动添加的文件夹，当前持久化到 `config.json`，用于快速切换常用目录 `✅`；SQLite 存储尚未实现
- **目录树区**：真实文件系统树，直接子目录懒加载并可临时导航 `✅`
- **焦点机制**：点击哪个节点，工作区就显示该目录的内容；目录树里点击 = 临时切换（不加入收藏） `✅`

### 多文件夹独立维护

每个文件夹独立维护缩略图缓存和元数据。v1.1 可考虑聚合视图。

---

## 交互模型

### 选中与预览

- **选中**：点击缩略图 = 选中（Ctrl+Click 追加/取消、Shift+Click 范围选中） `✅`
- **取消选中**：点击网格、虚拟列表的未占用区域或空工作区会清空选择；文件项、列表列头不触发清空 `✅`
- **预览**：最后选中视频会显示在右栏信息区，并在稳定选中 250ms 后请求内嵌流 `✅`
- **预览窗**：右侧可调宽、可折叠；上部提供播放、进度、音量、静音、速率与全屏控制；音量和静音状态持久化 `✅`
- **键盘导航**：上下方向键切换当前可见项，`Ctrl+A` 全选，工作区空格切换当前项；播放器焦点下空格播放/暂停 `✅`

### 批量操作（v0.1 MVP）

| 操作 | 方式 | 实现 | 状态 |
| :--- | :--- | :--- | :--- |
| 增 | 拖入文件到工作区（自动复制） | Webview 原生 `onDragDropEvent`（`CF_HDROP`）→ 单 STA `IFileOperation`，临时文件校验后改名 | ✅；源/目标须同一 Windows 完整性级别 |
| 删 | Delete 键 / 原生右键菜单 → 移动到回收站 | Windows `IFileOperation` 单 STA 队列 | ✅ |
| 改 | F2 重命名 | 卡片/列表名称原位输入 → Tauri command → 单 STA `IFileOperation` | ✅；Enter/失焦提交，Escape 取消 |
| 查 | 文件名实时搜索 | 当前目录前端不区分大小写 filter | ✅；SQLite LIKE 尚未实现 |

### 高级交互（v0.2+）

- **拖出**：从工作区拖文件到 Windows 资源管理器（`window.start_dragging()`）
- **框选**：在空白区域拖拽画矩形框批量选中
- **Ctrl+C/X/V**：系统剪贴板操作

---

## 视频播放架构

### 数据通路

```
源文件 (D:\Videos\demo.mp4)
    │
    ▼
Rust 端本地 HTTP 服务器 (localhost:随机端口)
    │  完整 Range 请求支持
    │  Content-Type: video/mp4
    ▼
前端 <video src="http://localhost:XXXXX/file?path=...">
    │  原生进度条拖拽
    │  自建播放控件 (~100行 TSX)
    ▼
用户看到流畅播放
```

### 格式支持路线

```
v0.1 MVP:
  H.264 MP4 / WebM (VP8/VP9) → 直接 serve 原文件，完整 Seek
  其他格式 → 静默调用 PotPlayer 外部播放

v0.2 (1-2 周后):
  FFmpeg 实时转码（任意格式 → H.264 流，仅从头播放，不可 Seek）
  开发量：~125 行 Rust

v1.0 (验证方向后):
  FFmpeg 实时转码 + Seek 支持
  方案：固定关键帧跳转（-g 30 GOP + -ss 在 -i 前）
  误差 ≤1 秒，规避 VBR 码率波动带来的字节→时间映射问题
  Seek 交互策略：
    - 拖拽进度条：拖拽过程中不触发 seek，仅更新 UI 时间预览；
      mouseup 时取最终位置 -ss spawn 新 FFmpeg
    - 点击进度条：100ms 防抖，只执行最后一次点击目标
    - 单视频单进程：新进程启动前 abort 旧进程，避免并发转码
  开发量：额外 ~305 行 Rust
```

---

## 缩略图系统

### 规格

| 参数 | 值 |
| :--- | :--- |
| 显示尺寸 | 卡片以 480×270 (16:9) 区域显示 |
| 输出格式 | JPEG；`ffmpegthumbnailer` 使用 quality 7/10，FFmpeg 回退使用 `q:v 7` |
| 截图时间点 | 可选开头、前段、中点、后段、结尾；默认中点（50%）。开头快速模式固定 1s，不启动 `ffprobe` |
| 存储位置 | exe 同级 `./data/thumbnails/{file_hash}.jpg`，索引为 `./data/thumbnails/thumbnail-index.json` |

### 生成策略

- **目录进入**：加载格式化 JSON 索引到内存。目录扫描只检查文件大小、修改时间、取帧配置和索引项，不扫描整个缩略图目录。
- **稳定视口生成**：卡片进入视口后加入队列；滚动期间不派发新任务，停止滚动 180ms 后只处理最终视口的卡片。已启动任务允许完成，尚未开始的任务丢弃。
- **批处理与并发**：前端一次最多提交 10 个路径；后端任务许可池上限为 10。每张 JPEG 完成后立即通过事件更新前端，批次结束后才原子写入一次 JSON 索引。
- **缓存读取**：JPEG 读取、Base64 编码与 IPC 返回使用独立许可池，最多 4 项并发，避免缓存命中时挤占解码、磁盘与主界面资源。
- **虚拟渲染**：网格按固定高度行虚拟化，列表按固定高度项目虚拟化；仅挂载可见区域及缓冲项。网格列数由容器宽度通过 `ResizeObserver` 自适应计算。
- **生成器与回退**：优先调用 `ffmpegthumbnailer`，其失败或未输出 JPEG 时，回退至 `ffprobe` 计算时长并由 FFmpeg 取帧，兼容 HEVC/MKV 等失败场景。
- **缓存复用**：索引键使用规范化文件路径，校验文件大小、修改时间和取帧配置；命中后直接返回缓存 JPEG。JPEG 文件名由路径哈希生成。

### 当前持久化策略

- 当前采用便携模式：数据目录固定在可执行文件同级 `./data/`。
- `thumbnail-index.json` 通过 `serde_json::to_vec_pretty` 格式化写入，并在 Windows 上使用 `MoveFileExW` 原子替换。
- 缓存索引现阶段使用 JSON 而非 SQLite，避免缩略图缓存问题未稳定前引入额外数据模型和迁移成本；时长、分辨率通过用户切换列表或排序时按批调用 `ffprobe` 读取，SQLite 仅保留给后续复杂检索。

---

## 状态管理

### Zustand Store 拆分

| Store | 职责 | 变化频率 |
| :--- | :--- | :--- |
| `navStore` | 当前焦点文件夹、收藏列表、目录树展开状态 | 低 |
| `videoStore` | 当前文件夹下的视频数组、排序方式、视图模式 | 中 |
| `selectionStore` | 选中视频 ID 集合、最后选中项（驱动预览窗） | 高 |
| `previewStore` | 预览窗折叠状态、播放器音量/速率 | 低—中 |
| `taskStore` | 正在进行中的复制/删除任务队列和进度 | 极低 |

原则：变化频率不同的状态绝不放在同一个 store，避免不必要渲染。

---

## 数据库 Schema

### 核心表（v0.1 MVP）

```sql
-- 文件夹/库
CREATE TABLE folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_favorite INTEGER DEFAULT 1,   -- 收藏区=1, 临时目录树=0
    added_at TEXT DEFAULT (datetime('now'))
);

-- 视频文件
CREATE TABLE videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    file_size INTEGER,
    duration REAL,                   -- 秒
    width INTEGER,
    height INTEGER,
    thumbnail_path TEXT,
    created_at TEXT,
    modified_at TEXT,
    FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
);

CREATE INDEX idx_videos_folder ON videos(folder_id);
CREATE INDEX idx_videos_name ON videos(file_name);
```

### 扩展：用户自定义元数据列（v0.2）

```sql
CREATE TABLE custom_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    field_type TEXT NOT NULL DEFAULT 'text'  -- text, number, date, tags
);

CREATE TABLE video_custom_values (
    video_id INTEGER NOT NULL,
    field_id INTEGER NOT NULL,
    value TEXT,
    PRIMARY KEY (video_id, field_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (field_id) REFERENCES custom_fields(id) ON DELETE CASCADE
);
```

---

## Rust 后端架构

### 模块结构

```
src-tauri/src/
  main.rs              // Tauri entry, 注册 commands + 注入 state
  commands/
    mod.rs
    folder.rs          // 文件夹扫描、增删、目录树构建
    video.rs           // 视频元数据、ffprobe 调用
    thumbnail.rs       // 缩略图生成、缓存管理
    stream.rs          // HTTP 视频流服务生命周期管理
    file_ops.rs        // 复制、移动、删除、拖入处理
    fs_watch.rs        // 文件监听启动/停止 + 300ms 防抖
  db/
    mod.rs
    models.rs          // SQLite 表结构定义
    queries.rs         // CRUD 操作封装
  stream/
    mod.rs             // 本地 HTTP 服务器 (warp/tiny_http)
    range.rs           // HTTP Range 请求解析 + 206 响应构造
  state.rs             // AppState { db_pool, stream_handle, config, thumbnail_cache_dir }
  error.rs             // 统一错误类型 AppError
```

### 统一错误处理

```rust
#[derive(Debug, Serialize)]
pub enum AppError {
    FileNotFound(String),
    PermissionDenied(String),
    FfmpegError(String),
    DatabaseError(String),
    StreamError(String),
    InvalidPath(String),
    IoError(String),
}

// 实现 Into<tauri::InvokeError>，自动序列化为 JSON
// 前端统一接收 { code: "FILE_NOT_FOUND", message: "..." }
```

### 错误展示策略

| 级别 | 方式 |
| :--- | :--- |
| 致命错误（启动时） | 模态对话框 → 应用退出 |
| 非致命操作错误 | Toast 通知（右上角，3 秒消失） |
| 批量操作部分失败 | Toast 摘要 + 可展开详情 |
| 预览/播放失败 | 预览窗内错误占位（图标 + 原因） |
| 原始文件操作 | 只读/非破坏性，写入类必须有明确用户意图 |

---

## 文件监听

- 使用 `tauri-plugin-fs` 对当前工作区建立非递归 `watch`；后端列目录成功后，仅将该目录加入 Webview 文件访问 scope。
- 300ms 防抖计时器：收到变更事件 → 重置计时器 → 到期后重新枚举直接子项 → 合并到前端工作区状态。
- 刷新按路径复用已探测的时长/分辨率，保留搜索、排序、视图与仍存在的选择；删除的路径自动移出选择。
- 拖入复制、重命名与资源管理器外部改动均走同一刷新函数。
- Windows 原生拖放接收器在 Webview 创建时注册；`dragDropEnabled` 修改不能依赖前端热重载，必须重启完整 Tauri 进程。应用以管理员权限运行时，普通资源管理器会被 UIPI 拒绝拖入。
- 批量操作（50 个文件粘贴）自动合并为 1 次 IPC

---

## 开发路线图

### v0.1-MVP（核心体验闭环）

采用**垂直切片**方式推进，每个切片产出可演示成果，未实现部分用占位符填充。

| 切片 | 内容 | 产出 | 状态 |
| :--- | :--- | :--- | :--- |
| 1 | Tauri 脚手架 + 三栏布局壳子 + shadcn/ui 配置 | 可运行的空壳应用 | 🟡 三栏与主题已完成，未使用 shadcn/ui |
| 2 | 文件夹扫描 → 缩略图网格（真实 Rust 数据 + react-virtual） | 看到缩略图网格 | ✅ 真实目录扫描、缩略图缓存、视口生成与虚拟滚动已完成 |
| 3 | 点击选中 → 预览窗原生播放 + 自建播放控件 + 进度条 | 视频可预览 | ✅ 先展示缩略图和信息，再加载本地流播放器 |
| 4 | 目录树导航 + 收藏区 | 文件夹可管理 | ✅ |
| 5 | F2 重命名 + Delete 回收站 + 拖入复制 | 文件可操作 | ✅ 写入操作均经单 STA 队列；复制使用临时文件校验与原子改名 |
| 6 | 文件名搜索 + 排序 + 视图切换(网格/列表) | 基本筛选能力 | ✅ 支持名称、日期、大小、时长、分辨率排序；列表或媒体排序时按需探测并统一刷新 |

### v0.2-增强

- FFmpeg 实时转码（任意格式 → H.264 流，仅从头播放）
- 右键菜单（资源管理器打开、复制到...） `🟡` 已实现打开、定位和回收站删除；复制到尚未实现
- 框选（鼠标拖拽矩形批量选中）
- 拖出（start_dragging API，从工作区拖到外部）
- 文件监听自动刷新 `✅ 已提前在 v0.1 补齐当前工作区刷新`
- 外部格式调用 PotPlayer

### v0.3-完善

- FFmpeg 实时转码 + Seek（固定关键帧跳转，GOP=30，误差 ≤1s）
- 用户自定义元数据列
- Ctrl+C/X/V 系统剪贴板
- 排序规则完善（按名称/日期/大小/时长）

### v1.0-打磨

- 自定义标签系统
- 文件哈希去重（MD5/SHA256）
- 安装包/便携包双模式构建
- 性能优化和边缘情况修复

---

## 未解决问题（待定）

1. ~~本地流服务框架选型~~ `✅` 已采用 `axum + tower-http::ServeFile`，仅绑定 `127.0.0.1`，由库实现 Range/HEAD 响应。
2. ~~Windows 回收站操作 — 优先试用 PowerShell `Remove-Item` fallback，后续评估 `IFileOperation` binding 的必要性~~ `✅` 已采用 `IFileOperation`
3. `react-resizable-panels` 嵌套拖拽在 Tauri WebView2 下的性能 — 需要实测

---

*最后更新: 2026-07-03*
