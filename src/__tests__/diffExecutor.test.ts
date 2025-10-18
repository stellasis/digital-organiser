/** @jest-environment node */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { applyDiff, dryRunDiff } from '../main/diffExecutor';
import { generateSnapshot, persistSnapshot } from '../main/snapshotBuilder';
import type { Diff, DiffApplyResponse } from '../types/diff';

const createTempWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-executor-'));
  return dir;
};

const buildDiffMeta = () => ({
  createdAtIso: new Date().toISOString(),
  uid: `diff-${Date.now()}`,
});

const buildPaths = (rootDir: string, relative: string) => path.join(rootDir, relative);

describe('Diff executor', () => {
  it('applies create, move, rename and delete ops then regenerates snapshot', async () => {
    const rootDir = await createTempWorkspace();
    const rootName = path.basename(rootDir);
    const docsDir = buildPaths(rootDir, 'docs');
    const srcDir = buildPaths(rootDir, 'src');
    await fs.mkdir(docsDir, { recursive: true });
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(buildPaths(docsDir, 'readme.md'), 'Docs');
    await fs.writeFile(buildPaths(srcDir, 'index.ts'), 'export const x = 1;');

    const diff: Diff = {
      baseRoot: rootDir,
      meta: buildDiffMeta(),
      ops: [
        { type: 'create', parentPath: rootName, name: 'notes', kind: 'folder' },
        {
          type: 'move',
          id: 'index',
          kind: 'file',
          fromPath: `${rootName}/src/index.ts`,
          toParentPath: `${rootName}/notes`,
        },
        {
          type: 'rename',
          id: 'index',
          kind: 'file',
          fromPath: `${rootName}/src/index.ts`,
          toPath: `${rootName}/notes/main.ts`,
          fromName: 'index.ts',
          toName: 'main.ts',
        },
        {
          type: 'delete',
          id: 'readme',
          kind: 'file',
          atPath: `${rootName}/docs/readme.md`,
        },
      ],
    };

    const dryRun = await dryRunDiff(diff);
    expect(dryRun.issues).toHaveLength(0);

    const cacheDir = await createTempWorkspace();
    const result = await applyDiff(diff, {
      confirmApply: async () => true,
      onLockedFile: async () => 'retry',
      generateSnapshot: generateSnapshot,
      persistSnapshot: async (snapshot) => persistSnapshot(snapshot, cacheDir),
    });

    expect(result.ok).toBe(true);
    expect(result.results.filter((op) => op.status === 'applied')).toHaveLength(diff.ops.length);
    expect(await fs.access(buildPaths(rootDir, 'notes/main.ts')).then(() => true)).toBe(true);
    await expect(fs.access(buildPaths(rootDir, 'docs/readme.md'))).rejects.toThrow();
    expect(result.snapshot?.tree.children?.some((child) => child.name === 'notes')).toBe(true);

    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('prompts for locked files and respects user decisions', async () => {
    const rootDir = await createTempWorkspace();
    const rootName = path.basename(rootDir);
    const fileA = buildPaths(rootDir, 'a.txt');
    const fileB = buildPaths(rootDir, 'b.txt');
    await fs.writeFile(fileA, 'a');
    await fs.writeFile(fileB, 'b');

    const diff: Diff = {
      baseRoot: rootDir,
      meta: buildDiffMeta(),
      ops: [
        { type: 'delete', id: 'a', kind: 'file', atPath: `${rootName}/a.txt` },
        { type: 'delete', id: 'b', kind: 'file', atPath: `${rootName}/b.txt` },
      ],
    };

    let promptCount = 0;
    const checkFileLock = async (targetPath: string) => {
      if (targetPath.endsWith('a.txt') && promptCount < 1) {
        return 'locked' as const;
      }
      return 'ok' as const;
    };

    const onLockedFile = async () => {
      promptCount += 1;
      return promptCount === 1 ? 'skip' : 'retry';
    };

    const cacheDir = await createTempWorkspace();
    const response: DiffApplyResponse = await applyDiff(diff, {
      confirmApply: async () => true,
      onLockedFile,
      checkFileLock,
      generateSnapshot: generateSnapshot,
      persistSnapshot: async (snapshot) => persistSnapshot(snapshot, cacheDir),
    });

    expect(response.ok).toBe(true);
    expect(response.results[0].status).toBe('skipped');
    expect(response.results[1].status).toBe('applied');
    expect(await fs.access(fileA).then(() => true)).toBe(true);
    await expect(fs.access(fileB)).rejects.toThrow();

    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it('reports failures without corrupting remaining operations', async () => {
    const rootDir = await createTempWorkspace();
    const rootName = path.basename(rootDir);
    const fileA = buildPaths(rootDir, 'keep.txt');
    await fs.writeFile(fileA, 'safe');

    const diff: Diff = {
      baseRoot: rootDir,
      meta: buildDiffMeta(),
      ops: [
        { type: 'delete', id: 'missing', kind: 'file', atPath: `${rootName}/missing.txt` },
        { type: 'delete', id: 'keep', kind: 'file', atPath: `${rootName}/keep.txt` },
      ],
    };

    const cacheDir = await createTempWorkspace();
    const response = await applyDiff(diff, {
      confirmApply: async () => true,
      generateSnapshot: generateSnapshot,
      persistSnapshot: async (snapshot) => persistSnapshot(snapshot, cacheDir),
    });

    expect(response.ok).toBe(false);
    expect(response.results[0].status).toBe('failed');
    expect(response.results[1].status).toBe('applied');
    let removedContent: string | null = null;
    try {
      removedContent = await fs.readFile(fileA, 'utf8');
    } catch {
      removedContent = null;
    }
    expect(removedContent).toBeNull();

    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  });
});
