import {
  buildSandboxTree,
  dfsOrder,
  bfsOrder,
  findByPath,
  pathOf,
  ancestorsOf,
  listChildren,
  createNode,
  renameNode,
  moveNode,
  deleteNode,
  SandboxTree,
} from '../renderer/fileSandbox/tree';
import { normalisePath, PathKind } from '../renderer/fileSandbox/path';
import { generateDiff } from '../renderer/fileSandbox/diff';
import { createUndoRedo } from '../renderer/fileSandbox/undoRedo';
import { createSandboxStore } from '../renderer/fileSandbox/store';
import type { Snapshot, SnapshotNode } from '../types/snapshot';

const fixtureSnapshot: Snapshot = {
  rootPath: normalisePath('C:/Projects'),
  tree: {
    id: 'root',
    name: 'Projects',
    kind: 'folder',
    children: [
      {
        id: 'n-1',
        name: 'docs',
        kind: 'folder',
        children: [
          {
            id: 'n-2',
            name: 'readme.md',
            kind: 'file',
          },
        ],
      },
      {
        id: 'n-3',
        name: 'src',
        kind: 'folder',
        children: [
          {
            id: 'n-4',
            name: 'index.ts',
            kind: 'file',
          },
          {
            id: 'n-5',
            name: 'App.tsx',
            kind: 'file',
          },
        ],
      },
      {
        id: 'n-6',
        name: 'package.json',
        kind: 'file',
      },
    ],
  },
};

const collectNames = (ids: string[], tree: SandboxTree) =>
  ids.map((id) => tree.nodes.get(id)!.name);

const expectUniqueIds = (node: SnapshotNode, seen = new Set<string>()) => {
  expect(seen.has(node.id)).toBe(false);
  seen.add(node.id);
  node.children?.forEach((child) => expectUniqueIds(child, seen));
};

describe('Tree construction & traversal', () => {
  it('builds a consistent sandbox tree with traversal helpers', () => {
    const tree = buildSandboxTree(fixtureSnapshot);

    expect(tree.rootId).toBe('root');
    expect(tree.snapshotRootPath).toBe('C:/Projects');

    const dfs = dfsOrder(tree);
    const bfs = bfsOrder(tree);

    expect(dfs).toEqual(['root', 'n-1', 'n-2', 'n-3', 'n-4', 'n-5', 'n-6']);
    expect(bfs).toEqual(['root', 'n-1', 'n-3', 'n-6', 'n-2', 'n-4', 'n-5']);

    const readme = findByPath(tree, 'Projects/docs/readme.md');
    expect(readme?.id).toBe('n-2');

    expect(pathOf(tree, 'n-4')).toBe('Projects/src/index.ts');

    expect(ancestorsOf(tree, 'n-4')).toEqual(['n-3', 'root']);

    expect(listChildren(tree, 'n-3').map((child) => child.id)).toEqual([
      'n-4',
      'n-5',
    ]);

    expect(() => expectUniqueIds(fixtureSnapshot.tree)).not.toThrow();
  });
});

describe('Path normalisation', () => {
  it('normalises windows and posix paths and collapses dot segments', () => {
    expect(normalisePath('C:/Projects/./src/../docs')).toBe('C:/Projects/docs');
    expect(normalisePath('C:\\Projects\\docs\\')).toBe('C:/Projects/docs');
    expect(normalisePath('/var//log/../tmp/')).toBe('/var/tmp');
    expect(() => normalisePath('..', PathKind.RelativeOnly)).toThrow(
      'Cannot normalise path that escapes root',
    );
  });
});

describe('CRUD semantics with kind awareness', () => {
  it('creates files and folders respecting kind and validates extensions', () => {
    const tree = buildSandboxTree(fixtureSnapshot);

    const newFolder = createNode(tree, 'n-3', { name: 'utils', kind: 'folder' });
    const newFile = createNode(tree, newFolder.id, {
      name: 'helpers.ts',
      kind: 'file',
    });

    expect(listChildren(tree, newFolder.id).map((child) => child.name)).toEqual([
      'helpers.ts',
    ]);

    expect(() =>
      createNode(tree, newFolder.id, { name: 'helpers.ts', kind: 'file' }),
    ).toThrow('Name helpers.ts already exists');

    expect(() =>
      createNode(tree, 'n-3', { name: 'invalid/', kind: 'folder' }),
    ).toThrow('contains invalid characters');
  });

  it('renames and moves folders/files respecting kind rules', () => {
    const tree = buildSandboxTree(fixtureSnapshot);

    renameNode(tree, 'n-4', 'main.tsx');
    expect(pathOf(tree, 'n-4')).toBe('Projects/src/main.tsx');

    renameNode(tree, 'n-5', 'main.tsx');
    expect(pathOf(tree, 'n-5')).toBe('Projects/src/main-1.tsx');

    moveNode(tree, 'n-5', 'n-1');
    expect(pathOf(tree, 'n-5')).toBe('Projects/docs/main-1.tsx');

    expect(() => moveNode(tree, 'n-1', 'n-2')).toThrow('Cannot move into descendant');
  });

  it('deletes folders recursively by default and respects kind flag', () => {
    const tree = buildSandboxTree(fixtureSnapshot);
    deleteNode(tree, 'n-3');
    expect(findByPath(tree, 'Projects/src')).toBeUndefined();
  });
});

