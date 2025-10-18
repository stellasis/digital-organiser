import { ensureValidName, splitPath, splitStemAndExtension } from './path';
import type { NodeKind, Snapshot, SnapshotNode } from '../../types/snapshot';

export interface SandboxNode {
  id: string;
  name: string;
  kind: NodeKind;
  parentId: string | null;
  children: string[];
  fromSnapshot: boolean;
  originalName?: string;
  originalParentId?: string | null;
}

export interface SerializedSandboxNode {
  id: string;
  name: string;
  kind: NodeKind;
  parentId: string | null;
  fromSnapshot: boolean;
  originalName?: string;
  originalParentId?: string | null;
  children: SerializedSandboxNode[];
}

export interface SandboxTree {
  nodes: Map<string, SandboxNode>;
  rootId: string;
  snapshotRootPath: string;
  originalPaths: Map<string, string>;
  originalNodes: Map<string, { name: string; parentId: string | null; kind: NodeKind }>;
  nextLocalId: number;
  diffSequence: number;
}

const addNode = (
  tree: SandboxTree,
  data: SnapshotNode,
  parentId: string | null,
): SandboxNode => {
  const node: SandboxNode = {
    id: data.id,
    name: data.name,
    kind: data.kind,
    parentId,
    children: [],
    fromSnapshot: true,
    originalName: data.name,
    originalParentId: parentId,
  };
  tree.nodes.set(node.id, node);
  if (parentId) {
    tree.nodes.get(parentId)!.children.push(node.id);
  }
  tree.originalNodes.set(node.id, {
    name: data.name,
    parentId,
    kind: data.kind,
  });
  return node;
};

export const buildSandboxTree = (snapshot: Snapshot): SandboxTree => {
  const tree: SandboxTree = {
    nodes: new Map(),
    rootId: snapshot.tree.id,
    snapshotRootPath: snapshot.rootPath,
    originalPaths: new Map(),
    originalNodes: new Map(),
    nextLocalId: 1,
    diffSequence: 0,
  };
  const walk = (
    node: SnapshotNode,
    parentId: string | null,
    pathSegments: string[],
  ) => {
    const created = addNode(tree, node, parentId);
    const path = [...pathSegments, node.name].join('/');
    tree.originalPaths.set(node.id, path);
    node.children?.forEach((child) => walk(child, created.id, [...pathSegments, node.name]));
  };

  walk(snapshot.tree, null, []);
  return tree;
};

