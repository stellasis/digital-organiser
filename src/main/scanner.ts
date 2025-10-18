import fs from 'fs/promises';
import type { Stats } from 'fs';
import path from 'path';
import mime from 'mime-types';
import { DirectorySnapshot, FileMetadata } from '../common/fileTypes';

interface WalkOptions {
  /**
   * Collection of discovered files. Mutated as the walk progresses to avoid
   * repeated array allocations.
   */
  accumulator: FileMetadata[];
}

const toIsoString = (date: Date) => date.toISOString();

const buildFileMetadata = (
  filePath: string,
  rootPath: string,
  stats: Stats,
): FileMetadata => {
  const relativePath = path.relative(rootPath, filePath);
  const mimeType = mime.lookup(filePath) || null;

  return {
    path: filePath,
    name: path.basename(filePath),
    relativePath,
    size: stats.size,
    lastModified: toIsoString(stats.mtime),
    mimeType,
  };
};

const walkDirectory = async (
  currentPath: string,
  rootPath: string,
  options: WalkOptions,
): Promise<void> => {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(currentPath, entry.name);

      if (entry.isSymbolicLink()) {
        return;
      }

      if (entry.isDirectory()) {
        await walkDirectory(entryPath, rootPath, options);
        return;
      }

      if (!entry.isFile()) {
        return;
      }

      try {
        const stats = await fs.stat(entryPath);
        options.accumulator.push(buildFileMetadata(entryPath, rootPath, stats));
      } catch {
        // Ignore unreadable files while keeping the scan going.
      }
    }),
  );
};

export const scanDirectory = async (
  rootPath: string,
): Promise<DirectorySnapshot> => {
  const absoluteRoot = path.resolve(rootPath);
  const files: FileMetadata[] = [];

  await walkDirectory(absoluteRoot, absoluteRoot, { accumulator: files });

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    rootPath: absoluteRoot,
    files,
  };
};

export type { DirectorySnapshot, FileMetadata } from '../common/fileTypes';
