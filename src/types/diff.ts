import type { NodeKind, Snapshot } from './snapshot';

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

export type DiffDryRunPrecondition =
  | 'ok'
  | 'missing-source'
  | 'target-exists'
  | 'error';

export interface DiffDryRunOperationReport {
  op: DiffOp;
  targetPath: string;
  description: string;
  precondition: DiffDryRunPrecondition;
  message?: string;
}

export interface DiffDryRunReport {
  baseRoot: string;
  rootName: string;
  operations: DiffDryRunOperationReport[];
  issues: string[];
}

export type DiffApplyOperationStatus = 'applied' | 'skipped' | 'failed' | 'aborted';

export interface DiffApplyOperationResult {
  type: DiffOp['type'];
  kind: NodeKind;
  status: DiffApplyOperationStatus;
  targetPath: string;
  message?: string;
}

export interface DiffApplyResponse {
  ok: boolean;
  results: DiffApplyOperationResult[];
  dryRunReport?: DiffDryRunReport;
  snapshot?: Snapshot;
  snapshotVersion?: string;
  snapshotFile?: string;
  aborted?: boolean;
  error?: string;
}
