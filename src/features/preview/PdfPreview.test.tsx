import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PdfPreview } from "./PdfPreview";

const { invoke, getDocument, workerCreate, workerDestroy, loadingDestroy, pageRenderCancel, workerTerminate, writeClientLog } = vi.hoisted(() => ({
  invoke: vi.fn(),
  getDocument: vi.fn(),
  workerCreate: vi.fn(),
  workerDestroy: vi.fn(),
  loadingDestroy: vi.fn(),
  pageRenderCancel: vi.fn(),
  workerTerminate: vi.fn(),
  writeClientLog: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app-utils", () => ({
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
  writeClientLog,
}));
vi.mock("pdfjs-dist", () => ({
  getDocument,
  PDFWorker: { create: workerCreate },
  PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
  RenderingCancelledException: class RenderingCancelledException extends Error {},
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?worker", () => ({
  default: class PdfWorkerMock { terminate = workerTerminate; },
}));

const file = {
  path: "C:\\Files\\guide.pdf",
  name: "guide.pdf",
  extension: ".pdf",
  size: 1,
  createdAt: null,
  modifiedAt: null,
  duration: null,
  width: null,
  height: null,
  thumbnailPath: null,
  kind: "pdf" as const,
  previewCapability: "inline" as const,
};

function createLoadingTask(pageCount = 3) {
  const document = {
    numPages: pageCount,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 140 * scale }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: pageRenderCancel })),
    })),
  };
  return {
    promise: Promise.resolve(document),
    destroy: loadingDestroy,
    onPassword: null as ((updatePassword: (password: string) => void, reason: number) => void) | null,
  };
}

function createWidePageLoadingTask() {
  const document = {
    numPages: 1,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 1400 * scale }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: pageRenderCancel })),
    })),
  };
  return {
    promise: Promise.resolve(document),
    destroy: loadingDestroy,
    onPassword: null as ((updatePassword: (password: string) => void, reason: number) => void) | null,
  };
}

describe("PdfPreview", () => {
  beforeEach(() => {
    invoke.mockReset();
    getDocument.mockReset();
    workerCreate.mockReset();
    workerDestroy.mockReset();
    loadingDestroy.mockReset();
    pageRenderCancel.mockReset();
    workerTerminate.mockReset();
    writeClientLog.mockReset();
    invoke.mockResolvedValue("http://127.0.0.1:1234/preview.pdf");
    workerCreate.mockReturnValue({ destroy: workerDestroy });
    getDocument.mockReturnValue(createLoadingTask());
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: vi.fn(() => ({})) });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 400, width: 640, height: 400, toJSON: () => ({}) }),
    });
  });

  it("使用本地预览地址加载并提供翻页和缩放控件", async () => {
    render(<PdfPreview file={file} />);

    await screen.findByText("/ 3");
    expect(invoke).toHaveBeenCalledWith("get_preview_file_url", { path: file.path });
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://127.0.0.1:1234/preview.pdf",
      wasmUrl: expect.stringContaining("pdfjs/wasm/"),
    }));
    fireEvent.click(screen.getByTitle("下一页"));
    expect((screen.getByLabelText("跳转到页码") as HTMLInputElement).value).toBe("2");
    fireEvent.click(screen.getByTitle("放大"));
    await waitFor(() => expect(screen.getByText(/%$/)).toBeTruthy());
  });

  it("在当前会话中处理密码重试并且不保留密码", async () => {
    const loadingTask = createLoadingTask();
    getDocument.mockReturnValue(loadingTask);
    render(<PdfPreview file={file} />);

    await waitFor(() => expect(loadingTask.onPassword).toBeTypeOf("function"));
    const updatePassword = vi.fn();
    act(() => loadingTask.onPassword?.(updatePassword, 2));
    expect(await screen.findByText("密码不正确，请重试")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("PDF 密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "打开" }));
    expect(updatePassword).toHaveBeenCalledWith("secret");
    expect(screen.queryByDisplayValue("secret")).toBeNull();
  });

  it("预览窗窄于页面时可缩小到 25% 以下并完整适应宽度", async () => {
    getDocument.mockReturnValue(createWidePageLoadingTask());
    render(<PdfPreview file={file} />);

    const canvas = await screen.findByLabelText("PDF 第 1 页");
    await waitFor(() => expect(canvas.style.width).toBe("142px"));
    expect(canvas.style.height).toBe("199px");
  });

  it("卸载时取消加载、页面任务并释放 Worker", async () => {
    const { unmount } = render(<PdfPreview file={file} />);
    await screen.findByText("/ 3");
    unmount();

    expect(loadingDestroy).toHaveBeenCalled();
    expect(workerDestroy).toHaveBeenCalled();
    expect(workerTerminate).toHaveBeenCalled();
    expect(pageRenderCancel).toHaveBeenCalled();
  });
});
