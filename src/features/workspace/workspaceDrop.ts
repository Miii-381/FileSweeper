function normalizeComparablePath(path: string) {
  return path
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/, "")
    .toLocaleLowerCase();
}

function parentPath(path: string) {
  const normalized = normalizeComparablePath(path);
  const separator = normalized.lastIndexOf("\\");
  if (separator < 0) return null;
  return normalized.slice(0, separator);
}

/**
 * Removes items that already belong to the drop destination. This prevents an
 * internal drag from creating duplicate copies while preserving cross-folder drops.
 */
export function filterCrossFolderDropPaths(paths: string[], destinationPath: string) {
  const normalizedDestination = normalizeComparablePath(destinationPath);
  return paths.filter((path) => {
    const normalizedPath = normalizeComparablePath(path);
    return normalizedPath !== normalizedDestination && parentPath(path) !== normalizedDestination;
  });
}
