import type { ReactNode } from "react";
import { useState } from "react";
import { themePresets } from "../theme";
import { mobileCall, type MobilePreferences } from "./mobile-api";
import { errorMessage } from "../app-utils";

function Setting({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return <label className="mobile-setting-row"><span><strong>{title}</strong>{help && <small>{help}</small>}</span>{children}</label>;
}

export function MobileSettings({ preferences: p, save, imported, notify }: { preferences: MobilePreferences; save: (patch: Partial<MobilePreferences>) => Promise<void>; imported: (preferences: MobilePreferences) => void; notify: (message: string) => void }) {
  const [importing, setImporting] = useState(false);
  const toggle = (key: "trashEnabled" | "autoplay" | "muted" | "rememberWorkspaceFocus" | "showHiddenItems" | "showNomediaMedia", title: string, help?: string) => <Setting title={title} help={help}><input aria-label={title} type="checkbox" checked={p[key]} onChange={(e) => void save({ [key]: e.target.checked })} /></Setting>;
  const numeric = (key: "imageMaxMegabytes" | "imageMaxMegapixels" | "thumbnailCacheMb", title: string, min: number, max: number) => <Setting title={title}><input aria-label={title} type="number" min={min} max={max} key={`${key}-${p[key]}`} defaultValue={p[key]} onBlur={(e) => { const value = Number(e.target.value); if (!Number.isInteger(value) || value < min || value > max) { e.target.value = String(p[key]); notify(`请输入 ${min}–${max} 之间的整数`); } else if (value !== p[key]) void save({ [key]: value }); }} /></Setting>;
  return <div className="mobile-settings">
    <p className="mobile-muted">修改即时保存，文件在本机处理。</p>
    <details open><summary>外观与背景</summary><div className="mobile-settings-group-body">
      <Setting title="显示模式"><select aria-label="显示模式" value={p.appearance} onChange={(e) => void save({ appearance: e.target.value as MobilePreferences["appearance"] })}><option value="system">跟随系统</option><option value="dark">深色</option><option value="light">浅色</option></select></Setting>
      <div className="mobile-setting-row"><strong>主题色</strong><div className="mobile-swatches">{themePresets.map((theme) => <button aria-label={`${theme.name}主题`} aria-pressed={p.accentTheme === theme.id} key={theme.id} style={{ background: theme.color }} onClick={() => void save({ accentTheme: theme.id })} />)}</div></div>
      <div className="mobile-setting-row"><strong>背景图片</strong><div><button disabled={importing} onClick={async () => { setImporting(true); try { const result = await mobileCall<{ cancelled?: boolean; preferences?: MobilePreferences }>("chooseBackground"); if (result.preferences) imported(result.preferences); } catch (reason) { notify(errorMessage(reason)); } finally { setImporting(false); } }}>{importing ? "正在导入…" : "选择图片"}</button>{p.backgroundImage && <button onClick={() => void save({ backgroundImage: null })}>移除</button>}</div></div>
      <p className="mobile-muted">使用系统文件选择器导入，图片保存在应用内。上限 32 MiB / 64 MP。</p>
      {(["backgroundOpacity", "backgroundBlur"] as const).map((key) => <Setting key={key} title={key === "backgroundOpacity" ? "背景不透明度" : "背景模糊"}><div className="mobile-setting-range"><input aria-label={key === "backgroundOpacity" ? "背景不透明度" : "背景模糊"} type="range" min={0} max={100} value={p[key]} onChange={(e) => void save({ [key]: Number(e.target.value) })} /><output>{p[key]}%</output></div></Setting>)}
    </div></details>
    <details><summary>播放与浏览</summary><div className="mobile-settings-group-body">
      {toggle("autoplay", "切换文件自动播放", "音频与视频默认开启；收起预览或进入后台时暂停")}
      <Setting title="长按播放倍速" help="按住预览区域临时倍速播放，松手恢复"><select aria-label="长按播放倍速" value={p.holdPlaybackSpeed} onChange={(event) => void save({ holdPlaybackSpeed: Number(event.target.value) })}>{[1.25, 1.5, 2, 3].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</select></Setting>
      {toggle("muted", "静音")}
      <Setting title="预览音量"><div className="mobile-setting-range"><input aria-label="预览音量" type="range" min={0} max={100} value={p.volume} onChange={(e) => void save({ volume: Number(e.target.value) })} /><output>{p.volume}%</output></div></Setting>
      {toggle("rememberWorkspaceFocus", "记忆焦点与浏览位置", "分别记住每个目录的所选文件、排序、视图与滚动位置，切换目录和重新启动后恢复")}
      {toggle("showHiddenItems", "显示隐藏文件", "显示以点开头的文件和目录")}
      {toggle("showNomediaMedia", "显示 .nomedia 中的媒体", "关闭时隐藏当前目录及上级 .nomedia 标记下的图片、音频和视频")}
    </div></details>
    <details><summary>预览格式与性能</summary><div className="mobile-settings-group-body">
      <Setting title="代码配色"><select aria-label="代码配色" value={p.codeTheme} onChange={(e) => void save({ codeTheme: e.target.value as MobilePreferences["codeTheme"] })}>{["tomorrow", "default", "dark", "funky", "okaidia", "twilight", "coy", "solarizedlight"].map((name) => <option key={name} value={name}>{name}</option>)}</select></Setting>
      {(["textPreviewLatinFont", "textPreviewCjkFont"] as const).map((key) => <Setting key={key} title={key === "textPreviewLatinFont" ? "文本英文字体" : "文本中文字体"}><input aria-label={key === "textPreviewLatinFont" ? "文本英文字体" : "文本中文字体"} key={p[key]} defaultValue={p[key]} maxLength={120} onBlur={(e) => { if (e.target.value.trim()) void save({ [key]: e.target.value.trim() }); }} /></Setting>)}
      <p className="mobile-muted">字体需由手机系统提供。文本预览最多读取 4 MiB。</p>
      {numeric("imageMaxMegabytes", "图片大小上限（MiB）", 1, 512)}
      {numeric("imageMaxMegapixels", "图片像素上限（MP）", 1, 128)}
      {numeric("thumbnailCacheMb", "缩略图缓存上限（MiB）", 16, 2048)}
      <Setting title="视频缩略图取帧"><select aria-label="视频缩略图取帧" value={p.thumbnailCapturePosition} onChange={(e) => void save({ thumbnailCapturePosition: e.target.value as MobilePreferences["thumbnailCapturePosition"] })}>{[["opening","开头"],["early","前段"],["middle","中间"],["late","后段"],["ending","结尾"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></Setting>
      {([ ["videoExtensions", "视频"], ["audioExtensions", "音频"], ["imageExtensions", "图片"], ["textExtensions", "文本"] ] as const).map(([key,title]) => <label className="mobile-format-setting" key={`${key}-${p[key].join()}`}><strong>{title}扩展名</strong><textarea aria-label={`${title}扩展名`} defaultValue={p[key].join(", ")} onBlur={(e) => { const values = [...new Set(e.target.value.split(/[,，\s]+/).filter(Boolean).map((value) => value.replace(/^\./, "").toLowerCase()))]; if (values.length && values.length <= 128 && values.every((value) => /^[a-z0-9][a-z0-9_+-]{0,19}$/.test(value))) { if (values.join() !== p[key].join()) void save({ [key]: values }); } else { e.target.value = p[key].join(", "); notify("扩展名无效，请用逗号分隔并至少保留一种格式"); } }} /></label>)}
      <p className="mobile-muted">扩展名决定预览类型，实际可播放格式取决于设备解码能力。</p>
      <label className="mobile-format-setting"><strong>代码语言映射（JSON）</strong><textarea aria-label="代码语言映射" key={JSON.stringify(p.textLanguageMap)} defaultValue={JSON.stringify(p.textLanguageMap, null, 2)} onBlur={(e) => { try { const value: unknown = JSON.parse(e.target.value); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请输入 JSON 对象"); void save({ textLanguageMap: value as Record<string, string> }); } catch { e.target.value = JSON.stringify(p.textLanguageMap, null, 2); notify("语言映射必须为 JSON 对象，例如 {\".py\":\"python\"}"); } }} /></label>
    </div></details>
    <details><summary>回收站与数据管理</summary><div className="mobile-settings-group-body">
      {toggle("trashEnabled", "启用回收站", "关闭后删除需要确认永久删除")}
      <p className="mobile-muted">回收站仅手动清理。关闭开关不会清空已回收的文件。</p>
      <button className="mobile-menu-row" onClick={() => void mobileCall<{ removed: number }>("clearThumbnails").then((result) => notify(`已清理 ${result.removed} 个缩略图缓存`)).catch((reason) => notify(errorMessage(reason)))}>清理缩略图缓存</button>
    </div></details>
  </div>;
}
