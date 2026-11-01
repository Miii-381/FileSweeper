import { useEffect, useState } from "react";
import { ChevronRight, Folder, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { errorMessage, writeClientLog } from "../app-utils";
import { mobileCall } from "./mobile-api";
import type { WorkspaceListing } from "../app-types";
import type { FavoritePath } from "./mobile-workspace";

export function MobileLocations({ root, currentPath, favorites, save, open, openTrash, browse, chosen }: {
  root: string; currentPath: string; favorites: FavoritePath[]; save: (favorites: FavoritePath[]) => void;
  open: (path: string) => void; openTrash: () => void; browse: (path: string) => void; chosen: { path: string } | null;
}) {
  const [editing, setEditing] = useState<string | null | false>(false);
  const [path, setPath] = useState(currentPath);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (chosen) setPath(chosen.path); }, [chosen]);
  const add = () => { setEditing(null); setPath(currentPath); setName(""); setError(""); };
  return <div className="mobile-locations">
    {[{ name: "内部存储", path: root }, { name: "下载", path: `${root}/Download` }, { name: "图片", path: `${root}/Pictures` }, { name: "相机", path: `${root}/DCIM` }].map((location) => <button key={location.path} className="mobile-menu-row" onClick={() => open(location.path)}><Folder size={21} /><span>{location.name}</span><ChevronRight size={16} /></button>)}
    <div className="mobile-location-heading"><h3><Star size={18} />喜好路径</h3><button aria-label="添加喜好路径" onClick={add}><Plus size={21} /></button></div>
    {favorites.length === 0 && editing === false && <p className="mobile-muted">添加常用目录，之后可从这里快速进入。</p>}
    {favorites.map((favorite) => <div className="mobile-location-entry" key={favorite.path}><button className="mobile-menu-row" onClick={() => open(favorite.path)}><Folder size={21} /><span><strong>{favorite.name}</strong><small>{favorite.path}</small></span></button><button aria-label={`编辑喜好路径 ${favorite.name}`} onClick={() => { setEditing(favorite.path); setPath(favorite.path); setName(favorite.name); setError(""); }}><Pencil size={18} /></button><button aria-label={`移除喜好路径 ${favorite.name}`} onClick={() => { save(favorites.filter((entry) => entry.path !== favorite.path)); if (editing === favorite.path) setEditing(false); writeClientLog("info", `移除手机喜好路径：${favorite.path}`); }}><Trash2 size={18} /></button></div>)}
    {editing !== false && <form className="mobile-favorite-form" onSubmit={async (event) => {
      event.preventDefault(); if (saving) return; setSaving(true); setError("");
      try {
        const requested = path.trim();
        if (!(requested === root || requested.startsWith(`${root}/`))) throw new Error("请选择内部存储中的目录");
        const directory = await mobileCall<WorkspaceListing>("listDirectory", { path: requested });
        if (favorites.some((entry) => entry.path === directory.path && entry.path !== editing)) throw new Error("此目录已在喜好路径中");
        const favorite = { path: directory.path, name: name.trim() || directory.path.split("/").filter(Boolean).at(-1) || "内部存储" };
        save([...favorites.filter((entry) => entry.path !== editing), favorite]); setEditing(false);
        writeClientLog("info", `手机喜好路径已保存：${favorite.name}，${favorite.path}`);
      } catch (reason) { setError(errorMessage(reason)); writeClientLog("warn", `保存手机喜好路径失败：${errorMessage(reason)}`); }
      finally { setSaving(false); }
    }}><h3>{editing ? "编辑喜好路径" : "添加喜好路径"}</h3><label>目录路径<input aria-label="喜好目录路径" value={path} onChange={(event) => setPath(event.target.value)} required /></label><button type="button" className="mobile-menu-row" onClick={() => browse(path.startsWith(root) ? path : root)}><Folder size={18} />浏览选择目录</button><label>显示名称（可选）<input aria-label="喜好路径名称" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="默认使用目录名称" /></label>{error && <p className="mobile-inline-error" role="alert">{error}</p>}<button className="mobile-primary" disabled={saving} type="submit">{saving ? "正在保存…" : "保存喜好路径"}</button><button type="button" className="mobile-menu-row" disabled={saving} onClick={() => setEditing(false)}>取消</button></form>}
    <button className="mobile-menu-row" onClick={openTrash}><Trash2 size={21} />回收站</button>
  </div>;
}
