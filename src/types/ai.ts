import type { NodeKind } from './snapshot';
import type {
  AiOrganisationPlan,
  HierarchyProposal,
  PlacementResponse,
} from './aiResponseSchema';

export type AiMode = 'production' | 'refinement' | 'local';

export interface AiSnapshotEntry {
  /** Relative path from the selected root, using forward slashes. */
  path: string;
  /** Display name of the file or folder. */
  name: string;
  kind: NodeKind;
  /** Depth from the root (root === 0). */
  depth: number;
  /** Sorted list of child names for folders. */
  children?: string[];
  /** Smart stop flags applied to this node. */
  flags?: string[];
  /** Optional contextual note about why traversal stopped. */
  note?: string | null;
}

export interface AiSnapshotSlice {
  entries: AiSnapshotEntry[];
  /** Sequential index of this slice starting at 0. */
  index: number;
  /** Approximate character size of the serialised slice. */
  approxChars: number;
}

export type AiState = Record<string, unknown>;

export interface AiSummary {
  text?: string;
  highlights?: string[];
  sections?: { title?: string; body: string }[];
}

export interface AiBatchRequestPayload {
  meta: {
    batch_id: string;
    mode: AiMode;
    model: string;
    cursor?: { token?: string; index: number };
    state_hash_in?: string;
  };
  snapshot: {
    slice: AiSnapshotEntry[];
  };
  prefs: {
    free_text: string;
    constraints?: Record<string, unknown> | null;
  };
  state_in: AiState;
}

export interface AiBatchResponsePayload {
  meta?: {
    batch_id?: string;
    cursor?: { next?: string };
    state_hash_out?: string;
  };
  state_out?: AiState;
  summary?: AiSummary;
  diagnostics?: Record<string, unknown>;
}

export interface AiBatchResult {
  batchId: string;
  model: string;
  mode: AiMode;
  slices: number;
  entries: number;
  state: AiState;
  summary: AiSummary | null;
  responses: AiBatchResponsePayload[];
  organisationPlan: AiOrganisationPlan | null;
  organisationProposal: HierarchyProposal | null;
  placementResponse?: PlacementResponse | null;
}

export interface AiOrganiseRequest {
  rootPath: string;
  mode?: AiMode;
  freeText?: string;
  constraints?: Record<string, unknown>;
  state?: AiState;
  /**
   * When true the orchestrator will run the hierarchy proposal and file placement
   * stages separately. Large trees automatically opt-in unless overridden.
   */
  useTwoStagePipeline?: boolean;
  /** Optional override for deciding when to auto enable the two-stage flow. */
  twoStageThreshold?: number;
}

