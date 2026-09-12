import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkspaceToolbar } from "./WorkspaceToolbar";

function renderToolbar(navigationOpen: boolean, previewOpen: boolean) {
  const onToggleNavigation = vi.fn();
  const onTogglePreview = vi.fn();
  render(
    <WorkspaceToolbar
      workspacePath="D:\\media"
      sortKey="name"
      sortAscending
      viewMode="grid"
      previewOpen={previewOpen}
      navigationOpen={navigationOpen}
      metadataLoading={false}
      onSortKeyChange={vi.fn()}
      onToggleSortDirection={vi.fn()}
      onViewModeChange={vi.fn()}
      onTogglePreview={onTogglePreview}
      onToggleNavigation={onToggleNavigation}
      canNavigateBack={false}
      canNavigateForward={false}
      canNavigateUp
      onNavigateBack={vi.fn()}
      onNavigateForward={vi.fn()}
      onNavigateUp={vi.fn()}
      onNavigateTo={vi.fn()}
    />,
  );
  return { onToggleNavigation, onTogglePreview };
}

describe("WorkspaceToolbar", () => {
  it("提供左右栏折叠入口", () => {
    const { onToggleNavigation, onTogglePreview } = renderToolbar(true, true);

    fireEvent.click(screen.getByRole("button", { name: "折叠左侧导航栏" }));
    fireEvent.click(screen.getByRole("button", { name: "折叠右侧预览栏" }));

    expect(onToggleNavigation).toHaveBeenCalledOnce();
    expect(onTogglePreview).toHaveBeenCalledOnce();
  });

  it("左右栏收起后显示对应的展开入口", () => {
    renderToolbar(false, false);

    expect(screen.getByRole("button", { name: "展开左侧导航栏" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "展开右侧预览栏" })).toBeTruthy();
  });
});
