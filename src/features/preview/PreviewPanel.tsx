import { Panel, PanelResizeHandle } from "react-resizable-panels";
import type { RefObject } from "react";
import { PreviewPlayer, type PreviewPlayerHandle } from "../../components/PreviewPlayer";
import type { VideoEntry } from "../../app-types";
import { VideoDetails } from "./VideoDetails";

type Props = {
  playerRef: RefObject<PreviewPlayerHandle | null>;
  video: VideoEntry | null;
  thumbnailPath: string | null;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  metadataLoading: boolean;
  onEnsureThumbnail: (video: VideoEntry) => void;
  onAudioPreferenceChange: (volume: number, muted: boolean) => void;
};

export function PreviewPanel({
  playerRef,
  video,
  thumbnailPath,
  autoplay,
  volume,
  muted,
  metadataLoading,
  onEnsureThumbnail,
  onAudioPreferenceChange,
}: Props) {
  return (
    <>
      <PanelResizeHandle className="panel-resize-handle" aria-label="调整预览栏宽度" />
      <Panel defaultSize={26} minSize={0}>
        <aside
          className="preview-panel"
          tabIndex={0}
          aria-label="视频预览和文件信息"
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
          <PreviewPlayer
            ref={playerRef}
            key={video?.path ?? "empty-preview"}
            video={video}
            thumbnailPath={thumbnailPath}
            autoplay={autoplay}
            volume={volume}
            muted={muted}
            onEnsureThumbnail={onEnsureThumbnail}
            onAudioPreferenceChange={onAudioPreferenceChange}
          />
          <VideoDetails video={video} loading={metadataLoading} />
        </aside>
      </Panel>
    </>
  );
}