const assertFolder = (tree: SandboxTree, nodeId: string) => {
  const node = tree.nodes.get(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  if (node.kind !== 'folder') {
    throw new Error(`Node ${node.name} is not a folder`);
  }
  return node;
};

const resolveNameConflict = (
  tree: SandboxTree,
  parentId: string,
  desiredName: string,
  options: { excludeId?: string; kind: NodeKind; allowMerge?: boolean; strategy?: 'suffix' | 'throw' },
): { name: string; mergeTarget?: SandboxNode } => {
  const parent = assertFolder(tree, parentId);
  const siblings = parent.children
    .map((childId) => tree.nodes.get(childId)!)
    .filter(Boolean);
  const conflict = siblings.find((sibling) => sibling.name === desiredName && sibling.id !== options.excludeId);
  if (!conflict) {
    return { name: desiredName };
  }

  if (options.allowMerge && conflict.kind === 'folder' && options.kind === 'folder') {
    return { name: conflict.name, mergeTarget: conflict };
  }

  if (options.strategy === 'throw') {
    throw new Error(`Name ${desiredName} already exists`);
  }

  const { stem, extension } = splitStemAndExtension(desiredName);
  let suffix = 1;
  let candidate = '';
  do {
    candidate = `${stem}-${suffix}${extension}`;
    suffix += 1;
  } while (siblings.some((sibling) => sibling.name === candidate && sibling.id !== options.excludeId));
  return { name: candidate };
};

const generateLocalId = (tree: SandboxTree) => {
  const id = `local-${tree.nextLocalId}`;
  tree.nextLocalId += 1;
  return id;
};

export const dfsOrder = (tree: SandboxTree): string[] => {
  const result: string[] = [];
  const visit = (id: string) => {
    result.push(id);
    const node = tree.nodes.get(id);
    node?.children.forEach((childId) => visit(childId));
  };
  visit(tree.rootId);
  return result;
};

export const bfsOrder = (tree: SandboxTree): string[] => {
  const result: string[] = [];
  const queue: string[] = [tree.rootId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    const node = tree.nodes.get(id);
    if (node) {
      queue.push(...node.children);
    }
  }
  return result;
};

export const findByPath = (tree: SandboxTree, path: string) => {
  const segments = splitPath(path);
  if (segments.length === 0) return tree.nodes.get(tree.rootId);
  const root = tree.nodes.get(tree.rootId);
  if (!root) return undefined;
  let current: SandboxNode | undefined = root;
  let index = 0;
  if (segments[0] === root.name) {
    index = 1;
  }
  for (; index < segments.length; index += 1) {
    if (!current || current.kind !== 'folder') return undefined;
    const nextName = segments[index];
    const nextId = current.children
      .map((childId) => tree.nodes.get(childId)!)
      .find((child) => child.name === nextName)?.id;
    if (!nextId) return undefined;
    current = tree.nodes.get(nextId);
  }
  return current;
};

export const pathOf = (tree: SandboxTree, id: string): string => {
  const node = tree.nodes.get(id);
  if (!node) throw new Error(`Node ${id} not found`);
  const parts: string[] = [node.name];
  let cursor = node.parentId;
  while (cursor) {
    const parent = tree.nodes.get(cursor);
    if (!parent) break;
    parts.unshift(parent.name);
    cursor = parent.parentId;
  }
  return parts.join('/');
};

export const ancestorsOf = (tree: SandboxTree, id: string): string[] => {
  const ancestors: string[] = [];
  let cursor = tree.nodes.get(id)?.parentId ?? null;
  while (cursor) {
    ancestors.push(cursor);
    cursor = tree.nodes.get(cursor)?.parentId ?? null;
  }
  return ancestors;
};

export const listChildren = (tree: SandboxTree, id: string): SandboxNode[] => {
  const node = tree.nodes.get(id);
  if (!node) throw new Error(`Node ${id} not found`);
  if (node.kind !== 'folder') return [];
  return node.children.map((childId) => tree.nodes.get(childId)!).filter(Boolean);
};

const reparent = (tree: SandboxTree, id: string, newParent: SandboxNode) => {
  const node = tree.nodes.get(id);
  if (!node) throw new Error(`Node ${id} not found`);
  if (node.parentId) {
    const parent = tree.nodes.get(node.parentId);
    if (parent) {
      parent.children = parent.children.filter((childId) => childId !== id);
    }
  }
  node.parentId = newParent.id;
  newParent.children.push(id);
};

export const createNode = (
  tree: SandboxTree,
  parentId: string,
  payload: { name: string; kind: NodeKind; id?: string },
): SandboxNode => {
  const parent = assertFolder(tree, parentId);
  ensureValidName(payload.name);
  const { name } = resolveNameConflict(tree, parentId, payload.name, {
    kind: payload.kind,
    strategy: payload.kind === 'folder' ? 'suffix' : 'throw',
  });
  const nodeId = payload.id ?? generateLocalId(tree);
  if (payload.id) {
    const match = /^local-(\d+)$/.exec(payload.id);
    if (match) {
      const numeric = Number(match[1]);
      if (numeric >= tree.nextLocalId) {
        tree.nextLocalId = numeric + 1;
      }
    }
  }
  const node: SandboxNode = {
    id: nodeId,
    name,
    kind: payload.kind,
    parentId: parent.id,
    children: [],
    fromSnapshot: false,
  };
  tree.nodes.set(node.id, node);
  parent.children.push(node.id);
  return node;
};

export const renameNode = (tree: SandboxTree, id: string, desiredName: string) => {
  const node = tree.nodes.get(id);
  if (!node) throw new Error(`Node ${id} not found`);
  ensureValidName(desiredName);
  const parentId = node.parentId;
  if (!parentId) {
    node.name = desiredName;
    return node;
  }
  const { name } = resolveNameConflict(tree, parentId, desiredName, {
    kind: node.kind,
    excludeId: node.id,
  });
  node.name = name;
  return node;
};

const isDescendant = (tree: SandboxTree, id: string, potentialAncestorId: string): boolean => {
  let cursor = tree.nodes.get(id)?.parentId ?? null;
  while (cursor) {
    if (cursor === potentialAncestorId) return true;
    cursor = tree.nodes.get(cursor)?.parentId ?? null;
  }
  return false;
};

export const moveNode = (tree: SandboxTree, id: string, targetParentId: string) => {
  const node = tree.nodes.get(id);
  if (!node) throw new Error(`Node ${id} not found`);
  if (node.parentId === targetParentId) return node;
  const targetNode = tree.nodes.get(targetParentId);
  if (!targetNode) throw new Error(`Node ${targetParentId} not found`);
  if (isDescendant(tree, targetParentId, id)) {
    throw new Error('Cannot move into descendant');
  }
  const targetParent = assertFolder(tree, targetParentId);
  const { name, mergeTarget } = resolveNameConflict(tree, targetParentId, node.name, {
    kind: node.kind,
    excludeId: node.id,
    allowMerge: true,
  });
  if (mergeTarget && node.kind === 'folder') {
    // merge contents and delete current node
    [...node.children].forEach((childId) => {
      reparent(tree, childId, mergeTarget);
    });
    deleteNode(tree, node.id);
    return mergeTarget;
  }
  node.name = name;
  reparent(tree, id, targetParent);
  return node;
};

const collectDescendants = (tree: SandboxTree, id: string): string[] => {
  const node = tree.nodes.get(id);
  if (!node || node.kind !== 'folder') return [];
  return node.children.flatMap((childId) => [childId, ...collectDescendants(tree, childId)]);
};

export const deleteNode = (tree: SandboxTree, id: string) => {
  const node = tree.nodes.get(id);
  if (!node) throw new Error(`Node ${id} not found`);
  if (node.parentId) {
    const parent = tree.nodes.get(node.parentId);
    if (parent) {
      parent.children = parent.children.filter((childId) => childId !== id);
    }
  }
  const descendants = collectDescendants(tree, id);
  descendants.forEach((childId) => tree.nodes.delete(childId));
  tree.nodes.delete(id);
};

export const cloneTree = (tree: SandboxTree): SandboxTree => {
  const copy: SandboxTree = {
    nodes: new Map(),
    rootId: tree.rootId,
    snapshotRootPath: tree.snapshotRootPath,
    originalPaths: new Map(tree.originalPaths),
    originalNodes: new Map(tree.originalNodes),
    nextLocalId: tree.nextLocalId,
    diffSequence: tree.diffSequence,
  };
  tree.nodes.forEach((node) => {
    copy.nodes.set(node.id, {
      ...node,
      children: [...node.children],
    });
  });
  return copy;
};

export const serialiseSubtree = (tree: SandboxTree, id: string): SerializedSandboxNode => {
  const node = tree.nodes.get(id);
  if (!node) {
    throw new Error(`Node ${id} not found`);
  }
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    parentId: node.parentId,
    fromSnapshot: node.fromSnapshot,
    originalName: node.originalName,
    originalParentId: node.originalParentId,
    children: node.children.map((childId) => serialiseSubtree(tree, childId)),
  };
};

export const restoreSubtree = (
  tree: SandboxTree,
  parentId: string | null,
  snapshot: SerializedSandboxNode,
) => {
  const node: SandboxNode = {
    id: snapshot.id,
    name: snapshot.name,
    kind: snapshot.kind,
    parentId,
    children: [],
    fromSnapshot: snapshot.fromSnapshot,
    originalName: snapshot.originalName,
    originalParentId: snapshot.originalParentId,
  };
  tree.nodes.set(node.id, node);
  if (parentId) {
    const parent = tree.nodes.get(parentId);
    if (parent) {
      parent.children.push(node.id);
    }
  } else {
    tree.rootId = node.id;
  }
  if (!node.fromSnapshot) {
    const match = /^local-(\d+)$/.exec(node.id);
    if (match) {
      const numeric = Number(match[1]);
      if (numeric >= tree.nextLocalId) {
        tree.nextLocalId = numeric + 1;
      }
    }
  }
  node.children = snapshot.children.map((child) => {
    restoreSubtree(tree, node.id, child);
    return child.id;
  });
  return node;
};
