import { buildSandboxTree } from './tree';
import { generateDiff } from './diff';
import type { Snapshot } from '../../types/snapshot';
import type { Diff } from '../../types/diff';
import type { SandboxTree } from './tree';

export interface SandboxServices {
  requestSnapshot?: (rootPath: string) => Promise<Snapshot>;
  previewDiff: (diff: Diff) => Promise<{ ok: boolean; dryRunReport: any }>;
  applyDiff: (diff: Diff) => Promise<{ ok: boolean; results: any[] }>;
}

export interface SandboxState {
  tree: SandboxTree | null;
  diff: Diff | null;
  setTree: (tree: SandboxTree) => void;
  loadSnapshot: (snapshot: Snapshot) => void;
  previewCurrentDiff: () => Promise<{ ok: boolean; dryRunReport: any }>;
  applyCurrentDiff: () => Promise<{ ok: boolean; results: any[] }>;
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
    setTree(tree) {
      update({ tree });
    },
    loadSnapshot(snapshot) {
      const tree = buildSandboxTree(snapshot);
      update({ tree, diff: null });
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
      return services.applyDiff(diff);
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
