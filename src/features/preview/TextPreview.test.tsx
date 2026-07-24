import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TextPreview } from "./TextPreview";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./ImagePreview", () => ({ PreviewError: ({ message }: { message: string }) => <div>{message}</div> }));

const file = {
  path: "C:\\Files\\preview.ts",
  name: "preview.ts",
  extension: ".ts",
  size: 1,
  createdAt: null,
  modifiedAt: null,
  duration: null,
  width: null,
  height: null,
  thumbnailPath: null,
  kind: "text" as const,
  previewCapability: "inline" as const,
};

describe("TextPreview", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 640, bottom: 400, width: 640, height: 400, toJSON: () => ({}) }),
    });
  });

  it("仅渲染视口附近的大文本行", async () => {
    invoke.mockResolvedValue({
      content: Array.from({ length: 10_000 }, (_, index) => `const line${index} = ${index};`).join("\n"),
      encoding: "UTF-8",
      totalBytes: 1,
      readable: true,
      reason: null,
    });

    render(<TextPreview file={file} languageMap={{ ".ts": "typescript" }} codeTheme="tomorrow" />);

    await screen.findByText("UTF-8");
    expect(screen.getAllByTestId("text-preview-row").length).toBeLessThan(100);
    expect(document.querySelector(".text-preview-line-number")?.textContent).toBe("1");
  });

  it("超长单行保留完整内容但跳过 Prism 高亮", async () => {
    const longLine = "x".repeat(256 * 1024 + 1);
    invoke.mockResolvedValue({ content: longLine, encoding: "UTF-8", totalBytes: longLine.length, readable: true, reason: null });

    render(<TextPreview file={file} languageMap={{ ".ts": "typescript" }} codeTheme="tomorrow" />);

    await screen.findByText("该超长行未进行语法高亮");
    const code = document.querySelector(".text-preview-code")!;
    expect(code.textContent).toBe(longLine);
    expect(code.querySelector(".token")).toBeNull();
  });

  it("按选择的主题动态替换 Prism 配色样式", async () => {
    invoke.mockResolvedValue({ content: "const value = 1;", encoding: "UTF-8", totalBytes: 1, readable: true, reason: null });
    const { rerender } = render(<TextPreview file={file} languageMap={{ ".ts": "typescript" }} codeTheme="tomorrow" />);

    await waitFor(() => expect(document.getElementById("file-sweeper-prism-theme")).toBeTruthy());
    rerender(<TextPreview file={file} languageMap={{ ".ts": "typescript" }} codeTheme="solarizedlight" />);
    await waitFor(() => expect(document.querySelectorAll("#file-sweeper-prism-theme")).toHaveLength(1));
  });

  it("按设置组合英文和中文字体", async () => {
    invoke.mockResolvedValue({ content: "const value = 1;", encoding: "UTF-8", totalBytes: 1, readable: true, reason: null });
    const { container } = render(
      <TextPreview
        file={file}
        languageMap={{ ".ts": "typescript" }}
        codeTheme="tomorrow"
        latinFont="JetBrains Mono"
        cjkFont="Microsoft YaHei UI"
      />,
    );

    await screen.findByText("UTF-8");
    const preview = container.querySelector<HTMLElement>(".text-preview");
    expect(preview).not.toBeNull();
    expect(preview?.style.fontFamily).toBe('"JetBrains Mono", "Microsoft YaHei UI", monospace');
  });
});
