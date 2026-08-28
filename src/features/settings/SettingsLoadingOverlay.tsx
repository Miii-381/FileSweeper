import { LoaderCircle } from "lucide-react";

export function SettingsLoadingOverlay() {
  return (
    <div className="settings-loading-overlay" role="alertdialog" aria-modal="true" aria-live="assertive">
      <div className="metadata-loading-dialog">
        <LoaderCircle size={20} className="spinning" aria-hidden="true" />
        <div>
          <strong>正在读取许可证</strong>
          <span>正在检查许可证与媒体组件信息…</span>
        </div>
      </div>
    </div>
  );
}
