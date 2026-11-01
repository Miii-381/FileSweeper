import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileEntry } from "../../app-types";
import { ImagePreview } from "./ImagePreview";

const { invoke, centerView, resize } = vi.hoisted(() => ({ invoke: vi.fn(), centerView: vi.fn(), resize: { notify: () => {} } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../../app-utils", () => ({ errorMessage: String, writeClientLog: vi.fn() }));
vi.mock("react-zoom-pan-pinch", async () => {
  const { forwardRef, useEffect, useImperativeHandle } = await import("react");
  const controls = { centerView, instance: { wrapperComponent: { clientWidth: 600, clientHeight: 180 } } };
  return {
    TransformWrapper: forwardRef(({ children, onInit }: { children: (controls: unknown) => React.ReactNode; onInit: () => void }, ref) => { useImperativeHandle(ref, () => controls); useEffect(() => onInit(), []); return children(controls); }),
    TransformComponent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

describe("图片适应实际预览窗格", () => {
  beforeEach(() => {
    centerView.mockReset();
    invoke.mockImplementation((name) => Promise.resolve(name === "inspect_image_preview" ? { allowed: true, width: 2000, height: 1000 } : "http://127.0.0.1/image"));
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize.notify = callback; } observe() {} disconnect() {} });
  });
  it("加载时取宽高限制中较小的倍率，并在窗格变化后重新居中适应", async () => {
    render(<ImagePreview file={{ path: "/image.png", name: "image.png" } as FileEntry} />);
    const image = await screen.findByRole("img");
    Object.defineProperties(image, { naturalWidth: { value: 2000 }, naturalHeight: { value: 1000 } });
    fireEvent.load(image);
    await waitFor(() => expect(centerView).toHaveBeenLastCalledWith(.18, 0));
    centerView.mockClear(); resize.notify();
    await waitFor(() => expect(centerView).toHaveBeenLastCalledWith(.18, 0));
    fireEvent.click(screen.getByTitle("顺时针旋转"));
    await waitFor(() => expect(centerView).toHaveBeenLastCalledWith(.09, 0));
    expect((document.querySelector(".image-preview-geometry") as HTMLElement).style.width).toBe("1000px");
  });
});
