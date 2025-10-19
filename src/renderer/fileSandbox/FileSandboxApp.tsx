import { useEffect, useMemo, useState } from 'react';
import type { DragEvent, MouseEvent, ReactElement } from 'react';
import type {
  Diff,
  DiffApplyResponse,
  DiffDryRunPrecondition,
  DiffDryRunReport,
} from '../../types/diff';
import type { Snapshot } from '../../types/snapshot';
import {
  SandboxTree,
  SandboxNode,
  cloneTree,
  createNode,
  deleteNode,
  moveNode,
  renameNode,
  pathOf,
  serialiseSubtree,
  restoreSubtree,
} from './tree';
import { generateDiff } from './diff';
import { createSandboxStore } from './store';
import { createUndoRedo } from './undoRedo';
import { sampleSnapshot } from './sample';
import type { SerializedSandboxNode } from './tree';

interface MoveDialogState {
  open: boolean;
  targetId: string | null;
}

interface SandboxBridge {
  requestSnapshot?: (rootPath: string) => Promise<Snapshot>;
  createSnapshot?: (rootPath: string) => Promise<Snapshot>;
  previewDiff?: (diff: Diff) => Promise<{ ok: boolean; dryRunReport: DiffDryRunReport }>;
  applyDiff?: (diff: Diff) => Promise<DiffApplyResponse>;
}

const getSandboxBridge = (): SandboxBridge | null => {
  const electron = window.electron as unknown as { sandbox?: SandboxBridge } | undefined;
  return electron?.sandbox ?? null;
};

const DEFAULT_NEW_FOLDER = 'New Folder';
const DEFAULT_NEW_FILE = 'New File.txt';

const isFolder = (node: SandboxNode | undefined): node is SandboxNode & { kind: 'folder' } =>
  Boolean(node && node.kind === 'folder');

const useSandboxServices = () => {
  const bridge = getSandboxBridge();
  return useMemo(
    () => ({
      requestSnapshot: bridge?.requestSnapshot,
      createSnapshot: bridge?.createSnapshot,
      previewDiff: async (diff: Diff) =>
        (bridge?.previewDiff
          ? bridge.previewDiff(diff)
          : Promise.resolve({
              ok: true,
              dryRunReport: {
                baseRoot: '',
                rootName: sampleSnapshot.tree.name,
                operations: diff.ops.map((op) => ({
                  op,
                  targetPath: '',
                  description: `${op.type} ${op.kind}`,
                  precondition: 'ok' as DiffDryRunPrecondition,
                })),
                issues: [],
              },
            })),
      applyDiff: async (diff: Diff) =>
        (bridge?.applyDiff
          ? bridge.applyDiff(diff)
          : Promise.resolve({
              ok: true,
              results: diff.ops.map((op) => ({
                type: op.type,
                kind: op.kind,
                status: 'applied' as const,
                targetPath: `${op.type}:${op.kind}`,
              })),
            })),
    }),
    [bridge],
  );
};

const useSandboxStoreState = (store = createSandboxStore(useSandboxServices())) => {
  const [tree, setTree] = useState<SandboxTree | null>(store.getState().tree);
  const [diff, setDiff] = useState<Diff | null>(store.getState().diff);
  const [rootPath, setRootPath] = useState<string | null>(store.getState().rootPath);
  const [snapshotVersion, setSnapshotVersion] = useState<string | null>(
    store.getState().snapshotVersion,
  );
  const [snapshotFile, setSnapshotFile] = useState<string | null>(store.getState().snapshotFile);

  useEffect(() => {
    const unsubscribe = store.subscribe((next) => {
      setTree(next.tree);
      setDiff(next.diff);
      setRootPath(next.rootPath);
      setSnapshotVersion(next.snapshotVersion);
      setSnapshotFile(next.snapshotFile);
    });
    setTree(store.getState().tree);
    setDiff(store.getState().diff);
    setRootPath(store.getState().rootPath);
    setSnapshotVersion(store.getState().snapshotVersion);
    setSnapshotFile(store.getState().snapshotFile);
    return unsubscribe;
  }, [store]);

  return { tree, diff, store, rootPath, snapshotVersion, snapshotFile };
};

