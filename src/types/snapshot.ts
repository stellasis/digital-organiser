export type NodeKind = 'file' | 'folder';

export interface SnapshotNode {
  id: string;
  name: string;
  kind: NodeKind;
  children?: SnapshotNode[];
}

export interface Snapshot {
  rootPath: string;
  tree: SnapshotNode;
}
