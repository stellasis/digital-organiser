/** @jest-environment node */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { generateSnapshot, persistSnapshot } from '../main/snapshotBuilder';

const createTempDir = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-builder-'));
  return dir;
};

describe('Snapshot generation', () => {
  it('creates a snapshot for a chosen root directory with deterministic structure', async () => {
    const rootDir = await createTempDir();
    const docsDir = path.join(rootDir, 'docs');
    const srcDir = path.join(rootDir, 'src');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, 'intro.md'), '# Intro');
    await fs.writeFile(path.join(srcDir, 'index.ts'), 'export {}');

    const snapshot = await generateSnapshot(rootDir);

    expect(snapshot.rootPath).toBe(rootDir);
    expect(snapshot.tree.name).toBe(path.basename(rootDir));
    const childNames = snapshot.tree.children?.map((child) => child.name).sort();
    expect(childNames).toEqual(['docs', 'src']);
    const docs = snapshot.tree.children?.find((child) => child.name === 'docs');
    expect(docs?.children?.[0].name).toBe('intro.md');

    const cacheDir = await createTempDir();
    const persisted = await persistSnapshot(snapshot, cacheDir);
    const persistedExists = await fs
      .access(path.join(cacheDir, path.basename(persisted.filePath)))
      .then(() => true)
      .catch(() => false);

    expect(persistedExists).toBe(true);
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  });
});
