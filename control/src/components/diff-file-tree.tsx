'use client';

import { useMemo } from 'react';
import { hotkeysCoreFeature, syncDataLoaderFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { FileCode2, FileText, Folder, FolderOpen } from 'lucide-react';
import { Tree, TreeItem, TreeItemLabel } from '@/components/reui/tree';
import { cn } from '@/lib/utils';
import type { DiffFile } from '@/lib/unified-diff';

interface FileTreeItem {
  name: string;
  path?: string;
  children?: string[];
}

interface DiffFileTreeProps {
  files: DiffFile[];
  selectedPath?: string;
  onSelect: (path: string) => void;
}

function fileIcon(path: string, expanded: boolean, folder: boolean) {
  if (folder) {
    return expanded ? (
      <FolderOpen className="size-3.5 text-amber-500" />
    ) : (
      <Folder className="size-3.5 text-amber-500" />
    );
  }
  if (/\.[cm]?[jt]sx?$/.test(path)) return <FileCode2 className="size-3.5 text-sky-500" />;
  return <FileText className="size-3.5 text-muted-foreground" />;
}

function createTree(files: DiffFile[]) {
  const items: Record<string, FileTreeItem> = {
    root: { name: 'Changed files', children: [] },
  };

  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    let parentId = 'root';
    let accumulatedPath = '';

    for (const [index, part] of parts.entries()) {
      accumulatedPath = accumulatedPath ? `${accumulatedPath}/${part}` : part;
      const isFile = index === parts.length - 1;
      const itemId = isFile ? `file:${file.path}` : `folder:${accumulatedPath}`;
      const parent = items[parentId];
      if (!parent.children?.includes(itemId)) parent.children?.push(itemId);

      if (!items[itemId]) {
        items[itemId] = isFile
          ? { name: part, path: file.path }
          : { name: part, children: [] };
      }
      parentId = itemId;
    }
  }

  return items;
}

export function DiffFileTree({ files, selectedPath, onSelect }: DiffFileTreeProps) {
  const items = useMemo(() => createTree(files), [files]);
  const expandedItems = useMemo(
    () => Object.keys(items).filter((id) => id === 'root' || id.startsWith('folder:')),
    [items],
  );
  const tree = useTree<FileTreeItem>({
    initialState: { expandedItems },
    rootItemId: 'root',
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => (item.getItemData().children?.length ?? 0) > 0,
    dataLoader: {
      getItem: (itemId) => items[itemId],
      getChildren: (itemId) => items[itemId].children ?? [],
    },
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });

  return (
    <Tree indent={14} tree={tree} className="w-max min-w-full gap-0.5">
      {tree.getItems().map((item) => {
        const data = item.getItemData();
        const folder = item.isFolder();
        const selected = data.path === selectedPath;
        return (
          <TreeItem
            key={item.getId()}
            item={item}
            onClick={() => {
              if (data.path) onSelect(data.path);
            }}
          >
            <TreeItemLabel
              className={cn(
                'w-max min-w-full whitespace-nowrap py-1 text-xs [&_svg]:size-3.5',
                selected && 'bg-accent text-accent-foreground',
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {fileIcon(data.path ?? data.name, item.isExpanded(), folder)}
                <span className="truncate">{data.name}</span>
              </span>
            </TreeItemLabel>
          </TreeItem>
        );
      })}
    </Tree>
  );
}
