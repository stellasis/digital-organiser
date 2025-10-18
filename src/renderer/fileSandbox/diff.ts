import { pathOf, SandboxTree } from './tree';
import type { Diff, CreateOp, MoveOp, RenameOp, DeleteOp } from '../../types/diff';

const pathDepth = (path: string) => (path ? path.split('/').length : 0);

export const generateDiff = (tree: SandboxTree): Diff => {
  const createOps: CreateOp[] = [];
  const moveOps: MoveOp[] = [];
  const renameOps: RenameOp[] = [];
  const deleteOps: DeleteOp[] = [];

  tree.nodes.forEach((node) => {
    if (!node.fromSnapshot) {
      const parentPath = node.parentId ? pathOf(tree, node.parentId) : '';
      createOps.push({
        type: 'create',
        parentPath,
        name: node.name,
        kind: node.kind,
      });
    } else {
      const original = tree.originalNodes.get(node.id);
      if (!original) return;
      if (original.parentId !== node.parentId) {
        moveOps.push({
          type: 'move',
          id: node.id,
          kind: node.kind,
          fromPath: tree.originalPaths.get(node.id) ?? original.name,
          toParentPath: node.parentId ? pathOf(tree, node.parentId) : '',
        });
      }
      if (original.name !== node.name) {
        renameOps.push({
          type: 'rename',
          id: node.id,
          kind: node.kind,
          fromPath: tree.originalPaths.get(node.id) ?? original.name,
          toPath: pathOf(tree, node.id),
          fromName: original.name,
          toName: node.name,
        });
      }
    }
  });

  const deletedIds = new Set<string>();
  tree.originalNodes.forEach((original, id) => {
    if (!tree.nodes.has(id)) {
      deletedIds.add(id);
    }
  });

  deletedIds.forEach((id) => {
    const original = tree.originalNodes.get(id);
    if (!original) return;
    if (original.parentId && deletedIds.has(original.parentId)) return;
    deleteOps.push({
      type: 'delete',
      id,
      kind: original.kind,
      atPath: tree.originalPaths.get(id) ?? original.name,
      recursive: original.kind === 'folder' ? true : undefined,
    });
  });

  createOps.sort((a, b) => {
    const depthDiff = pathDepth(a.parentPath) - pathDepth(b.parentPath);
    if (depthDiff !== 0) return depthDiff;
    return a.name.localeCompare(b.name);
  });

  moveOps.sort((a, b) => {
    const depthDiff = pathDepth(a.toParentPath) - pathDepth(b.toParentPath);
    if (depthDiff !== 0) return depthDiff;
    return a.id.localeCompare(b.id);
  });

  renameOps.sort((a, b) => a.toPath.localeCompare(b.toPath));

  deleteOps.sort((a, b) => {
    const depthDiff = pathDepth(b.atPath) - pathDepth(a.atPath);
    if (depthDiff !== 0) return depthDiff;
    return a.id.localeCompare(b.id);
  });

  const diff: Diff = {
    baseRoot: tree.snapshotRootPath,
    ops: [...createOps, ...moveOps, ...renameOps, ...deleteOps],
    meta: {
      createdAtIso: new Date().toISOString(),
      uid: `sandbox-diff-${tree.diffSequence}`,
    },
  };
  tree.diffSequence += 1;
  return diff;
};
