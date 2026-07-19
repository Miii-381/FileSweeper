import { Plus, SlidersHorizontal, Star } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { AppConfig, DirectoryEntry, TreeState } from "../../app-types";
import { DirectoryTreeNode } from "../../components/DirectoryTreeNode";

export function NavigationPanel({
  config,
  roots,
  selectedPath,
  expandedPaths,
  treeState,
  onChooseFavorite,
  onSelectPath,
  onTogglePath,
  onContextMenu,
  onOpenSettings,
}: {
  config: AppConfig;
  roots: DirectoryEntry[];
  selectedPath: string | null;
  expandedPaths: Set<string>;
  treeState: TreeState;
  onChooseFavorite: () => void;
  onSelectPath: (path: string) => void;
  onTogglePath: (path: string) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>, entry: DirectoryEntry) => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside className="navigation-panel">
      <section className="nav-section favorites-section">
        <div className="section-heading">
          <span>收藏夹</span>
          <button className="quiet-icon-button" type="button" aria-label="添加收藏夹" title="添加收藏夹" onClick={onChooseFavorite}>
            <Plus size={16} />
          </button>
        </div>
        {config.favorites.length === 0 ? (
          <div className="nav-empty">尚无收藏</div>
        ) : (
          <div className="nav-list">
            {config.favorites.map((favorite) => (
              <button
                className={`nav-row ${selectedPath === favorite.path ? "active" : ""}`}
                type="button"
                key={favorite.path}
                title={favorite.path}
                onClick={() => onSelectPath(favorite.path)}
                onContextMenu={(event) => onContextMenu(event, { ...favorite, hasChildren: true, canRecycle: false })}
              >
                <Star size={16} />
                <span>{favorite.name}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="nav-section tree-section">
        <div className="section-heading"><span>此电脑</span></div>
        <ul className="directory-tree">
          {roots.map((root) => (
            <DirectoryTreeNode
              entry={root}
              depth={0}
              key={root.path}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              treeState={treeState}
              onSelect={onSelectPath}
              onToggle={onTogglePath}
              onContextMenu={onContextMenu}
            />
          ))}
        </ul>
      </section>

      <div className="navigation-footer">
        <button className="nav-row" type="button" onClick={onOpenSettings}>
          <SlidersHorizontal size={16} />
          <span>偏好设置</span>
        </button>
      </div>
    </aside>
  );
}
