export type DiffLineKind = 'add' | 'delete' | 'context' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  lines: DiffLine[];
}

function filePath(line: string): string | undefined {
  const value = line.slice(4).split('\t')[0];
  if (!value || value === '/dev/null') return undefined;
  return value.replace(/^[ab]\//, '');
}

function hunkStart(line: string): { oldLine: number; newLine: number } | undefined {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) return undefined;
  return { oldLine: Number(match[1]), newLine: Number(match[2]) };
}

/**
 * Converts a unified diff into display-ready files and line numbers. Git metadata
 * remains available so binary and mode-only changes do not silently disappear.
 */
export function parseUnifiedDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  let oldLine = 0;
  let newLine = 0;

  for (const content of diff.split('\n')) {
    if (content.startsWith('diff --git ')) {
      if (current) files.push(current);
      current = { path: 'Unknown file', lines: [] };
      oldLine = 0;
      newLine = 0;
      continue;
    }

    if (!current) continue;

    if (content.startsWith('--- ')) {
      current.oldPath = filePath(content);
      continue;
    }
    if (content.startsWith('+++ ')) {
      current.path = filePath(content) ?? current.oldPath ?? 'Unknown file';
      continue;
    }

    const start = hunkStart(content);
    if (start) {
      oldLine = start.oldLine;
      newLine = start.newLine;
      current.lines.push({ kind: 'meta', content });
      continue;
    }

    if (content.startsWith('+') && !content.startsWith('+++')) {
      current.lines.push({ kind: 'add', content: content.slice(1), newLine });
      newLine += 1;
      continue;
    }
    if (content.startsWith('-') && !content.startsWith('---')) {
      current.lines.push({ kind: 'delete', content: content.slice(1), oldLine });
      oldLine += 1;
      continue;
    }
    if (content.startsWith(' ')) {
      current.lines.push({ kind: 'context', content: content.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    if (content) current.lines.push({ kind: 'meta', content });
  }

  if (current) files.push(current);
  return files;
}
