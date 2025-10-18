import type { NodeKind } from './snapshot';

export interface RenameOp {
  type: 'rename';
  id: string;
  kind: NodeKind;
  fromPath: string;
  toPath: string;
  fromName: string;
  toName: string;
}

export interface MoveOp {
  type: 'move';
  id: string;
  kind: NodeKind;
  fromPath: string;
  toParentPath: string;
}

export interface DeleteOp {
  type: 'delete';
  id: string;
  kind: NodeKind;
  atPath: string;
  recursive?: boolean;
}

export interface CreateOp {
  type: 'create';
  parentPath: string;
  name: string;
  kind: NodeKind;
}

export type DiffOp = RenameOp | MoveOp | DeleteOp | CreateOp;

export interface Diff {
  baseRoot: string;
  ops: DiffOp[];
  meta: { createdAtIso: string; uid: string };
}
