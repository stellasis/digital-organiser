import fs from 'fs/promises';
import type { Dirent, Stats } from 'fs';
import path from 'path';
import mime from 'mime-types';
import { DirectorySnapshot, FileMetadata } from '../common/fileTypes';
import {
  detectSmartStop,
  readDirectoryEntries,
  type SmartStopMatch,
  type SmartStopContext,
} from '../common/smartStop';

interface WalkOptions {
  /**
   * Collection of discovered files. Mutated as the walk progresses to avoid
   * repeated array allocations.
   */
  accumulator: FileMetadata[];
  smartStopContext: SmartStopContext;
}

const toIsoString = (date: Date) => date.toISOString();

const computeRelativePath = (rootPath: string, entryPath: string) => {
  const relative = path.relative(rootPath, entryPath);
  return relative === '' ? '.' : relative;
};

const isVerboseLoggingEnabled = (() => {
  const value = process.env.AI_LOG_VERBOSE;
  if (!value) {
    return false;
  }

  const normalised = value.toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(normalised);
})();

const verboseLog = (message: string) => {
  if (isVerboseLoggingEnabled) {
    // eslint-disable-next-line no-console
    console.log(message);
  }
};

const buildFileMetadata = (
  filePath: string,
  rootPath: string,
  stats: Stats,
): FileMetadata => {
  const relativePath = computeRelativePath(rootPath, filePath);
  const mimeType = mime.lookup(filePath) || null;

  return {
    type: 'file',
    path: filePath,
    name: path.basename(filePath),
    relativePath,
    size: stats.size,
    lastModified: toIsoString(stats.mtime),
    mimeType,
    flags: [],
    note: null,
  };
};

const buildDirectoryMetadata = (
  directoryPath: string,
  rootPath: string,
  stats: Stats,
  match: SmartStopMatch,
): FileMetadata => {
  const relativePath = computeRelativePath(rootPath, directoryPath);

  return {
    type: 'dir',
    path: directoryPath,
    name: path.basename(directoryPath),
    relativePath,
    size: stats.size,
    lastModified: toIsoString(stats.mtime),
    mimeType: null,
    flags: [match.rule.flag],
    note: match.rule.note,
  };
};

const walkDirectory = async (
  currentPath: string,
  rootPath: string,
  options: WalkOptions,
): Promise<void> => {
  const entries = await readDirectoryEntries(currentPath, options.smartStopContext);

  const smartStopMatch = await detectSmartStop({
    dirPath: currentPath,
    entries,
    context: options.smartStopContext,
  });

  if (smartStopMatch) {
    try {
      const stats = await fs.stat(currentPath);
      options.accumulator.push(
        buildDirectoryMetadata(currentPath, rootPath, stats, smartStopMatch),
      );
      verboseLog(
        `🧠 [SmartScanner] Stop traversal at: ${path.basename(
          currentPath,
        )} (reason: ${smartStopMatch.rule.flag})`,
      );
    } catch {
      // Ignore unreadable directories while keeping the scan going.
    }
    return;
  }

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

  await walkDirectory(absoluteRoot, absoluteRoot, {
    accumulator: files,
    smartStopContext: { directoryCache: new Map<string, Dirent[]>() },
  });

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    rootPath: absoluteRoot,
    files,
  };
};

export type { DirectorySnapshot, FileMetadata } from '../common/fileTypes';
