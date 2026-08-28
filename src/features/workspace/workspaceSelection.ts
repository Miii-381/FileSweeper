export function findNextPathAfterRemoval(
  orderedPaths: readonly string[],
  removedPaths: ReadonlySet<string>,
  focusedPath: string,
) {
  const focusedIndex = orderedPaths.indexOf(focusedPath);
  if (focusedIndex < 0 || !removedPaths.has(focusedPath)) {
    return null;
  }

  for (let index = focusedIndex + 1; index < orderedPaths.length; index += 1) {
    const candidate = orderedPaths[index];
    if (!removedPaths.has(candidate)) {
      return candidate;
    }
  }

  for (let index = focusedIndex - 1; index >= 0; index -= 1) {
    const candidate = orderedPaths[index];
    if (!removedPaths.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function calculateWorkspaceSelectionGeometry({
  rootLeft,
  rootTop,
  scrollLeft,
  scrollTop,
  startContentX,
  startContentY,
  clientX,
  clientY,
}: {
  rootLeft: number;
  rootTop: number;
  scrollLeft: number;
  scrollTop: number;
  startContentX: number;
  startContentY: number;
  clientX: number;
  clientY: number;
}) {
  const currentContentX = clientX - rootLeft + scrollLeft;
  const currentContentY = clientY - rootTop + scrollTop;
  const left = Math.min(startContentX, currentContentX);
  const top = Math.min(startContentY, currentContentY);
  const width = Math.abs(currentContentX - startContentX);
  const height = Math.abs(currentContentY - startContentY);
  return {
    contentBox: { left, top, width, height },
    viewportBox: {
      left: left - scrollLeft + rootLeft,
      top: top - scrollTop + rootTop,
      width,
      height,
    },
  };
}
