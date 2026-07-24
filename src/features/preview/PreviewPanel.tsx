import { Panel, PanelResizeHandle } from "react-resizable-panels";
import type { RefObject } from "react";
import { PreviewPlayer, type PreviewPlayerHandle } from "../../components/PreviewPlayer";
import { isFileEntry, type CodeTheme, type DirectoryItem, type FileEntry } from "../../app-types";
import { FileDetails } from "./FileDetails";
import { ImagePreview, PreviewError } from "./ImagePreview";
import { TextPreview } from "./TextPreview";

type Props = {
  playerRef: RefObject<PreviewPlayerHandle | null>;
  item: DirectoryItem | null;
  thumbnailPath: string | null;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  metadataLoading: boolean;
  onEnsureThumbnail: (file: FileEntry) => void;
  onAudioPreferenceChange: (volume: number, muted: boolean) => void;
  textLanguageMap: Record<string, string>;
  codeTheme: CodeTheme;
  textPreviewLatinFont: string;
  textPreviewCjkFont: string;
};

export function PreviewPanel({
  playerRef,
  item,
  thumbnailPath,
  autoplay,
  volume,
  muted,
  metadataLoading,
  onEnsureThumbnail,
  onAudioPreferenceChange,
  textLanguageMap,
  codeTheme,
  textPreviewLatinFont,
  textPreviewCjkFont,
}: Props) {
  const file = item && isFileEntry(item) ? item : null;
  return (
    <>
      <PanelResizeHandle className="panel-resize-handle" aria-label="调整预览栏宽度" />
      <Panel defaultSize={26} minSize={0}>
        <aside
          className="preview-panel"
          tabIndex={0}
          aria-label="文件预览和文件信息"
          onMouseDown={(event) => {
            if (event.target instanceof Element && !event.target.closest("button, input, select, a, [contenteditable='true']")) {
              event.currentTarget.focus();
            }
          }}
          onKeyDown={(event) => {
            if (event.target instanceof Element && event.target.closest("button, input, select, a, [contenteditable='true']")) {
              return;
            }
            if (event.key === " " || event.key === "Spacebar") {
              event.preventDefault();
              event.stopPropagation();
              playerRef.current?.togglePlayback();
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              event.stopPropagation();
              playerRef.current?.skipPlayback(-5);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              event.stopPropagation();
              playerRef.current?.skipPlayback(5);
            }
          }}
        >
          {!item ? <div className="preview-placeholder">选择一个项目以预览</div>
            : !file ? <div className="preview-placeholder">已选择文件夹</div>
            : file.kind === "video" ? <PreviewPlayer
              ref={playerRef}
              key={file.path}
              video={file}
              thumbnailPath={thumbnailPath}
              autoplay={autoplay}
              volume={volume}
              muted={muted}
              onEnsureThumbnail={onEnsureThumbnail}
              onAudioPreferenceChange={onAudioPreferenceChange}
            /> : file.kind === "image" ? <ImagePreview key={file.path} file={file} />
            : file.kind === "text" ? <TextPreview file={file} languageMap={textLanguageMap} codeTheme={codeTheme} latinFont={textPreviewLatinFont} cjkFont={textPreviewCjkFont} />
            : <PreviewError message="此文件类型不支持内嵌预览" file={file} />}
          <FileDetails item={item} loading={file?.kind === "video" && metadataLoading} />
        </aside>
      </Panel>
    </>
  );
}
