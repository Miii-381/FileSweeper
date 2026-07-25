import { isFileEntry, type DirectoryItem, type FileEntry } from "../../app-types";
import { formatBytes, formatDate, formatDuration, formatResolution } from "../../app-utils";

type DetailRow = { label: string; value: string; title?: string };

function mediaValue(value: number | null, loading: boolean) {
  return value === null && loading ? "读取中…" : formatDuration(value);
}

function fileSpecificRows(file: FileEntry, loading: boolean): DetailRow[] {
  switch (file.kind) {
    case "video":
      return [
        { label: "时长", value: mediaValue(file.duration, loading) },
        { label: "视频分辨率", value: (!file.width || !file.height) && loading ? "读取中…" : formatResolution(file) },
      ];
    case "audio":
      return [
        { label: "时长", value: mediaValue(file.duration, loading) },
        {
          label: "内嵌封面尺寸",
          value: file.width && file.height ? formatResolution(file) : file.thumbnailPath ? "已提取（尺寸未知）" : "未检测到内嵌封面",
        },
      ];
    case "image":
      return [{ label: "图像尺寸", value: formatResolution(file) }];
    case "text":
      return [{ label: "预览方式", value: "只读文本/代码" }];
    case "pdf":
      return [{ label: "预览方式", value: "PDF 阅读器" }];
    case "other":
      return [{ label: "预览方式", value: "仅文件信息" }];
  }
}

export function FileDetails({
  item,
  loading,
}: {
  item: DirectoryItem | null;
  loading: boolean;
}) {
  const file = item && isFileEntry(item) ? item : null;
  const folder = item && !isFileEntry(item) ? item : null;
  const rows: DetailRow[] = folder ? [
    { label: "名称", value: folder.name, title: folder.name },
    { label: "创建日期", value: formatDate(folder.createdAt) },
    { label: "最后修改", value: formatDate(folder.modifiedAt) },
    { label: "路径", value: folder.path, title: folder.path },
  ] : file ? [
    { label: "名称", value: file.name, title: file.name },
    { label: "大小", value: formatBytes(file.size) },
    { label: "创建日期", value: formatDate(file.createdAt) },
    { label: "最后修改", value: formatDate(file.modifiedAt) },
    { label: "类型", value: file.extension.toUpperCase() },
    ...fileSpecificRows(file, loading),
    { label: "路径", value: file.path, title: file.path },
  ] : [];
  return (
    <section className="details-panel">
      <div className="section-heading"><span>{folder ? "文件夹信息" : "文件信息"}</span></div>
      <dl>
        {rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd title={row.title}>{row.value}</dd></div>)}
      </dl>
    </section>
  );
}
