import { invoke } from "@tauri-apps/api/core";
import { Folder } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { FileEntry, FolderEntry, FolderThumbnailSources } from "../app-types";
import { writeClientLog } from "../app-utils";
import { FileThumbnail } from "./FileThumbnail";

const pendingPaths = new Set<string>();
const pendingResolvers = new Map<string, Array<(files: FileEntry[]) => void>>();
let dispatchScheduled = false;

function requestFolderSources(path: string) {
  return new Promise<FileEntry[]>((resolve) => {
    const resolvers = pendingResolvers.get(path) ?? [];
    resolvers.push(resolve);
    pendingResolvers.set(path, resolvers);
    pendingPaths.add(path);
    if (dispatchScheduled) return;
    dispatchScheduled = true;
    queueMicrotask(() => {
      dispatchScheduled = false;
      const paths = [...pendingPaths];
      pendingPaths.clear();
      void invoke<FolderThumbnailSources[]>("list_folder_thumbnail_sources", { paths })
        .then((results) => {
          const byPath = new Map(results.map((result) => [result.folderPath, result.files]));
          paths.forEach((folderPath) => {
            const callbacks = pendingResolvers.get(folderPath) ?? [];
            pendingResolvers.delete(folderPath);
            callbacks.forEach((callback) => callback(byPath.get(folderPath) ?? []));
          });
        })
        .catch((error: unknown) => {
          writeClientLog("warn", `读取文件夹缩略图来源失败：${paths.length} 个文件夹，${error instanceof Error ? error.message : String(error)}`);
          paths.forEach((folderPath) => {
            const callbacks = pendingResolvers.get(folderPath) ?? [];
            pendingResolvers.delete(folderPath);
            callbacks.forEach((callback) => callback([]));
          });
        });
    });
  });
}

export const FolderThumbnail = memo(function FolderThumbnail({
  folder,
  thumbnailPathOverrides,
  visibilityRevision,
  onEnsureThumbnail,
}: {
  folder: FolderEntry;
  thumbnailPathOverrides: Map<string, string>;
  visibilityRevision: number;
  onEnsureThumbnail: (file: FileEntry) => void;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [files, setFiles] = useState<FileEntry[] | null>(null);

  useEffect(() => {
    setFiles(null);
    const target = element.current;
    if (!target) return;
    let active = true;
    const contentRevision = folder.modifiedAt ?? 0;
    const load = () => {
      writeClientLog("debug", `请求文件夹缩略图来源：${folder.path}，内容版本 ${contentRevision}`);
      void requestFolderSources(folder.path).then((sources) => {
        if (!active) {
          writeClientLog("debug", `忽略已过期的文件夹缩略图来源：${folder.path}，内容版本 ${contentRevision}`);
          return;
        }
        setFiles(sources);
        writeClientLog("debug", `文件夹缩略图来源已更新：${folder.path}，内容版本 ${contentRevision}，来源 ${sources.length} 个`);
      });
    };
    if (!("IntersectionObserver" in window)) {
      load();
      return () => { active = false; };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        load();
      }
    }, { rootMargin: "240px 0px" });
    observer.observe(target);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [folder.path, folder.modifiedAt]);

  return (
    <span ref={element} className={`folder-thumbnail ${files && files.length > 0 ? "has-sources" : ""}`}>
      {files && files.length > 0 ? (
        <span className={`folder-thumbnail-stack sources-${files.length}`}>
          {files.map((file) => (
            <FileThumbnail
              key={file.path}
              file={file}
              compact
              thumbnailPath={thumbnailPathOverrides.get(file.path) ?? file.thumbnailPath}
              visibilityRevision={visibilityRevision}
              onVisible={onEnsureThumbnail}
            />
          ))}
        </span>
      ) : <Folder size={34} />}
    </span>
  );
});