const buildFolderOptions = (tree: SandboxTree | null): { id: string; path: string }[] => {
  if (!tree) return [];
  const options: { id: string; path: string }[] = [];
  const traverse = (id: string) => {
    const node = tree.nodes.get(id);
    if (!isFolder(node)) return;
    options.push({ id: node.id, path: pathOf(tree, node.id) });
    node.children.forEach(traverse);
  };
  traverse(tree.rootId);
  return options;
};

interface TreeNodeProps {
  node: SandboxNode;
  depth: number;
  tree: SandboxTree;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string, metaKey: boolean, shiftKey: boolean) => void;
  selectedIds: Set<string>;
  onBeginRename: (id: string) => void;
  renamingId: string | null;
  onCommitRename: (id: string, name: string) => void;
  onCancelRename: () => void;
  onCreateChild: (parentId: string | null, kind: 'file' | 'folder') => void;
  onDelete: (ids: string[]) => void;
  onMove: (ids: string[], targetId: string) => void;
  onOpenContextMenu: (event: MouseEvent<HTMLDivElement>, id: string) => void;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
}

const TreeNode = ({
  node,
  depth,
  tree,
  expanded,
  onToggleExpand,
  onSelect,
  selectedIds,
  onBeginRename,
  renamingId,
  onCommitRename,
  onCancelRename,
  onCreateChild,
  onDelete,
  onMove,
  onOpenContextMenu,
  draggingId,
  setDraggingId,
}: TreeNodeProps) => {
  const isExpanded = expanded.has(node.id);
  const isSelected = selectedIds.has(node.id);
  const [draftName, setDraftName] = useState(node.name);
  useEffect(() => {
    if (renamingId === node.id) {
      setDraftName(node.name);
    }
  }, [node.name, renamingId, node.id]);

  const handleToggle = () => {
    if (node.kind === 'folder') {
      onToggleExpand(node.id);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedId = draggingId;
    setDraggingId(null);
    if (!draggedId || draggedId === node.id) return;
    if (!isFolder(node)) return;
    const selected = selectedIds.has(draggedId) ? Array.from(selectedIds) : [draggedId];
    onMove(selected, node.id);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isFolder(node)) return;
    event.preventDefault();
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.setData('text/plain', node.id);
    setDraggingId(node.id);
  };

  const paddingLeft = 16 * depth;

  return (
    <div
      className={`sandbox-node ${isSelected ? 'selected' : ''}`}
      style={{ paddingLeft }}
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={(event: MouseEvent<HTMLDivElement>) =>
        onSelect(node.id, event.metaKey || event.ctrlKey, event.shiftKey)}
      onDoubleClick={() => {
        if (node.kind === 'folder') {
          onToggleExpand(node.id);
        } else {
          onBeginRename(node.id);
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect(node.id, event.metaKey || event.ctrlKey, event.shiftKey);
        onOpenContextMenu(event, node.id);
      }}
    >
      <div className="node-main">
        {node.kind === 'folder' ? (
          <button type="button" className="expand-button" onClick={handleToggle} aria-label="Toggle">
            {isExpanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="expand-placeholder" />
        )}
        {renamingId === node.id ? (
          <input
            className="rename-input"
            value={draftName}
            autoFocus
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={() => onCommitRename(node.id, draftName)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                onCommitRename(node.id, draftName);
              }
              if (event.key === 'Escape') {
                onCancelRename();
              }
            }}
          />
        ) : (
          <span className="node-label" title={pathOf(tree, node.id)}>
            {node.name}
          </span>
        )}
      </div>
      <div className="node-actions">
        {node.kind === 'folder' && (
          <button type="button" onClick={() => onCreateChild(node.id, 'folder')}>
            +Folder
          </button>
        )}
        {node.kind === 'folder' && (
          <button type="button" onClick={() => onCreateChild(node.id, 'file')}>
            +File
          </button>
        )}
        <button type="button" onClick={() => onBeginRename(node.id)}>
          Rename
        </button>
        {node.parentId && (
          <button type="button" onClick={() => onDelete([node.id])}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
};

const renderTree = (
  tree: SandboxTree,
  expanded: Set<string>,
  handlers: Omit<TreeNodeProps, 'node' | 'depth' | 'tree' | 'expanded'>,
) => {
  const nodes: ReactElement[] = [];
  const walk = (id: string, depth: number) => {
    const node = tree.nodes.get(id);
    if (!node) return;
    nodes.push(
      <TreeNode
        key={node.id}
        node={node}
        depth={depth}
        tree={tree}
        expanded={expanded}
        {...handlers}
      />,
    );
    if (node.kind === 'folder' && expanded.has(node.id)) {
      node.children.forEach((childId) => walk(childId, depth + 1));
    }
  };
  walk(tree.rootId, 0);
  return nodes;
};

const FileSandboxApp = () => {
  const services = useSandboxServices();
  const storeInstance = useMemo(() => createSandboxStore(services), [services]);
  const { tree, store, rootPath, snapshotVersion, snapshotFile } = useSandboxStoreState(
    storeInstance,
  );
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialogState>({ open: false, targetId: null });
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);
  const history = useMemo(() => createUndoRedo(200), []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!store.getState().tree) {
      store.getState().loadSnapshot(sampleSnapshot);
    }
  }, [store]);

  useEffect(() => {
    if (tree && expanded.size === 0) {
      setExpanded(new Set([tree.rootId]));
    }
  }, [tree, expanded.size]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    return () => {
      window.removeEventListener('click', closeMenu);
    };
  }, []);

  useEffect(() => {
    if (tree) {
      setSelectedIds((previous) => previous.filter((id) => tree.nodes.has(id)));
    }
  }, [tree]);

  const mutateTree = (mutator: (draft: SandboxTree) => void) => {
    const current = store.getState().tree;
    if (!current) return;
    const draft = cloneTree(current);
    try {
      mutator(draft);
      store.setState({ tree: draft });
      setError(null);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
    }
  };

  const handleCreate = (parentId: string | null, kind: 'file' | 'folder') => {
    const current = store.getState().tree;
    if (!current) return;
    const targetId = parentId ?? current.rootId;
    const preview = cloneTree(current);
    const created = createNode(preview, targetId, {
      name: kind === 'folder' ? DEFAULT_NEW_FOLDER : DEFAULT_NEW_FILE,
      kind,
    });
    const finalName = created.name;
    const newId = created.id;
    history.execute({
      redo: () => {
        mutateTree((draft) => {
          createNode(draft, targetId, { name: finalName, kind, id: newId });
        });
        setExpanded((prev) => new Set(prev).add(targetId));
        setSelectedIds([newId]);
        setRenamingId(newId);
        setContextMenu(null);
      },
      undo: () => {
        mutateTree((draft) => {
          if (draft.nodes.has(newId)) {
            deleteNode(draft, newId);
          }
        });
        setSelectedIds((ids) => ids.filter((id) => id !== newId));
      },
      label: `create:${finalName}`,
    });
  };

  const handleRename = (id: string, name: string) => {
    const current = store.getState().tree;
    if (!current) return;
    const preview = cloneTree(current);
    const before = preview.nodes.get(id)?.name ?? '';
    const renamed = renameNode(preview, id, name.trim());
    const after = renamed.name;
    if (before === after) {
      setRenamingId(null);
      return;
    }
    history.execute({
      redo: () => {
        mutateTree((draft) => {
          renameNode(draft, id, after);
        });
        setContextMenu(null);
      },
      undo: () => {
        mutateTree((draft) => {
          renameNode(draft, id, before);
        });
      },
      label: `rename:${before}->${after}`,
    });
    setRenamingId(null);
  };

  const handleDelete = (ids: string[]) => {
    const current = store.getState().tree;
    if (!current) return;
    const snapshots: SerializedSandboxNode[] = ids.map((id) => serialiseSubtree(current, id));
    const parentIds = ids.map((id) => current.nodes.get(id)?.parentId ?? null);
    history.execute({
      redo: () => {
        mutateTree((draft) => {
          ids.forEach((id) => {
            if (draft.nodes.has(id)) {
              deleteNode(draft, id);
            }
          });
        });
        setSelectedIds([]);
        setContextMenu(null);
      },
      undo: () => {
        mutateTree((draft) => {
          snapshots.forEach((snapshot, index) => {
            const parentId = parentIds[index];
            if (parentId) {
              restoreSubtree(draft, parentId, snapshot);
            } else {
              restoreSubtree(draft, null, snapshot);
            }
          });
        });
      },
      label: `delete:${ids.length}`,
    });
  };

  const handleMove = (ids: string[], targetId: string) => {
    const current = store.getState().tree;
    if (!current) return;
    const originalParents = ids.map((id) => current.nodes.get(id)?.parentId ?? null);
    const snapshots = ids.map((id) => serialiseSubtree(current, id));
    history.execute({
      redo: () => {
        mutateTree((draft) => {
          ids.forEach((id) => {
            if (draft.nodes.has(id)) {
              moveNode(draft, id, targetId);
            }
          });
        });
        setContextMenu(null);
      },
      undo: () => {
        mutateTree((draft) => {
          ids.forEach((id, index) => {
            const parentId = originalParents[index];
            if (!parentId) return;
            if (draft.nodes.has(id)) {
              moveNode(draft, id, parentId);
            } else {
              const snapshot = snapshots[index];
              const detach = (nodeSnapshot: SerializedSandboxNode) => {
                const existing = draft.nodes.get(nodeSnapshot.id);
                if (existing?.parentId) {
                  const parent = draft.nodes.get(existing.parentId);
                  if (parent) {
                    parent.children = parent.children.filter((childId) => childId !== existing.id);
                  }
                }
                nodeSnapshot.children.forEach(detach);
              };
              detach(snapshot);
              restoreSubtree(draft, parentId, snapshot);
            }
          });
        });
      },
      label: `move:${ids.length}`,
    });
  };

  const handleUndo = () => {
    history.undo();
  };

  const handleRedo = () => {
    history.redo();
  };

  const handlePreviewDiff = async () => {
    try {
      await store.getState().previewCurrentDiff();
      setError(null);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : String(previewError));
    }
  };

  const handleApplyDiff = async () => {
    try {
      await store.getState().applyCurrentDiff();
      setError(null);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : String(applyError));
    }
  };

  const handleCreateSnapshot = async (targetRoot?: string | null) => {
    const effectiveRoot = targetRoot ?? store.getState().rootPath ?? tree?.snapshotRootPath ?? null;
    if (!effectiveRoot) {
      setError('Select a root directory before creating a snapshot.');
      return;
    }
    try {
      const snapshotPromise =
        services.createSnapshot?.(effectiveRoot) ??
        services.requestSnapshot?.(effectiveRoot) ??
        Promise.resolve({ ...sampleSnapshot, rootPath: effectiveRoot });
      const resolved = await snapshotPromise;
      store.getState().loadSnapshot(resolved);
      setError(null);
    } catch (snapshotError) {
      setError(snapshotError instanceof Error ? snapshotError.message : String(snapshotError));
    }
  };

  const handleSelectRootDirectory = async () => {
    const electron = window.electron as unknown as {
      fileSystem?: { selectDirectory?: () => Promise<string | null> };
    } | null;
    const root = await electron?.fileSystem?.selectDirectory?.();
    if (!root) {
      return;
    }
    await handleCreateSnapshot(root);
  };

  const liveDiff = useMemo(() => (tree ? generateDiff(cloneTree(tree)) : null), [tree]);
  const folderOptions = useMemo(() => buildFolderOptions(tree), [tree]);

  const handleSelect = (id: string, metaKey: boolean, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      if (shiftKey && prev.length > 0 && tree) {
        const flattened = dfsFlatten(tree);
        const start = flattened.indexOf(prev[prev.length - 1]);
        const end = flattened.indexOf(id);
        if (start >= 0 && end >= 0) {
          const [from, to] = start < end ? [start, end] : [end, start];
          return Array.from(new Set([...prev, ...flattened.slice(from, to + 1)]));
        }
      }
      if (metaKey) {
        return prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id];
      }
      return [id];
    });
  };

  const dfsFlatten = (treeValue: SandboxTree): string[] => {
    const ids: string[] = [];
    const visit = (id: string) => {
      ids.push(id);
      const node = treeValue.nodes.get(id);
      if (node?.kind === 'folder') {
        node.children.forEach(visit);
      }
    };
    visit(treeValue.rootId);
    return ids;
  };

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const contextNode = contextMenu && tree ? tree.nodes.get(contextMenu.nodeId) : null;

  const resolveContextParent = (nodeId: string | null) => {
    if (!tree) return null;
    if (!nodeId) return tree.rootId;
    const node = tree.nodes.get(nodeId);
    if (!node) return tree.rootId;
    if (node.kind === 'folder') return node.id;
    return node.parentId ?? tree.rootId;
  };

  const preferredParent = () => {
    if (!tree) return null;
    const folder = selectedIds.find((id) => tree.nodes.get(id)?.kind === 'folder');
    if (folder) return folder;
    if (selectedIds[0]) {
      return tree.nodes.get(selectedIds[0])?.parentId ?? tree.rootId;
    }
    return tree.rootId;
  };

  return (
    <div className="sandbox-app">
      <header className="sandbox-header">
        <div>
          <h1>File hierarchy sandbox</h1>
          <p>
            Edits are staged locally. Drag and drop to rearrange, rename inline, and preview the diff before
            applying changes. Every operation is kind-aware.
          </p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={handleSelectRootDirectory}>
            Select root directory
          </button>
          <button type="button" onClick={() => handleCreateSnapshot()} disabled={!tree}>
            Create snapshot
          </button>
          <button type="button" onClick={() => store.getState().loadSnapshot(sampleSnapshot)}>
            Load sample snapshot
          </button>
          <button type="button" onClick={handlePreviewDiff}>
            Preview diff
          </button>
          <button type="button" onClick={handleApplyDiff}>
            Apply diff
          </button>
        </div>
        <div className="sandbox-meta">
          <span title={rootPath ?? ''}>Root: {rootPath ?? 'Sample sandbox'}</span>
          <span>Snapshot: {snapshotVersion ?? '—'}</span>
          {snapshotFile ? <span title={snapshotFile}>Saved to: {snapshotFile}</span> : null}
        </div>
      </header>
      {error && <div className="sandbox-error">{error}</div>}
      <div className="sandbox-toolbar">
        <button type="button" onClick={() => handleCreate(preferredParent(), 'folder')}>
          New folder
        </button>
        <button type="button" onClick={() => handleCreate(preferredParent(), 'file')}>
          New file
        </button>
        <button type="button" disabled={selectedIds.length === 0} onClick={() => setRenamingId(selectedIds[0] ?? null)}>
          Rename
        </button>
        <button type="button" disabled={selectedIds.length === 0} onClick={() => handleDelete(selectedIds)}>
          Delete
        </button>
        <button
          type="button"
          disabled={selectedIds.length === 0}
          onClick={() => setMoveDialog({ open: true, targetId: preferredParent() })}
        >
          Move to…
        </button>
        <button type="button" onClick={handleUndo}>
          Undo
        </button>
        <button type="button" onClick={handleRedo}>
          Redo
        </button>
      </div>
      <div className="sandbox-body">
        <section className="tree-pane">
          {tree ? (
            <div className="tree-scroll">
              {renderTree(tree, expanded, {
                onToggleExpand: (id) => {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) {
                      next.delete(id);
                    } else {
                      next.add(id);
                    }
                    return next;
                  });
                },
                onSelect: handleSelect,
                selectedIds: selectedSet,
                onBeginRename: (id) => setRenamingId(id),
                renamingId,
                onCommitRename: handleRename,
                onCancelRename: () => setRenamingId(null),
                onCreateChild: handleCreate,
                onDelete: handleDelete,
                onMove: handleMove,
                onOpenContextMenu: (event, id) => {
                  setContextMenu({ x: event.clientX, y: event.clientY, nodeId: id });
                },
                draggingId,
                setDraggingId,
              })}
            </div>
          ) : (
            <p className="empty">Load a snapshot to begin.</p>
          )}
        </section>
        <section className="diff-pane">
          <h2>Pending diff</h2>
          {liveDiff ? (
            <>
              <ul className="diff-list">
                {liveDiff.ops.map((op, index) => (
                  <li key={`${op.type}-${index}`}>
                    <code>{op.type}</code> — {op.kind} —{' '}
                    {op.type === 'create' && `${op.parentPath}/${op.name}`}
                    {op.type === 'rename' && `${op.fromPath} → ${op.toPath}`}
                    {op.type === 'move' && `${op.fromPath} → ${op.toParentPath}`}
                    {op.type === 'delete' && op.atPath}
                  </li>
                ))}
              </ul>
              <textarea readOnly value={JSON.stringify(liveDiff, null, 2)} />
            </>
          ) : (
            <p>No pending changes.</p>
          )}
        </section>
      </div>
      <footer className="sandbox-status">
        <span>Selection: {selectedIds.length}</span>
        <span>Pending ops: {liveDiff?.ops.length ?? 0}</span>
        <span>{liveDiff && liveDiff.ops.length > 0 ? 'Unsaved changes' : 'No changes'}</span>
      </footer>
      {moveDialog.open && tree && (
        <div className="move-dialog">
          <div className="move-card">
            <h3>Move selection</h3>
            <select
              value={moveDialog.targetId ?? ''}
              onChange={(event) => setMoveDialog({ open: true, targetId: event.target.value })}
            >
              {folderOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.path}
                </option>
              ))}
            </select>
            <div className="move-actions">
              <button
                type="button"
                onClick={() => {
                  if (moveDialog.targetId) {
                    handleMove(selectedIds, moveDialog.targetId);
                  }
                  setMoveDialog({ open: false, targetId: null });
                }}
              >
                Move
              </button>
              <button type="button" onClick={() => setMoveDialog({ open: false, targetId: null })}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {contextMenu && tree && (
        <div
          className="context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            type="button"
            onClick={() => handleCreate(resolveContextParent(contextMenu.nodeId), 'folder')}
          >
            New folder here
          </button>
          <button
            type="button"
            onClick={() => handleCreate(resolveContextParent(contextMenu.nodeId), 'file')}
          >
            New file here
          </button>
          <button type="button" onClick={() => setRenamingId(contextMenu.nodeId)}>
            Rename
          </button>
          {contextNode?.parentId && (
            <button type="button" onClick={() => handleDelete([contextMenu.nodeId])}>
              Delete
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setMoveDialog({ open: true, targetId: resolveContextParent(contextMenu.nodeId) });
              setContextMenu(null);
            }}
          >
            Move selection here…
          </button>
        </div>
      )}
    </div>
  );
};

export default FileSandboxApp;
