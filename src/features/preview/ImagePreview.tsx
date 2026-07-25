import { invoke } from "@tauri-apps/api/core";
import { RotateCcw, RotateCw, Scan, ZoomIn, ZoomOut } from "lucide-react";
import {
  TransformComponent,
  TransformWrapper,
  type ReactZoomPanPinchContentRef,
} from "react-zoom-pan-pinch";
import { useEffect, useRef, useState } from "react";

import type { FileEntry } from "../../app-types";
import { errorMessage, writeClientLog } from "../../app-utils";

type ImagePreviewInfo = { width: number; height: number; allowed: boolean; reason: string | null };

function fitImage(
  controls: ReactZoomPanPinchContentRef,
  image: HTMLImageElement,
  rotation: number,
  animationTime = 0,
) {
  const canvas = controls.instance.wrapperComponent;
  if (!canvas || image.naturalWidth === 0 || image.naturalHeight === 0) return;
  const rotatedSideways = Math.abs(rotation % 180) === 90;
  const width = rotatedSideways ? image.naturalHeight : image.naturalWidth;
  const height = rotatedSideways ? image.naturalWidth : image.naturalHeight;
  controls.centerView(Math.min(canvas.clientWidth / width, canvas.clientHeight / height), animationTime);
}

function formatScale(scale: number) {
  const percentage = scale * 100;
  return `${percentage >= 10 ? Math.round(percentage) : Number(percentage.toFixed(2))}%`;
}

function rotateBy(rotation: number, delta: number) {
  return (rotation + delta + 360) % 360;
}

export function ImagePreview({ file }: { file: FileEntry }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotation, setRotation] = useState(0);
  const [scale, setScale] = useState(1);
  const imageRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let active = true;
    setSource(null);
    setError(null);
    setRotation(0);
    setScale(1);
    writeClientLog("debug", `开始加载图片预览模块资源：${file.path}`);
    void Promise.all([
      invoke<ImagePreviewInfo>("inspect_image_preview", { path: file.path }),
      invoke<string>("get_preview_file_url", { path: file.path }),
    ]).then(([info, url]) => {
      if (!active) return;
      if (!info.allowed) {
        writeClientLog("warn", `图片预览被保护策略拒绝：${file.path}，${info.reason ?? "未知原因"}`);
        setError(info.reason ?? "图片不满足预览保护条件");
        return;
      }
      writeClientLog("debug", `图片预览资源已就绪：${file.path}，${info.width} × ${info.height}`);
      setSource(url);
    }).catch((reason) => {
      if (!active) return;
      const message = errorMessage(reason);
      writeClientLog("error", `图片预览模块加载失败：${file.path}，${message}`);
      setError(message);
    });
    return () => { active = false; };
  }, [file.path]);

  if (error) return <PreviewError message={error} file={file} />;
  if (!source) return <div className="preview-placeholder">正在读取图片…</div>;
  return (
    <TransformWrapper
      minScale={0.01}
      maxScale={Number.MAX_VALUE}
      limitToBounds
      onWheelStart={(ref) => ref.instance.contentComponent?.classList.add("is-wheel-zooming")}
      onWheelStop={(ref) => ref.instance.contentComponent?.classList.remove("is-wheel-zooming")}
      onPanningStart={(ref) => ref.instance.contentComponent?.classList.remove("is-wheel-zooming")}
      onTransformed={(_, state) => setScale(state.scale)}
    >
      {(controls) => (
        <section className="image-preview">
          <div className="image-preview-toolbar">
            <button type="button" onClick={() => controls.zoomOut()} title="缩小"><ZoomOut size={16} /></button>
            <button type="button" onClick={() => controls.zoomIn()} title="放大"><ZoomIn size={16} /></button>
            <button type="button" onClick={() => controls.centerView(1)} title="100%">100%</button>
            <button
              type="button"
              onClick={() => {
                setRotation(0);
                if (imageRef.current) fitImage(controls, imageRef.current, 0, 200);
              }}
              title="适应窗口"
            >
              <Scan size={16} />
            </button>
            <button type="button" onClick={() => setRotation((value) => rotateBy(value, -90))} title="逆时针旋转"><RotateCcw size={16} /></button>
            <button type="button" onClick={() => setRotation((value) => rotateBy(value, 90))} title="顺时针旋转"><RotateCw size={16} /></button>
          </div>
          <div className="image-preview-stage">
            <TransformComponent wrapperClass="image-preview-canvas" contentClass="image-preview-content">
              <img
                ref={imageRef}
                src={source}
                alt={file.name}
                draggable={false}
                style={{ transform: `rotate(${rotation}deg)` }}
                onLoad={(event) => {
                  const image = event.currentTarget;
                  requestAnimationFrame(() => fitImage(controls, image, rotation));
                }}
                onError={() => setError("浏览器无法解码此图片")}
              />
            </TransformComponent>
            <div className="image-preview-status" role="status" aria-live="polite">
              <span>旋转 {rotation}°</span>
              <span aria-hidden="true">·</span>
              <span>缩放 {formatScale(scale)}</span>
            </div>
          </div>
        </section>
      )}
    </TransformWrapper>
  );
}

export function PreviewError({ message, file, onRetry }: { message: string; file?: FileEntry; onRetry?: () => void }) {
  return <div className="preview-placeholder preview-error">
    <span>无法预览：{message}</span>
    {onRetry && <button className="command-button" type="button" onClick={onRetry}>重试</button>}
    {file && <button className="command-button" type="button" onClick={() => void invoke("open_file_externally", { path: file.path })}>用系统程序打开</button>}
  </div>;
}
