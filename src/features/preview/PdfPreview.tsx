import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight, Scan, ZoomIn, ZoomOut } from "lucide-react";
import {
  getDocument,
  PDFWorker,
  PasswordResponses,
  RenderingCancelledException,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import PdfWorkerModule from "pdfjs-dist/build/pdf.worker.min.mjs?worker";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { FileEntry } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";
import { PreviewError } from "./ImagePreview";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.1;
const PAGE_GAP = 16;
const PAGE_PADDING = 16;

type PasswordPrompt = { incorrect: boolean };

type RenderQueue = {
  active: number;
  destroyed: boolean;
  waiting: Array<(release: () => void) => void>;
};

function releaseRenderSlot(queue: RenderQueue) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    queue.active = Math.max(0, queue.active - 1);
    const next = queue.waiting.shift();
    if (next && !queue.destroyed) {
      queue.active += 1;
      next(releaseRenderSlot(queue));
    }
  };
}

function useRenderQueue(sessionKey: string) {
  const queueRef = useRef<RenderQueue>({ active: 0, destroyed: false, waiting: [] });

  useEffect(() => {
    const previous = queueRef.current;
    previous.destroyed = true;
    for (const resolve of previous.waiting.splice(0)) resolve(() => {});
    queueRef.current = { active: 0, destroyed: false, waiting: [] };
    return () => {
      const queue = queueRef.current;
      queue.destroyed = true;
      for (const resolve of queue.waiting.splice(0)) resolve(() => {});
    };
  }, [sessionKey]);

  return useCallback(() => new Promise<() => void>((resolve) => {
    const queue = queueRef.current;
    if (queue.destroyed) {
      resolve(() => {});
    } else if (queue.active < 2) {
      queue.active += 1;
      resolve(releaseRenderSlot(queue));
    } else {
      queue.waiting.push(resolve);
    }
  }), []);
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function pdfWasmUrl() {
  return new URL("./pdfjs/wasm/", window.location.href).toString();
}

function pdfErrorMessage(error: unknown, passwordCancelled: boolean) {
  if (passwordCancelled) return "已取消输入 PDF 密码";
  const name = error instanceof Error ? error.name : "";
  if (name === "InvalidPDFException") return "该文件不是有效的 PDF，或内容已损坏";
  if (name === "PasswordException") return "无法使用提供的密码打开 PDF";
  const message = errorMessage(error);
  if (/worker/i.test(message)) return "PDF 渲染 Worker 无法启动";
  return message || "无法读取此 PDF";
}

function PdfPageCanvas({
  document,
  pageNumber,
  width,
  zoom,
  fitWidth,
  filePath,
  acquireRenderSlot,
  onFailure,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  zoom: number;
  fitWidth: boolean;
  filePath: string;
  acquireRenderSlot: () => Promise<() => void>;
  onFailure: (message: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    let releaseSlot: (() => void) | null = null;
    setPageError(null);

    void (async () => {
      try {
        writeClientLog("debug", `PDF 页面渲染排队：文件 ${filePath}，页码 ${pageNumber}`);
        const page = await document.getPage(pageNumber);
        if (!active || width <= 0) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const pageScale = fitWidth ? clampZoom((width - PAGE_PADDING * 2) / baseViewport.width) : zoom;
        const viewport = page.getViewport({ scale: pageScale });
        const canvas = canvasRef.current;
        if (!canvas || !active) return;
        const pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.ceil(viewport.width * pixelRatio);
        canvas.height = Math.ceil(viewport.height * pixelRatio);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("浏览器无法创建 PDF 绘图上下文");
        releaseSlot = await acquireRenderSlot();
        if (!active) return;
        writeClientLog("debug", `PDF 页面开始渲染：文件 ${filePath}，页码 ${pageNumber}，缩放 ${pageScale}`);
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
        if (active) writeClientLog("debug", `PDF 页面渲染完成：文件 ${filePath}，页码 ${pageNumber}`);
      } catch (error) {
        if (!active || error instanceof RenderingCancelledException || (error instanceof Error && error.name === "RenderingCancelledException")) {
          writeClientLog("debug", `PDF 页面渲染已取消：文件 ${filePath}，页码 ${pageNumber}`);
          return;
        }
        const message = pdfErrorMessage(error, false);
        writeClientLog("error", `PDF 页面渲染失败：文件 ${filePath}，页码 ${pageNumber}，原因 ${message}`);
        setPageError(message);
        onFailure(message);
      } finally {
        releaseSlot?.();
        releaseSlot = null;
      }
    })();

    return () => {
      active = false;
      renderTask?.cancel();
      releaseSlot?.();
      writeClientLog("debug", `PDF 页面渲染资源已释放：文件 ${filePath}，页码 ${pageNumber}`);
    };
  }, [acquireRenderSlot, document, filePath, fitWidth, onFailure, pageNumber, width, zoom]);

  return <div className="pdf-page-content">
    <canvas ref={canvasRef} aria-label={`PDF 第 ${pageNumber} 页`} />
    {pageError && <p className="pdf-page-error">第 {pageNumber} 页无法渲染：{pageError}</p>}
  </div>;
}

export function PdfPreview({ file }: { file: FileEntry }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passwordPrompt, setPasswordPrompt] = useState<PasswordPrompt | null>(null);
  const [password, setPassword] = useState("");
  const [reloadId, setReloadId] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [viewportWidth, setViewportWidth] = useState(640);
  const passwordUpdate = useRef<((password: string) => void) | null>(null);
  const passwordCancelled = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sessionKey = `${file.path}:${reloadId}`;
  const acquireRenderSlot = useRenderQueue(sessionKey);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateWidth = () => setViewportWidth(Math.max(160, stage.clientWidth));
    updateWidth();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateWidth);
    observer?.observe(stage);
    return () => observer?.disconnect();
  }, [document]);

  useEffect(() => {
    let active = true;
    let loadedDocument: PDFDocumentProxy | null = null;
    let worker: PDFWorker | null = null;
    let workerPort: Worker | null = null;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    passwordUpdate.current = null;
    passwordCancelled.current = false;
    setDocument(null);
    setError(null);
    setPasswordPrompt(null);
    setPassword("");
    setCurrentPage(1);
    setPageInput("1");
    setZoom(1);
    setFitWidth(true);
    writeClientLog("debug", `开始 PDF 预览会话：${file.path}`);

    void (async () => {
      try {
        const url = await invoke<string>("get_preview_file_url", { path: file.path });
        if (!active) return;
        const wasmUrl = pdfWasmUrl();
        writeClientLog("debug", `PDF 本地读取地址已就绪：文件 ${file.path}，WASM 资源 ${wasmUrl}`);
        workerPort = new PdfWorkerModule();
        worker = PDFWorker.create({ name: "FileSweeper PDF preview", port: workerPort });
        writeClientLog("debug", `PDF Worker 已创建：文件 ${file.path}`);
        loadingTask = getDocument({ url, worker, wasmUrl });
        writeClientLog("debug", `PDF 文档加载已提交：文件 ${file.path}`);
        loadingTask.onPassword = (updatePassword: (password: string) => void, reason: number) => {
          if (!active) {
            updatePassword("");
            return;
          }
          passwordUpdate.current = updatePassword;
          setPassword("");
          setPasswordPrompt({ incorrect: reason === PasswordResponses.INCORRECT_PASSWORD });
          writeClientLog(
            "info",
            `PDF ${reason === PasswordResponses.INCORRECT_PASSWORD ? "密码错误，等待重试" : "需要密码"}：${file.path}`,
          );
        };
        loadedDocument = await loadingTask.promise;
        if (!active) {
          return;
        }
        passwordUpdate.current = null;
        writeClientLog("info", `PDF 文档加载完成：文件 ${file.path}，共 ${loadedDocument.numPages} 页`);
        setDocument(loadedDocument);
      } catch (reason) {
        if (active) {
          const message = pdfErrorMessage(reason, passwordCancelled.current);
          writeClientLog("error", `PDF 文档加载失败：文件 ${file.path}，原因 ${message}`);
          setError(message);
        }
      }
    })();

    return () => {
      active = false;
      passwordUpdate.current = null;
      passwordCancelled.current = false;
      if (loadingTask) {
        void Promise.resolve(loadingTask.destroy()).catch((reason) => {
          writeClientLog("warn", `PDF 加载任务释放失败：文件 ${file.path}，原因 ${errorMessage(reason)}`);
        });
      }
      worker?.destroy();
      workerPort?.terminate();
      writeClientLog("debug", `PDF 预览会话已释放：${file.path}`);
    };
  }, [file.path, reloadId]);

  const pageCount = document?.numPages ?? 0;
  const rowVirtualizer = useVirtualizer({
    count: pageCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => Math.max(320, (viewportWidth - PAGE_PADDING * 2) * 1.42 + PAGE_GAP),
    overscan: 1,
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [fitWidth, rowVirtualizer, viewportWidth, zoom]);

  const updateCurrentPage = useCallback(() => {
    const root = scrollRef.current;
    if (!root) return;
    const rootBounds = root.getBoundingClientRect();
    let bestPage = currentPage;
    let largestOverlap = 0;
    root.querySelectorAll<HTMLElement>(".pdf-page-card[data-page]").forEach((element) => {
      const bounds = element.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(bounds.bottom, rootBounds.bottom) - Math.max(bounds.top, rootBounds.top));
      if (overlap > largestOverlap) {
        largestOverlap = overlap;
        bestPage = Number(element.dataset.page);
      }
    });
    if (bestPage > 0) {
      setCurrentPage(bestPage);
      setPageInput(String(bestPage));
    }
  }, [currentPage]);

  const goToPage = useCallback((page: number) => {
    if (pageCount === 0) return;
    const target = Math.min(pageCount, Math.max(1, page));
    setCurrentPage(target);
    setPageInput(String(target));
    rowVirtualizer.scrollToIndex(target - 1, { align: "start" });
  }, [pageCount, rowVirtualizer]);

  const setManualZoom = useCallback(async (delta: number) => {
    if (!document) return;
    let currentZoom = zoom;
    if (fitWidth) {
      const page = await document.getPage(currentPage);
      const baseViewport = page.getViewport({ scale: 1 });
      currentZoom = clampZoom((viewportWidth - PAGE_PADDING * 2) / baseViewport.width);
      setFitWidth(false);
    }
    setZoom(clampZoom(currentZoom + delta));
  }, [currentPage, document, fitWidth, viewportWidth, zoom]);

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const update = passwordUpdate.current;
    if (!update || !password) return;
    passwordUpdate.current = null;
    setPassword("");
    setPasswordPrompt(null);
    update(password);
  };

  const cancelPassword = () => {
    const update = passwordUpdate.current;
    passwordUpdate.current = null;
    passwordCancelled.current = true;
    setPassword("");
    setPasswordPrompt(null);
    update?.("");
  };

  const retry = () => setReloadId((value) => value + 1);

  const passwordForm = passwordPrompt && <form className="pdf-password-prompt" onSubmit={submitPassword}>
    <label>{passwordPrompt.incorrect ? "密码不正确，请重试" : "此 PDF 受密码保护"}<input aria-label="PDF 密码" autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
    <button className="command-button" type="submit" disabled={!password}>打开</button>
    <button type="button" onClick={cancelPassword}>取消</button>
  </form>;

  if (error) return <PreviewError message={error} file={file} onRetry={retry} />;
  if (!document) return passwordForm ? <section className="pdf-preview">{passwordForm}<div className="preview-placeholder">正在等待密码…</div></section> : <div className="preview-placeholder">正在读取 PDF…</div>;

  return <section className="pdf-preview">
    <header className="pdf-preview-toolbar">
      <button type="button" onClick={() => goToPage(currentPage - 1)} disabled={currentPage <= 1} title="上一页"><ChevronLeft size={16} /></button>
      <button type="button" onClick={() => goToPage(currentPage + 1)} disabled={currentPage >= pageCount} title="下一页"><ChevronRight size={16} /></button>
      <form className="pdf-page-jump" onSubmit={(event) => { event.preventDefault(); goToPage(Number(pageInput)); }}>
        <input aria-label="跳转到页码" inputMode="numeric" min="1" max={pageCount} type="number" value={pageInput} onChange={(event) => setPageInput(event.target.value)} />
        <span>/ {pageCount}</span>
      </form>
      <span className="pdf-toolbar-spacer" />
      <button type="button" onClick={() => void setManualZoom(-ZOOM_STEP)} title="缩小"><ZoomOut size={16} /></button>
      <button type="button" onClick={() => void setManualZoom(ZOOM_STEP)} title="放大"><ZoomIn size={16} /></button>
      <button type="button" onClick={() => setFitWidth(true)} title="适应宽度"><Scan size={16} /></button>
      <output className="pdf-zoom-status">{fitWidth ? "适应宽度" : `${Math.round(zoom * 100)}%`}</output>
    </header>
    {passwordForm}
    <div ref={stageRef} className="pdf-preview-stage">
      <div
        ref={scrollRef}
        className="pdf-preview-scroll"
        aria-label="PDF 内容"
        onScroll={() => requestAnimationFrame(updateCurrentPage)}
      >
        <div className="pdf-preview-virtual-content" style={{ height: rowVirtualizer.getTotalSize() }}>
          {(rowVirtualizer.getVirtualItems().length > 0
            ? rowVirtualizer.getVirtualItems()
            : Array.from({ length: Math.min(pageCount, 2) }, (_, index) => ({ index, key: index, start: index * Math.max(320, (viewportWidth - PAGE_PADDING * 2) * 1.42 + PAGE_GAP) })))
            .map((virtualRow) => (
            <article
              ref={rowVirtualizer.measureElement}
              className="pdf-page-card"
              data-index={virtualRow.index}
              data-page={virtualRow.index + 1}
              key={virtualRow.key}
              style={{ transform: `translateY(${virtualRow.start}px)` }}
            >
              <PdfPageCanvas
                acquireRenderSlot={acquireRenderSlot}
                document={document}
                filePath={file.path}
                fitWidth={fitWidth}
                onFailure={setError}
                pageNumber={virtualRow.index + 1}
                width={viewportWidth}
                zoom={zoom}
              />
            </article>
          ))}
        </div>
      </div>
    </div>
  </section>;
}
