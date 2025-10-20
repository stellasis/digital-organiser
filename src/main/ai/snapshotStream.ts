import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import type { AiSnapshotEntry } from '../../types/ai';
import { normaliseRelativePath, shouldIgnorePath } from './ignoreRules';

export interface SnapshotStreamOptions {
  rootPath: string;
  ignore?: (relativePath: string, isDirectory: boolean) => boolean;
}

interface StackItem {
  absolutePath: string;
  relativePath: string;
  depth: number;
}

const sortEntries = (entries: Dirent[]): Dirent[] =>
  [...entries].sort((a, b) => a.name.localeCompare(b.name));

export async function* streamSnapshotEntries({
  rootPath,
  ignore = shouldIgnorePath,
}: SnapshotStreamOptions): AsyncGenerator<AiSnapshotEntry> {
  const resolvedRoot = path.resolve(rootPath);
  const stats = await fs.lstat(resolvedRoot);
  if (!stats.isDirectory()) {
    throw new Error(`Root path ${resolvedRoot} is not a directory`);
  }

  const stack: StackItem[] = [
    { absolutePath: resolvedRoot, relativePath: '', depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    const { absolutePath, relativePath, depth } = current;
    const entryStats = await fs.lstat(absolutePath);
    const name = relativePath ? path.basename(absolutePath) : path.basename(absolutePath) || absolutePath;

    if (!entryStats.isDirectory()) {
      yield {
        path: relativePath,
        name,
        kind: 'file',
        depth,
      };
      continue;
    }

    const dirEntries = sortEntries(await fs.readdir(absolutePath, { withFileTypes: true }));
    const filtered = dirEntries.filter((entry) => {
      if (entry.isSymbolicLink()) {
        return false;
      }
      if (!entry.isDirectory() && !entry.isFile()) {
        return false;
      }
      const entryPath = path.join(absolutePath, entry.name);
      const entryRelative = normaliseRelativePath(resolvedRoot, entryPath);
      if (ignore(entryRelative, entry.isDirectory())) {
        return false;
      }
      return true;
    });

    const childrenNames = filtered.map((entry) => entry.name);
    yield {
      path: relativePath,
      name: relativePath ? path.basename(absolutePath) : path.basename(resolvedRoot) || path.basename(absolutePath),
      kind: 'folder',
      depth,
      children: childrenNames,
    };

    for (let index = filtered.length - 1; index >= 0; index -= 1) {
      const entry = filtered[index];
      const entryPath = path.join(absolutePath, entry.name);
      const entryRelative = normaliseRelativePath(resolvedRoot, entryPath);
      stack.push({
        absolutePath: entryPath,
        relativePath: entryRelative,
        depth: depth + 1,
      });
    }
  }
}

