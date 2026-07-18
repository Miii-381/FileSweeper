import { LoaderCircle } from "lucide-react";

export function MetadataLoadingOverlay() {
  return (
    <div className="metadata-loading-overlay" role="alertdialog" aria-modal="true" aria-live="assertive">
      <div className="metadata-loading-dialog">
        <LoaderCircle size={20} className="spinning" aria-hidden="true" />
        <div>
          <strong>正在读取媒体信息</strong>
          <span>完成后将按所选字段统一排序</span>
        </div>
      </div>
    </div>
  );
}