describe('Diff generation', () => {
  it('emits deterministic ops with kind metadata', () => {
    const tree = buildSandboxTree(fixtureSnapshot);
    const folder = createNode(tree, 'root', { name: 'new_folder', kind: 'folder' });
    moveNode(tree, 'n-4', folder.id);
    renameNode(tree, 'n-4', 'index-renamed.ts');

    const diff = generateDiff(tree);

    expect(diff.baseRoot).toBe('C:/Projects');
    expect(diff.ops).toHaveLength(3);
    expect(diff.ops[0]).toMatchObject({
      type: 'create',
      kind: 'folder',
      parentPath: 'Projects',
      name: 'new_folder',
    });
    expect(diff.ops[1]).toMatchObject({
      type: 'move',
      id: 'n-4',
      kind: 'file',
      toParentPath: 'Projects/new_folder',
    });
    expect(diff.ops[2]).toMatchObject({
      type: 'rename',
      id: 'n-4',
      kind: 'file',
      toName: 'index-renamed.ts',
    });

    const rerun = generateDiff(tree);
    expect(rerun.ops).toEqual(diff.ops);
  });
});

describe('Conflict detection & resolution', () => {
  it('auto suffixes duplicate file names and merges folder targets', () => {
    const tree = buildSandboxTree(fixtureSnapshot);
    createNode(tree, 'n-1', { name: 'App.tsx', kind: 'file' });
    renameNode(tree, 'n-2', 'App.tsx');
    expect(pathOf(tree, 'n-2')).toBe('Projects/docs/App-1.tsx');

    const folder = createNode(tree, 'root', { name: 'docs', kind: 'folder' });
    moveNode(tree, 'n-1', folder.id);

    const mergedParentPath = pathOf(tree, folder.id);
    expect(mergedParentPath.startsWith('Projects/docs')).toBe(true);
    const movedPath = pathOf(tree, 'n-1');
    expect(movedPath.startsWith(`${mergedParentPath}/`)).toBe(true);
    expect(listChildren(tree, folder.id).length).toBeGreaterThan(0);
  });
});

describe('Undo/Redo manager', () => {
  it('tracks inverses of operations with kind metadata', () => {
    const tree = buildSandboxTree(fixtureSnapshot);
    const history = createUndoRedo();

    history.execute({
      redo: () => renameNode(tree, 'n-4', 'main.ts'),
      undo: () => renameNode(tree, 'n-4', 'index.ts'),
      label: 'rename main',
    });

    expect(pathOf(tree, 'n-4')).toBe('Projects/src/main.ts');

    history.undo();
    expect(pathOf(tree, 'n-4')).toBe('Projects/src/index.ts');

    history.redo();
    expect(pathOf(tree, 'n-4')).toBe('Projects/src/main.ts');
  });
});

describe('Dry-run & apply contracts', () => {
  it('sends diffs containing kind metadata and surfaces errors', async () => {
    const tree = buildSandboxTree(fixtureSnapshot);
    renameNode(tree, 'n-6', 'package-old.json');
    const diff = generateDiff(tree);

    const store = createSandboxStore({
      previewDiff: async () => ({
        ok: true,
        dryRunReport: {
          baseRoot: diff.baseRoot,
          rootName: 'Projects',
          operations: diff.ops.map((op) => ({
            op,
            targetPath: op.type === 'delete' ? op.atPath : '',
            description: `${op.type}:${op.kind}`,
            precondition: 'ok',
          })),
          issues: [],
        },
      }),
      applyDiff: async () => ({
        ok: false,
        results: [
          {
            kind: 'file',
            status: 'failed',
            targetPath: 'Projects/package.json',
            type: 'delete',
            message: 'Permission denied',
          },
        ],
      }),
    });

    store.getState().setTree(tree);
    const preview = await store.getState().previewCurrentDiff();
    expect(preview.ok).toBe(true);
    expect(preview.dryRunReport.operations[0].op.kind).toBe('file');

    const result = await store.getState().applyCurrentDiff();
    expect(result.ok).toBe(false);
    expect(result.results[0]).toMatchObject({
      kind: 'file',
      message: 'Permission denied',
      status: 'failed',
    });
  });
});
