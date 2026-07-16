import { ChevronDown, ChevronRight, Folder, FolderOpen, HardDrive } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { DirectoryEntry, TreeState } from "../app-types";

export function DirectoryTreeNode({
  entry,
  depth,
  selectedPath,
  expandedPaths,
  treeState,
  onSelect,
  onToggle,
  onContextMenu,
}: {
  entry: DirectoryEntry;
  depth: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  treeState: TreeState;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, path: string) => void;
}) {
  const isExpanded = expandedPaths.has(entry.path);
  const state = treeState[entry.path];
  const isRoot = depth === 0;

  return (
    <li className="tree-node">
      <div className={`tree-row ${selectedPath === entry.path ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 16 }}>
        {entry.hasChildren ? (
          <button
            className="tree-disclosure"
            type="button"
            aria-label={isExpanded ? `收起 ${entry.name}` : `展开 ${entry.name}`}
            title={isExpanded ? "收起" : "展开"}
            onClick={() => onToggle(entry.path)}
          >
            {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        ) : (
          <span className="tree-disclosure-spacer" aria-hidden="true" />
        )}
        <button
          className="tree-label"
          type="button"
          title={entry.path}
          aria-current={selectedPath === entry.path ? "page" : undefined}
          onClick={() => onSelect(entry.path)}
          onContextMenu={(event) => onContextMenu(event, entry.path)}
        >
          {isRoot ? <HardDrive size={16} /> : isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />}
          <span>{entry.name}</span>
        </button>
      </div>

      {isExpanded && state?.status === "loading" && <div className="tree-status">正在读取…</div>}
      {isExpanded && state?.status === "error" && <div className="tree-status">无法读取</div>}
      {isExpanded && state?.status === "loaded" && state.folders.length > 0 && (
        <ul className="tree-children">
          {state.folders.map((child) => (
            <DirectoryTreeNode
              entry={child}
              depth={depth + 1}
              key={child.path}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              treeState={treeState}
              onSelect={onSelect}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
