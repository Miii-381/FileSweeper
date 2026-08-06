import { ArrowDown, ArrowUp, Monitor, Moon, Plus, Sun, X } from "lucide-react";
import { useState } from "react";

import { listColumnLabels, type AboutInfo, type CodeTheme, type DataManagementSummary, type ListColumn, type ListColumnId, type Preferences, type SettingsLimits, type ThumbnailCapturePosition } from "../../app-types";
import { formatBytes, writeClientLog } from "../../app-utils";
import { themePresets } from "../../theme";

const codeThemeOptions: Array<{ id: CodeTheme; name: string }> = [
  { id: "tomorrow", name: "Tomorrow Night" },
  { id: "default", name: "默认（浅色）" },
  { id: "dark", name: "Prism Dark" },
  { id: "funky", name: "Funky" },
  { id: "okaidia", name: "Okaidia" },
  { id: "twilight", name: "Twilight" },
  { id: "coy", name: "Coy" },
  { id: "solarizedlight", name: "Solarized Light" },
];

export function SettingsDialog({
  settings,
  limits,
  onApply,
  onClose,
  onNotify,
  onChooseBackground,
  onImportBackground,
  dataSummary,
  aboutInfo,
  onClearThumbnails,
  onClearOldLogs,
  onOpenPath,
  onExportDiagnostics,
}: {
  settings: Preferences;
  limits: SettingsLimits;
  onApply: (settings: Preferences) => Promise<boolean>;
  onClose: () => void;
  onNotify: (message: string) => void;
  onChooseBackground: () => Promise<string | null>;
  onImportBackground: (sourcePath: string) => Promise<string>;
  dataSummary: DataManagementSummary | null;
  aboutInfo: AboutInfo | null;
  onClearThumbnails: () => Promise<void>;
  onClearOldLogs: () => Promise<void>;
  onOpenPath: (path: string) => Promise<void>;
  onExportDiagnostics: () => Promise<void>;
}) {
  const [settingsDraft, setSettingsDraft] = useState<Preferences>(() => ({
    ...settings,
    videoExtensions: [...settings.videoExtensions],
    audioExtensions: [...settings.audioExtensions],
    managedVideoExtensions: [...settings.managedVideoExtensions],
    imageExtensions: [...settings.imageExtensions],
    textExtensions: [...settings.textExtensions],
    textLanguageMap: { ...settings.textLanguageMap },
    listColumns: settings.listColumns.map((column) => ({ ...column })),
  }));
  const [newVideoExtension, setNewVideoExtension] = useState("");
  const [backgroundSource, setBackgroundSource] = useState<string | null>(null);
  const settingsDirty = JSON.stringify(settingsDraft) !== JSON.stringify(settings) || backgroundSource !== null;

  const closeSettings = () => {
    if (settingsDirty && !window.confirm("偏好设置尚未应用，确定放弃这些改动吗？")) {
      writeClientLog("debug", "关闭偏好设置被取消：继续编辑未应用内容");
      return;
    }
    writeClientLog("info", settingsDirty ? "关闭偏好设置并放弃未应用内容" : "关闭偏好设置");
    onClose();
  };
  const normalizeVideoExtension = (value: string) => {
    const extension = value.trim().toLocaleLowerCase();
    if (!extension || /[\\/:*?"<>|\s]/.test(extension)) {
      return null;
    }
    return extension.startsWith(".") ? extension : `.${extension}`;
  };
  const toggleVideoExtension = (extension: string) => {
    setSettingsDraft((draft) => {
      const enabled = draft.videoExtensions.includes(extension);
      if (enabled && draft.videoExtensions.length === 1) {
        onNotify("至少保留一种已启用的视频格式");
        writeClientLog("warn", `视频扩展名切换被拒绝：${extension} 是最后一种已启用格式`);
        return draft;
      }
      writeClientLog("debug", `${enabled ? "禁用" : "启用"}视频扩展名：${extension}`);
      return {
        ...draft,
        videoExtensions: enabled
          ? draft.videoExtensions.filter((item) => item !== extension)
          : [...draft.videoExtensions, extension].sort(),
      };
    });
  };
  const addVideoExtension = () => {
    const extension = normalizeVideoExtension(newVideoExtension);
    if (!extension) {
      onNotify("请输入有效的扩展名，例如 .mp4");
      writeClientLog("warn", `添加视频扩展名被拒绝：输入“${newVideoExtension}”无效`);
      return;
    }
    setSettingsDraft((draft) => ({
      ...draft,
      managedVideoExtensions: draft.managedVideoExtensions.includes(extension)
        ? draft.managedVideoExtensions
        : [...draft.managedVideoExtensions, extension].sort(),
      videoExtensions: draft.videoExtensions.includes(extension)
        ? draft.videoExtensions
        : [...draft.videoExtensions, extension].sort(),
    }));
    writeClientLog("info", `添加并启用视频扩展名：${extension}`);
    setNewVideoExtension("");
  };
  const removeVideoExtension = (extension: string) => {
    setSettingsDraft((draft) => {
      const enabled = draft.videoExtensions.includes(extension);
      if (enabled && draft.videoExtensions.length === 1) {
        onNotify("至少保留一种已启用的视频格式");
        writeClientLog("warn", `删除视频扩展名被拒绝：${extension} 是最后一种已启用格式`);
        return draft;
      }
      writeClientLog("info", `删除视频扩展名：${extension}，删除前启用 ${enabled}`);
      return {
        ...draft,
        managedVideoExtensions: draft.managedVideoExtensions.filter((item) => item !== extension),
        videoExtensions: draft.videoExtensions.filter((item) => item !== extension),
      };
    });
  };
  const updateListColumn = (columnId: ListColumnId, update: Partial<ListColumn>) => {
    setSettingsDraft((draft) => ({
      ...draft,
      listColumns: draft.listColumns.map((column) => column.id === columnId ? { ...column, ...update } : column),
    }));
  };
  const moveListColumn = (index: number, direction: -1 | 1) => {
    setSettingsDraft((draft) => {
      const targetIndex = index + direction;
      if (index === 0 || targetIndex < 1 || targetIndex >= draft.listColumns.length) {
        return draft;
      }
      const nextColumns = [...draft.listColumns];
      [nextColumns[index], nextColumns[targetIndex]] = [nextColumns[targetIndex], nextColumns[index]];
      return { ...draft, listColumns: nextColumns };
    });
  };
  const applySettings = async () => {
    writeClientLog("info", `设置对话框请求应用草稿：修改 ${settingsDirty}`);
    const nextSettings = { ...settingsDraft };
    if (backgroundSource) {
      try {
        nextSettings.backgroundImage = await onImportBackground(backgroundSource);
      } catch (error) {
        onNotify(`导入背景图失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    }
    if (await onApply(nextSettings)) {
      writeClientLog("info", "设置对话框草稿应用成功，准备关闭");
      onClose();
    } else {
      writeClientLog("error", "设置对话框草稿应用失败，保留当前编辑内容");
    }
  };

  return (
        <div className="settings-backdrop" role="presentation" onMouseDown={closeSettings}>
          <section
            className="settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="settings-header">
              <div>
                <span>偏好设置</span>
                <h2 id="settings-title">应用与工作区</h2>
              </div>
              <button className="quiet-icon-button" type="button" aria-label="关闭偏好设置" title="关闭" onClick={closeSettings}>
                <X size={18} />
              </button>
            </header>

            <div className="settings-body">
              <details className="settings-section" open>
                <summary>外观、背景与预览</summary>
                <div className="setting-row">
                  <span>显示模式</span>
                  <div className="appearance-switch" role="radiogroup" aria-label="显示模式">
                    <button
                      className={settingsDraft.appearance === "system" ? "active" : ""}
                      type="button"
                      aria-label="跟随系统"
                      title="跟随系统"
                      onClick={() => setSettingsDraft((draft) => ({ ...draft, appearance: "system" }))}
                    >
                      <Monitor size={16} />
                    </button>
                    <button
                      className={settingsDraft.appearance === "dark" ? "active" : ""}
                      type="button"
                      aria-label="深色模式"
                      title="深色模式"
                      onClick={() => setSettingsDraft((draft) => ({ ...draft, appearance: "dark" }))}
                    >
                      <Moon size={16} />
                    </button>
                    <button
                      className={settingsDraft.appearance === "light" ? "active" : ""}
                      type="button"
                      aria-label="浅色模式"
                      title="浅色模式"
                      onClick={() => setSettingsDraft((draft) => ({ ...draft, appearance: "light" }))}
                    >
                      <Sun size={16} />
                    </button>
                  </div>
                </div>
                <div className="setting-row">
                  <span>主题色</span>
                  <div className="theme-swatch-grid" aria-label="主题色">
                    {themePresets.map((theme) => (
                      <button
                        className={`theme-swatch ${settingsDraft.accentTheme === theme.id ? "selected" : ""}`}
                        type="button"
                        key={theme.id}
                        aria-label={theme.name}
                        title={theme.name}
                        style={{ backgroundColor: theme.color }}
                        onClick={() => setSettingsDraft((draft) => ({ ...draft, accentTheme: theme.id }))}
                      />
                    ))}
                  </div>
                </div>
                <label className="setting-row">
                  <span>代码配色</span>
                  <select
                    className="thumbnail-position-select"
                    aria-label="代码配色主题"
                    value={settingsDraft.codeTheme}
                    onChange={(event) => setSettingsDraft((draft) => ({ ...draft, codeTheme: event.target.value as CodeTheme }))}
                  >
                    {codeThemeOptions.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
                  </select>
                </label>
                <div className="setting-row extension-setting">
                  <span>文本预览字体</span>
                  <div className="text-preview-font-inputs">
                    <label>
                      <span>英文</span>
                      <input
                        className="extension-input"
                        aria-label="文本预览英文字体"
                        value={settingsDraft.textPreviewLatinFont}
                        placeholder="Consolas"
                        onChange={(event) => setSettingsDraft((draft) => ({ ...draft, textPreviewLatinFont: event.target.value }))}
                      />
                    </label>
                    <label>
                      <span>中文</span>
                      <input
                        className="extension-input"
                        aria-label="文本预览中文字体"
                        value={settingsDraft.textPreviewCjkFont}
                        placeholder="Microsoft YaHei"
                        onChange={(event) => setSettingsDraft((draft) => ({ ...draft, textPreviewCjkFont: event.target.value }))}
                      />
                    </label>
                  </div>
                </div>
                <div className="setting-row extension-setting">
                  <span>全局背景图</span>
                  <div className="background-setting-actions">
                    <span className="background-name">{backgroundSource ?? settingsDraft.backgroundImage ?? "未设置"}</span>
                    <button type="button" className="command-button" onClick={() => void onChooseBackground().then((path) => {
                      if (path) setBackgroundSource(path);
                    })}>选择图片</button>
                    {(backgroundSource || settingsDraft.backgroundImage) && <button type="button" className="command-button" onClick={() => {
                      setBackgroundSource(null);
                      setSettingsDraft((draft) => ({ ...draft, backgroundImage: null }));
                    }}>移除</button>}
                  </div>
                </div>
                <label className="setting-row">
                  <span>图片大小上限</span>
                  <span className="number-input"><input type="number" min="1" max="512" value={settingsDraft.imageMaxMegabytes} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, imageMaxMegabytes: Number(event.target.value) }))} /><em>MiB</em></span>
                </label>
                <label className="setting-row">
                  <span>图片像素上限</span>
                  <span className="number-input"><input type="number" min="1" max="500" value={settingsDraft.imageMaxMegapixels} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, imageMaxMegapixels: Number(event.target.value) }))} /><em>MP</em></span>
                </label>
                <label className="setting-row">
                  <span>背景图不透明度</span>
                  <span className="opacity-input">
                    <input type="range" min="0" max="100" value={settingsDraft.backgroundOpacity} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, backgroundOpacity: Number(event.target.value) }))} />
                    <output>{settingsDraft.backgroundOpacity}%</output>
                  </span>
                </label>
                <label className="setting-row">
                  <span>背景毛玻璃</span>
                  <span className="opacity-input">
                    <input type="range" min="0" max="100" value={settingsDraft.backgroundBlur} onChange={(event) => setSettingsDraft((draft) => ({ ...draft, backgroundBlur: Number(event.target.value) }))} />
                    <output>{settingsDraft.backgroundBlur === 0 ? "关闭" : `${settingsDraft.backgroundBlur}%`}</output>
                  </span>
                </label>
              </details>

              <details className="settings-section">
                <summary>媒体、格式与性能</summary>
                <label className="setting-row">
                  <span>缩略图缓存上限</span>
                  <span className="number-input">
                    <input
                      type="number"
                      min="256"
                      max="102400"
                      step="256"
                      value={Math.round(settingsDraft.thumbnailCacheGb * 1024)}
                      onChange={(event) =>
                        setSettingsDraft((draft) => ({
                          ...draft,
                          thumbnailCacheGb: Number(event.target.value) / 1024,
                        }))
                      }
                    />
                    <em>MB</em>
                  </span>
                </label>
                <label className="setting-row">
                  <span>缩略图取帧位置</span>
                  <select
                    className="thumbnail-position-select"
                    value={settingsDraft.thumbnailCapturePosition}
                    onChange={(event) =>
                      setSettingsDraft((draft) => ({
                        ...draft,
                        thumbnailCapturePosition: event.target.value as ThumbnailCapturePosition,
                      }))
                    }
                  >
                    <option value="opening">开头 1 秒（快速）</option>
                    <option value="early">前段 25%</option>
                    <option value="middle">正中 50%</option>
                    <option value="late">后段 75%</option>
                    <option value="ending">结尾 90%</option>
                  </select>
                </label>
                <label className="setting-row">
                  <span>后台媒体处理并发数</span>
                  <span className="number-input">
                    <input
                      type="number"
                      min={limits.backgroundSidecarConcurrencyMin}
                      max={limits.backgroundSidecarConcurrencyMax}
                      step="1"
                      value={settingsDraft.backgroundSidecarConcurrency}
                      onChange={(event) =>
                        setSettingsDraft((draft) => ({
                          ...draft,
                          backgroundSidecarConcurrency: Number(event.target.value),
                        }))
                      }
                    />
                    <em>个</em>
                  </span>
                </label>
                <label className="setting-row">
                  <span>默认音量</span>
                  <span className="opacity-input">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={settingsDraft.volume}
                      onChange={(event) => setSettingsDraft((draft) => ({ ...draft, volume: Number(event.target.value) }))}
                    />
                    <output>{settingsDraft.volume}%</output>
                  </span>
                </label>
                <div className="setting-row extension-setting">
                  <span>支持的视频格式</span>
                  <div className="extension-manager">
                    <div className="extension-add">
                      <input
                        className="extension-input"
                        type="text"
                        value={newVideoExtension}
                        placeholder="例如 .mp4"
                        aria-label="添加视频扩展名"
                        onChange={(event) => setNewVideoExtension(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addVideoExtension();
                          }
                        }}
                      />
                      <button type="button" className="extension-add-button" onClick={addVideoExtension}>
                        <Plus size={14} />
                        添加
                      </button>
                    </div>
                    <ul className="extension-list" aria-label="视频格式列表">
                      {settingsDraft.managedVideoExtensions.map((extension) => {
                        const enabled = settingsDraft.videoExtensions.includes(extension);
                        return (
                          <li key={extension}>
                            <label>
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={() => toggleVideoExtension(extension)}
                              />
                              <span>{extension}</span>
                            </label>
                            <button
                              type="button"
                              className="quiet-icon-button"
                              aria-label={`删除 ${extension}`}
                              title="删除格式"
                              onClick={() => removeVideoExtension(extension)}
                            >
                              <X size={14} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
                <label className="setting-row">
                  <span>音频格式</span>
                  <input
                    className="extension-input"
                    value={settingsDraft.audioExtensions.join(", ")}
                    aria-label="音频扩展名"
                    onChange={(event) => setSettingsDraft((draft) => ({
                      ...draft,
                      audioExtensions: event.target.value.split(",").map(normalizeVideoExtension).filter((item): item is string => item !== null),
                    }))}
                  />
                </label>
                <label className="setting-row">
                  <span>图片格式</span>
                  <input
                    className="extension-input"
                    value={settingsDraft.imageExtensions.join(", ")}
                    aria-label="图片扩展名"
                    onChange={(event) => setSettingsDraft((draft) => ({
                      ...draft,
                      imageExtensions: event.target.value.split(",").map(normalizeVideoExtension).filter((item): item is string => item !== null),
                    }))}
                  />
                </label>
                <label className="setting-row">
                  <span>文本格式</span>
                  <input
                    className="extension-input"
                    value={settingsDraft.textExtensions.join(", ")}
                    aria-label="文本扩展名"
                    onChange={(event) => setSettingsDraft((draft) => ({
                      ...draft,
                      textExtensions: event.target.value.split(",").map(normalizeVideoExtension).filter((item): item is string => item !== null),
                    }))}
                  />
                </label>
              </details>

              <details className="settings-section">
                <summary>浏览行为</summary>
                <div className="setting-row">
                  <span>选择视频后自动播放</span>
                  <button
                    className={`switch ${settingsDraft.autoplay ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.autoplay}
                    onClick={() => setSettingsDraft((draft) => ({ ...draft, autoplay: !draft.autoplay }))}
                  >
                    <span />
                  </button>
                </div>
                <div className="setting-row">
                  <span>记忆工作区排序与视频焦点</span>
                  <button
                    className={`switch ${settingsDraft.rememberWorkspaceFocus ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.rememberWorkspaceFocus}
                    aria-label="记忆工作区排序与视频焦点"
                    onClick={() =>
                      setSettingsDraft((draft) => ({
                        ...draft,
                        rememberWorkspaceFocus: !draft.rememberWorkspaceFocus,
                      }))
                    }
                  >
                    <span />
                  </button>
                </div>
                <div className="setting-row">
                  <span>显示隐藏和系统项目</span>
                  <button
                    className={`switch ${settingsDraft.showHiddenItems ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.showHiddenItems}
                    onClick={() => setSettingsDraft((draft) => ({ ...draft, showHiddenItems: !draft.showHiddenItems }))}
                  >
                    <span />
                  </button>
                </div>
                <div className="setting-row">
                  <span>显示 .nomedia 中的媒体</span>
                  <button
                    className={`switch ${settingsDraft.showNomediaMedia ? "on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={settingsDraft.showNomediaMedia}
                    onClick={() => setSettingsDraft((draft) => ({ ...draft, showNomediaMedia: !draft.showNomediaMedia }))}
                  >
                    <span />
                  </button>
                </div>
              </details>

              <details className="settings-section">
                <summary>列表列</summary>
                {settingsDraft.listColumns.map((column, index) => (
                  <div className="list-column-row" key={column.id}>
                    {column.id === "name" ? (
                      <span className="fixed-column-name">{listColumnLabels[column.id]}</span>
                    ) : (
                      <label className="check-control">
                        <input
                          type="checkbox"
                          checked={column.visible}
                          onChange={(event) => updateListColumn(column.id, { visible: event.target.checked })}
                        />
                        <span aria-hidden="true" />
                        <em>{listColumnLabels[column.id]}</em>
                      </label>
                    )}
                    <div className="list-column-actions">
                      <button
                        className="mini-icon-button"
                        type="button"
                        disabled={index <= 1}
                        aria-label={`上移${listColumnLabels[column.id]}`}
                        title="上移"
                        onClick={() => moveListColumn(index, -1)}
                      >
                        <ArrowUp size={15} />
                      </button>
                      <button
                        className="mini-icon-button"
                        type="button"
                        disabled={index === 0 || index === settingsDraft.listColumns.length - 1}
                        aria-label={`下移${listColumnLabels[column.id]}`}
                        title="下移"
                        onClick={() => moveListColumn(index, 1)}
                      >
                        <ArrowDown size={15} />
                      </button>
                      <label className="column-width-input">
                        <span className="sr-only">{listColumnLabels[column.id]}列宽</span>
                        <input
                          type="number"
                          min="80"
                          max="520"
                          step="4"
                          value={column.width}
                          onChange={(event) => updateListColumn(column.id, { width: Number(event.target.value) })}
                        />
                        <em>px</em>
                      </label>
                    </div>
                  </div>
                ))}
              </details>

              <details className="settings-section">
                <summary>数据管理</summary>
                <div className="data-summary" aria-live="polite">
                  <span>缩略图 {formatBytes(dataSummary?.thumbnailBytes ?? 0)}</span>
                  <span>日志 {formatBytes(dataSummary?.logBytes ?? 0)}</span>
                  <span>背景 {formatBytes(dataSummary?.backgroundBytes ?? 0)}</span>
                  <strong>合计 {formatBytes(dataSummary?.totalBytes ?? 0)}</strong>
                </div>
                <div className="settings-action-row">
                  <button type="button" className="command-button" onClick={() => void onClearThumbnails()}>清空缩略图缓存</button>
                  <button type="button" className="command-button" onClick={() => void onClearOldLogs()}>清理旧日志</button>
                  {dataSummary && <button type="button" className="command-button" onClick={() => void onOpenPath(dataSummary.dataPath)}>打开数据目录</button>}
                </div>
              </details>

              <details className="settings-section">
                <summary>关于与诊断</summary>
                <p className="settings-description">FileSweeper v{aboutInfo?.appVersion ?? "正在读取版本信息"}</p>
                <p className="settings-description">应用自有源代码采用 MIT 许可证；FFmpeg、FFprobe 与 ffmpegthumbnailer 由用户自行安装，许可证与来源说明见“打开许可证”。</p>
                {aboutInfo && <div className="about-sidecars">{Object.entries(aboutInfo.sidecars).map(([name, version]) => <span key={name}>{name}: {version}</span>)}</div>}
                <div className="settings-action-row">
                  <button type="button" className="command-button" onClick={() => void onExportDiagnostics()}>导出诊断信息</button>
                  {aboutInfo && <button type="button" className="command-button" onClick={() => void onOpenPath(aboutInfo.dataPath)}>打开数据目录</button>}
                  {aboutInfo?.licensesPath && <button type="button" className="command-button" onClick={() => void onOpenPath(aboutInfo.licensesPath!)}>打开许可证</button>}
                </div>
              </details>
            </div>

            <footer className="settings-footer">
              <button className="command-button" type="button" onClick={closeSettings}>
                取消
              </button>
              <button className="command-button primary-command" type="button" disabled={!settingsDirty} onClick={() => void applySettings()}>
                应用
              </button>
            </footer>
          </section>
        </div>
  );
}
