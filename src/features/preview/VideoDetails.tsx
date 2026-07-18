import type { VideoEntry } from "../../app-types";
import { formatBytes, formatDate, formatDuration, formatResolution } from "../../app-utils";

export function VideoDetails({
  video,
  loading,
}: {
  video: VideoEntry | null;
  loading: boolean;
}) {
  return (
    <section className="details-panel">
      <div className="section-heading"><span>文件信息</span></div>
      <dl>
        <div><dt>名称</dt><dd title={video?.name}>{video?.name ?? "-"}</dd></div>
        <div><dt>大小</dt><dd>{video ? formatBytes(video.size) : "-"}</dd></div>
        <div><dt>创建日期</dt><dd>{video ? formatDate(video.createdAt) : "-"}</dd></div>
        <div><dt>格式</dt><dd>{video?.extension.toUpperCase() ?? "-"}</dd></div>
        <div>
          <dt>时长</dt>
          <dd>{video ? video.duration === null && loading ? "读取中…" : formatDuration(video.duration) : "-"}</dd>
        </div>
        <div>
          <dt>分辨率</dt>
          <dd>{video ? (!video.width || !video.height) && loading ? "读取中…" : formatResolution(video) : "-"}</dd>
        </div>
      </dl>
    </section>
  );
}
