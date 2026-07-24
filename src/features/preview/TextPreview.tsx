import { invoke } from "@tauri-apps/api/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import Prism from "prismjs";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-json";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-powershell";
import "prismjs/components/prism-python";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-yaml";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";

import type { CodeTheme, FileEntry } from "../../app-types";
import { errorMessage } from "../../app-utils";
import { PreviewError } from "./ImagePreview";

const TEXT_LINE_HEIGHT = 20;
const TEXT_OVERSCAN = 12;
const LONG_LINE_HIGHLIGHT_LIMIT = 256 * 1024;
const PRISM_THEME_STYLE_ID = "file-sweeper-prism-theme";

const prismThemeLoaders: Record<CodeTheme, () => Promise<{ default: string }>> = {
  default: () => import("prismjs/themes/prism.css?raw"),
  dark: () => import("prismjs/themes/prism-dark.css?raw"),
  funky: () => import("prismjs/themes/prism-funky.css?raw"),
  okaidia: () => import("prismjs/themes/prism-okaidia.css?raw"),
  tomorrow: () => import("prismjs/themes/prism-tomorrow.css?raw"),
  twilight: () => import("prismjs/themes/prism-twilight.css?raw"),
  coy: () => import("prismjs/themes/prism-coy.css?raw"),
  solarizedlight: () => import("prismjs/themes/prism-solarizedlight.css?raw"),
};

type TextPreviewData = { content: string; encoding: string; totalBytes: number; readable: boolean; reason: string | null };

function exceedsHighlightLimit(line: string) {
  if (line.length > LONG_LINE_HIGHLIGHT_LIMIT) {
    return true;
  }
  let byteLength = 0;
  for (const character of line) {
    const codePoint = character.codePointAt(0)!;
    byteLength += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (byteLength > LONG_LINE_HIGHLIGHT_LIMIT) {
      return true;
    }
  }
  return false;
}

function usePrismTheme(codeTheme: CodeTheme) {
  useEffect(() => {
    let active = true;
    void prismThemeLoaders[codeTheme]().then(({ default: css }) => {
      if (!active) return;
      let style = document.getElementById(PRISM_THEME_STYLE_ID) as HTMLStyleElement | null;
      if (!style) {
        style = document.createElement("style");
        style.id = PRISM_THEME_STYLE_ID;
        document.head.append(style);
      }
      style.textContent = css;
    });
    return () => { active = false; };
  }, [codeTheme]);
}

export function TextPreview({ file, languageMap, codeTheme, latinFont = "Consolas", cjkFont = "Microsoft YaHei" }: { file: FileEntry; languageMap: Record<string, string>; codeTheme: CodeTheme; latinFont?: string; cjkFont?: string }) {
  const [data, setData] = useState<TextPreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollElement = useRef<HTMLDivElement>(null);
  usePrismTheme(codeTheme);
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    void invoke<TextPreviewData>("read_text_preview", { path: file.path })
      .then((result) => active && setData(result))
      .catch((reason) => active && setError(errorMessage(reason)));
    return () => { active = false; };
  }, [file.path]);

  const language = languageMap[file.extension] ?? "plain";
  const lines = useMemo(() => data?.content.split("\n") ?? [], [data]);
  const rowVirtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollElement.current,
    estimateSize: () => TEXT_LINE_HEIGHT,
    overscan: TEXT_OVERSCAN,
    initialRect: { width: 0, height: 400 },
  });

  useEffect(() => {
    scrollElement.current?.scrollTo({ top: 0, left: 0 });
    rowVirtualizer.scrollToOffset(0);
  }, [file.path, rowVirtualizer]);

  if (error) return <PreviewError message={error} file={file} />;
  if (!data) return <div className="preview-placeholder">正在读取文本…</div>;
  if (!data.readable) return <PreviewError message={data.reason ?? "该文件不是可读文本"} file={file} />;
  const grammar = Prism.languages[language] ?? Prism.languages.plain;
  const virtualRows = rowVirtualizer.getVirtualItems();
  const visibleRows = virtualRows.length > 0
    ? virtualRows
    : lines.slice(0, TEXT_OVERSCAN).map((_, index) => ({ index, key: index, size: TEXT_LINE_HEIGHT, start: index * TEXT_LINE_HEIGHT }));
  return <section className="text-preview" style={{ fontFamily: `"${latinFont}", "${cjkFont}", monospace` } as CSSProperties}>
    <header>{data.encoding}</header>
    <div ref={scrollElement} className="text-preview-scroll" aria-label="文本内容">
      <div className="text-preview-virtual-content" style={{ height: rowVirtualizer.getTotalSize() }}>
        {visibleRows.map((virtualRow) => {
          const line = lines[virtualRow.index];
          const plainText = exceedsHighlightLimit(line);
          return <div
            className="text-preview-row"
            data-testid="text-preview-row"
            key={virtualRow.key}
            style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
          >
            <span className="text-preview-line-number">{virtualRow.index + 1}</span>
            {plainText ? <code className="text-preview-code">{line}</code> : <code className="text-preview-code" dangerouslySetInnerHTML={{ __html: Prism.highlight(line, grammar, language) }} />}
            {plainText && <span className="text-preview-highlight-notice">该超长行未进行语法高亮</span>}
          </div>;
        })}
      </div>
    </div>
  </section>;
}
