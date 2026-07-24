import { isFileEntry, type DirectoryItem } from "../../app-types";
import { formatBytes, formatDate, formatDuration, formatResolution } from "../../app-utils";

export function FileDetails({
  item,
  loading,
}: {
  item: DirectoryItem | null;
  loading: boolean;
}) {
  const file = item && isFileEntry(item) ? item : null;
  const folder = item && !isFileEntry(item) ? item : null;
  return (
    <section className="details-panel">
      <div className="section-heading"><span>{folder ? "文件夹信息" : "文件信息"}</span></div>
      <dl>
        <div><dt>名称</dt><dd title={item?.name}>{item?.name ?? "-"}</dd></div>
        <div><dt>大小</dt><dd>{file ? formatBytes(file.size) : "-"}</dd></div>
        <div><dt>创建日期</dt><dd>{item ? formatDate(item.createdAt) : "-"}</dd></div>
        <div><dt>类型</dt><dd>{folder ? "文件夹" : file?.extension.toUpperCase() ?? "-"}</dd></div>
        <div>
          <dt>时长</dt>
          <dd>{file ? file.duration === null && loading ? "读取中…" : formatDuration(file.duration) : "-"}</dd>
        </div>
        <div>
          <dt>分辨率</dt>
          <dd>{file ? (!file.width || !file.height) && loading ? "读取中…" : formatResolution(file) : "-"}</dd>
        </div>
        {folder && <div><dt>路径</dt><dd title={folder.path}>{folder.path}</dd></div>}
      </dl>
    </section>
  );
}
