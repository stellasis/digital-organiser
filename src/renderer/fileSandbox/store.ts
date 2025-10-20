import { buildSandboxTree } from './tree';
import { generateDiff } from './diff';
import type { Snapshot } from '../../types/snapshot';
import type {
  Diff,
  DiffApplyResponse,
  DiffDryRunReport,
} from '../../types/diff';
import type { AiBatchResult, AiOrganiseRequest } from '../../types/ai';
import type { SandboxTree } from './tree';

export interface SandboxServices {
  requestSnapshot?: (rootPath: string) => Promise<Snapshot>;
  createSnapshot?: (rootPath: string) => Promise<Snapshot>;
  previewDiff: (diff: Diff) => Promise<{ ok: boolean; dryRunReport: DiffDryRunReport }>;
  applyDiff: (diff: Diff) => Promise<DiffApplyResponse>;
  organiseWithAi?: (request: AiOrganiseRequest) => Promise<AiBatchResult>;
}

export interface SandboxState {
  tree: SandboxTree | null;
  diff: Diff | null;
  rootPath: string | null;
  snapshotVersion: string | null;
  snapshotFile: string | null;
  setTree: (tree: SandboxTree) => void;
  loadSnapshot: (snapshot: Snapshot) => void;
  previewCurrentDiff: () => Promise<{ ok: boolean; dryRunReport: DiffDryRunReport }>;
  applyCurrentDiff: () => Promise<DiffApplyResponse>;
}

export interface SandboxStore {
  getState: () => SandboxState;
  setState: (updater: Partial<SandboxState> | ((state: SandboxState) => Partial<SandboxState>)) => void;
  subscribe: (listener: (state: SandboxState) => void) => () => void;
}

export const createSandboxStore = (services: SandboxServices): SandboxStore => {
  let state: SandboxState = {
    tree: null,
    diff: null,
    rootPath: null,
    snapshotVersion: null,
    snapshotFile: null,
    setTree(tree) {
      update({ tree });
    },
    loadSnapshot(snapshot) {
      const tree = buildSandboxTree(snapshot);
      update({
        tree,
        diff: null,
        rootPath: snapshot.rootPath,
        snapshotVersion: snapshot.version ?? null,
        snapshotFile: snapshot.persistedPath ?? null,
      });
    },
    async previewCurrentDiff() {
      if (!state.tree) throw new Error('No tree loaded');
      const diff = generateDiff(state.tree);
      update({ diff });
      return services.previewDiff(diff);
    },
    async applyCurrentDiff() {
      const diff = state.diff ?? (state.tree ? generateDiff(state.tree) : null);
      if (!diff) throw new Error('No diff computed');
      const result = await services.applyDiff(diff);
      if (result.snapshot) {
        state.loadSnapshot(result.snapshot);
      }
      return result;
    },
  };

  const listeners = new Set<(s: SandboxState) => void>();

  const update = (
    partial: Partial<SandboxState> | ((state: SandboxState) => Partial<SandboxState>),
  ) => {
    const partialState = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...partialState };
    listeners.forEach((listener) => listener(state));
  };

  return {
    getState: () => state,
    setState: update,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
