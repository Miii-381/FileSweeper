import { useEffect, useRef } from "react";

export function ThemedConfirmDialog({ title, message, confirmLabel = "移到回收站", onConfirm, onCancel }: { title: string; message: string; confirmLabel?: string; onConfirm: () => void; onCancel: () => void }) {
  const cancelButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    cancelButton.current?.focus();
    return () => previousFocus.current?.focus();
  }, []);
  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") onCancel(); }}>
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-message">{message}</p>
        <footer>
          <button ref={cancelButton} type="button" className="command-button" onClick={onCancel}>取消</button>
          <button type="button" className="command-button danger-command" onClick={onConfirm}>{confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}
