import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { Dirent } from 'fs';
import type { Snapshot, SnapshotNode } from '../types/snapshot';

const normaliseRelative = (relativePath: string) =>
  relativePath.split(path.sep).filter(Boolean).join('/');

const createNodeId = (relativePath: string): string => {
  if (!relativePath) {
    return 'root';
  }
  const hash = crypto.createHash('sha1').update(relativePath).digest('hex');
  return `node-${hash}`;
};

const sortEntries = (entries: Dirent[]): Dirent[] =>
  [...entries].sort((a, b) => a.name.localeCompare(b.name));

const buildSnapshotNode = async (
  absolutePath: string,
  rootPath: string,
): Promise<SnapshotNode> => {
  const stats = await fs.lstat(absolutePath);
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new Error(`Unsupported node type at ${absolutePath}`);
  }

  const relativePath = path.relative(rootPath, absolutePath);
  const normalisedRelative = normaliseRelative(relativePath);
  const id = createNodeId(normalisedRelative);
  const name = normalisedRelative ? path.basename(absolutePath) : path.basename(rootPath) || rootPath;

  if (stats.isFile()) {
    return {
      id,
      name,
      kind: 'file',
    };
  }

  const dirEntries = sortEntries(await fs.readdir(absolutePath, { withFileTypes: true }));
  const children: SnapshotNode[] = [];

  for (const entry of dirEntries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (!entry.isDirectory() && !entry.isFile()) {
      continue;
    }
    const childPath = path.join(absolutePath, entry.name);
    try {
      const childNode = await buildSnapshotNode(childPath, rootPath);
      children.push(childNode);
    } catch {
      // Skip nodes that cannot be read.
    }
  }

  return {
    id,
    name,
    kind: 'folder',
    children,
  };
};

export const generateSnapshot = async (rootPath: string): Promise<Snapshot> => {
  if (!rootPath) {
    throw new Error('Root path is required to generate snapshot');
  }

  const resolvedRoot = path.resolve(rootPath);
  const stats = await fs.lstat(resolvedRoot);
  if (!stats.isDirectory()) {
    throw new Error(`Root path ${resolvedRoot} is not a directory`);
  }

  const tree = await buildSnapshotNode(resolvedRoot, resolvedRoot);
  const now = new Date();

  return {
    rootPath: resolvedRoot,
    tree,
    version: now.toISOString(),
    savedAtIso: now.toISOString(),
  };
};

export const persistSnapshot = async (
  snapshot: Snapshot,
  cacheDirectory: string,
): Promise<{ filePath: string; version: string }> => {
  await fs.mkdir(cacheDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeRoot = snapshot.rootPath.replace(/[:\\/]/g, '_');
  const fileName = `${timestamp}-${safeRoot || 'snapshot'}.json`;
  const filePath = path.join(cacheDirectory, fileName);
  const payload = {
    ...snapshot,
    version: snapshot.version ?? timestamp,
    savedAtIso: new Date().toISOString(),
    persistedPath: filePath,
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return { filePath, version: payload.version! };
};

export const ensurePathExists = async (targetPath: string) => {
  await fs.mkdir(targetPath, { recursive: true });
};
