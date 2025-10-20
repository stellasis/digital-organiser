/*
 * Schema and type definitions for the organiser AI responses.
 *
 * We support two orchestration strategies:
 *   1. A single response that contains the full hierarchy and
 *      concrete file operations ("single-stage").
 *   2. A staged response where the first pass proposes a hierarchy
 *      and a follow-up inference classifies every file into that
 *      hierarchy ("two-stage").
 *
 * The orchestrator decides which strategy to apply at runtime. We keep
 * these definitions colocated to make it trivial to fan out to
 * additional stages in the future (for example a rename validator or
 * clean-up pass).
 */

export type FileOperationKind = 'move' | 'rename' | 'group' | 'create';

export interface FileOperationBase {
  kind: FileOperationKind;
  /** Relative source path from the selected root. */
  src?: string;
  /** Relative destination path from the selected root. */
  dst?: string;
  /** Optional free-form explanation that can be surfaced in the UI. */
  rationale?: string;
  /** Optional confidence score between 0 and 1. */
  confidence?: number;
}

export interface MoveFileOperation extends FileOperationBase {
  kind: 'move';
  src: string;
  dst: string;
}

export interface RenameFileOperation extends FileOperationBase {
  kind: 'rename';
  src: string;
  dst: string;
}

export interface GroupFileOperation extends FileOperationBase {
  kind: 'group';
  /** Identifier for the logical group that should be created. */
  group: string;
  /** Members that should be placed inside the group (relative paths). */
  members: string[];
}

export interface CreateFileOperation extends FileOperationBase {
  kind: 'create';
  /** The path that should be created. */
  dst: string;
  template?: string;
}

export type FileOperation =
  | MoveFileOperation
  | RenameFileOperation
  | GroupFileOperation
  | CreateFileOperation;

export interface HierarchyNode {
  /** The canonical path for this node relative to the root. */
  path: string;
  /** Optional display name (can differ from the path basename). */
  title?: string;
  /** Optional descriptive summary for the node. */
  summary?: string;
  /** Topics or tags that describe the contents of this node. */
  topics?: string[];
  /** Optional children that expand the hierarchy. */
  children?: HierarchyNode[];
  /** Whether this node should be highlighted/pinned in the UI. */
  pinned?: boolean;
  /** Optional weighting that hints at the importance of this node. */
  priority?: number;
}

export interface AiPlanSummary {
  headline?: string;
  counts?: Partial<Record<FileOperationKind | 'total', number>>;
  notes?: string[];
}

export interface UnifiedAiPlan {
  strategy: 'single-stage';
  version: string;
  meta?: Record<string, unknown>;
  hierarchy: HierarchyNode[];
  operations: FileOperation[];
  summary?: AiPlanSummary;
}

export interface PlacementFileDescriptor {
  path: string;
  kind: 'file' | 'folder';
  display_name?: string;
  extension?: string;
  tokens?: string[];
  size_bytes?: number;
  modified_at?: string;
  parent_path?: string;
  hints?: string[];
}

export interface PlacementRequest {
  hierarchy: HierarchyNode[];
  unassigned_files: PlacementFileDescriptor[];
  /** Additional knobs that tune placement preferences. */
  preferences?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface HierarchyProposal {
  strategy: 'two-stage';
  stage: 'proposal';
  version: string;
  meta?: Record<string, unknown>;
  hierarchy: HierarchyNode[];
  summary?: AiPlanSummary;
  /** Stage 2 should receive this object verbatim. */
  placementRequest: PlacementRequest;
}

export interface FileMapping {
  src: string;
  dst: string;
  confidence?: number;
  rationale?: string;
}

export interface PlacementResponse {
  strategy: 'two-stage';
  stage: 'placement';
  version: string;
  file_mapping: FileMapping[];
  operations?: FileOperation[];
  summary?: AiPlanSummary;
  diagnostics?: Record<string, unknown>;
}

export interface CompletedPlacementPlan {
  strategy: 'two-stage';
  stage: 'completed';
  version: string;
  hierarchy: HierarchyNode[];
  file_mapping: FileMapping[];
  operations: FileOperation[];
  summary?: AiPlanSummary;
  meta?: Record<string, unknown>;
  proposal: HierarchyProposal;
  placement: PlacementResponse;
}

export type AiOrganisationPlan = UnifiedAiPlan | CompletedPlacementPlan;

export const hierarchyNodeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path'],
  properties: {
    path: { type: 'string' },
    title: { type: 'string' },
    summary: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
    children: { $ref: '#/definitions/hierarchyNode' },
    pinned: { type: 'boolean' },
    priority: { type: 'number' },
  },
  definitions: {} as Record<string, unknown>,
} as const;

// Provide recursive reference now that the object exists.
(hierarchyNodeSchema.definitions as Record<string, unknown>).hierarchyNode = {
  type: 'array',
  items: hierarchyNodeSchema,
};

export const fileOperationSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'src', 'dst'],
      properties: {
        kind: { const: 'move' },
        src: { type: 'string' },
        dst: { type: 'string' },
        rationale: { type: 'string' },
        confidence: { type: 'number' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'src', 'dst'],
      properties: {
        kind: { const: 'rename' },
        src: { type: 'string' },
        dst: { type: 'string' },
        rationale: { type: 'string' },
        confidence: { type: 'number' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'group', 'members'],
      properties: {
        kind: { const: 'group' },
        group: { type: 'string' },
        members: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' },
        confidence: { type: 'number' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'dst'],
      properties: {
        kind: { const: 'create' },
        dst: { type: 'string' },
        template: { type: 'string' },
        rationale: { type: 'string' },
        confidence: { type: 'number' },
      },
    },
  ],
} as const;

export const unifiedPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['strategy', 'version', 'hierarchy', 'operations'],
  properties: {
    strategy: { const: 'single-stage' },
    version: { type: 'string' },
    meta: { type: 'object' },
    hierarchy: { type: 'array', items: hierarchyNodeSchema },
    operations: { type: 'array', items: fileOperationSchema },
    summary: {
      type: 'object',
      additionalProperties: false,
      properties: {
        headline: { type: 'string' },
        counts: { type: 'object' },
        notes: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const;

export const placementFileDescriptorSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'kind'],
  properties: {
    path: { type: 'string' },
    kind: { enum: ['file', 'folder'] },
    display_name: { type: 'string' },
    extension: { type: 'string' },
    tokens: { type: 'array', items: { type: 'string' } },
    size_bytes: { type: 'number' },
    modified_at: { type: 'string' },
    parent_path: { type: 'string' },
    hints: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const placementRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hierarchy', 'unassigned_files'],
  properties: {
    hierarchy: { type: 'array', items: hierarchyNodeSchema },
    unassigned_files: { type: 'array', items: placementFileDescriptorSchema },
    preferences: { type: 'object' },
    meta: { type: 'object' },
  },
} as const;

export const hierarchyProposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['strategy', 'stage', 'version', 'hierarchy', 'placementRequest'],
  properties: {
    strategy: { const: 'two-stage' },
    stage: { const: 'proposal' },
    version: { type: 'string' },
    meta: { type: 'object' },
    hierarchy: { type: 'array', items: hierarchyNodeSchema },
    summary: unifiedPlanSchema.properties?.summary,
    placementRequest: placementRequestSchema,
  },
} as const;

export const fileMappingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['src', 'dst'],
  properties: {
    src: { type: 'string' },
    dst: { type: 'string' },
    confidence: { type: 'number' },
    rationale: { type: 'string' },
  },
} as const;

export const placementResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['strategy', 'stage', 'version', 'file_mapping'],
  properties: {
    strategy: { const: 'two-stage' },
    stage: { const: 'placement' },
    version: { type: 'string' },
    file_mapping: { type: 'array', items: fileMappingSchema },
    operations: { type: 'array', items: fileOperationSchema },
    summary: unifiedPlanSchema.properties?.summary,
    diagnostics: { type: 'object' },
  },
} as const;

export const completedPlacementPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'strategy',
    'stage',
    'version',
    'hierarchy',
    'file_mapping',
    'operations',
    'proposal',
    'placement',
  ],
  properties: {
    strategy: { const: 'two-stage' },
    stage: { const: 'completed' },
    version: { type: 'string' },
    hierarchy: { type: 'array', items: hierarchyNodeSchema },
    file_mapping: { type: 'array', items: fileMappingSchema },
    operations: { type: 'array', items: fileOperationSchema },
    summary: unifiedPlanSchema.properties?.summary,
    meta: { type: 'object' },
    proposal: hierarchyProposalSchema,
    placement: placementResponseSchema,
  },
} as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isHierarchyNode = (value: unknown): value is HierarchyNode => {
  if (!isObject(value) || typeof value.path !== 'string') {
    return false;
  }
  if (value.children) {
    if (!Array.isArray(value.children) || !value.children.every(isHierarchyNode)) {
      return false;
    }
  }
  if (value.topics && (!Array.isArray(value.topics) || !value.topics.every((topic) => typeof topic === 'string'))) {
    return false;
  }
  return true;
};

const isFileOperation = (value: unknown): value is FileOperation => {
  if (!isObject(value) || typeof value.kind !== 'string') {
    return false;
  }
  switch (value.kind) {
    case 'move':
    case 'rename':
      return typeof value.src === 'string' && typeof value.dst === 'string';
    case 'group':
      return typeof value.group === 'string' && Array.isArray(value.members);
    case 'create':
      return typeof value.dst === 'string';
    default:
      return false;
  }
};

const isPlacementFileDescriptor = (value: unknown): value is PlacementFileDescriptor =>
  isObject(value) && typeof value.path === 'string' && (value.kind === 'file' || value.kind === 'folder');

export const isUnifiedPlan = (value: unknown): value is UnifiedAiPlan => {
  if (!isObject(value)) {
    return false;
  }
  if (value.strategy !== 'single-stage' || typeof value.version !== 'string') {
    return false;
  }
  if (!Array.isArray(value.hierarchy) || !value.hierarchy.every(isHierarchyNode)) {
    return false;
  }
  if (!Array.isArray(value.operations) || !value.operations.every(isFileOperation)) {
    return false;
  }
  return true;
};

export const isHierarchyProposal = (value: unknown): value is HierarchyProposal => {
  if (!isObject(value)) {
    return false;
  }
  if (value.strategy !== 'two-stage' || value.stage !== 'proposal' || typeof value.version !== 'string') {
    return false;
  }
  if (!Array.isArray(value.hierarchy) || !value.hierarchy.every(isHierarchyNode)) {
    return false;
  }
  const requestCandidate = value.placementRequest;
  if (!isObject(requestCandidate)) {
    return false;
  }
  const hierarchy = (requestCandidate as Record<string, unknown>).hierarchy as unknown;
  const unassigned = (requestCandidate as Record<string, unknown>).unassigned_files as unknown;
  return (
    Array.isArray(hierarchy) &&
    (hierarchy as unknown[]).every(isHierarchyNode) &&
    Array.isArray(unassigned) &&
    (unassigned as unknown[]).every(isPlacementFileDescriptor)
  );
};

export const isPlacementResponse = (value: unknown): value is PlacementResponse => {
  if (!isObject(value)) {
    return false;
  }
  if (value.strategy !== 'two-stage' || value.stage !== 'placement' || typeof value.version !== 'string') {
    return false;
  }
  if (!Array.isArray(value.file_mapping) || !value.file_mapping.every((mapping) =>
      isObject(mapping) && typeof mapping.src === 'string' && typeof mapping.dst === 'string')) {
    return false;
  }
  if (value.operations && (!Array.isArray(value.operations) || !value.operations.every(isFileOperation))) {
    return false;
  }
  return true;
};

export const mergePlacementPlan = (
  proposal: HierarchyProposal,
  response: PlacementResponse,
): CompletedPlacementPlan => ({
  strategy: 'two-stage',
  stage: 'completed',
  version: response.version ?? proposal.version,
  hierarchy: proposal.hierarchy,
  file_mapping: response.file_mapping,
  operations: response.operations ?? [],
  summary: response.summary ?? proposal.summary,
  meta: proposal.meta,
  proposal,
  placement: response,
});

export interface ParsedOrganisationState {
  unifiedPlan: UnifiedAiPlan | null;
  proposal: HierarchyProposal | null;
  completedPlan: CompletedPlacementPlan | null;
}

export const parseOrganisationState = (state: unknown): ParsedOrganisationState => {
  if (!isObject(state)) {
    return { unifiedPlan: null, proposal: null, completedPlan: null };
  }

  if (isUnifiedPlan(state)) {
    return { unifiedPlan: state, proposal: null, completedPlan: null };
  }

  if (isHierarchyProposal(state)) {
    return { unifiedPlan: null, proposal: state, completedPlan: null };
  }

  if (isObject(state) && state.stage === 'completed' && state.strategy === 'two-stage') {
    const candidate = state as Record<string, unknown>;
    const hierarchy = candidate.hierarchy as unknown;
    const fileMapping = candidate.file_mapping as unknown;
    const operations = candidate.operations as unknown;
    const proposal = candidate.proposal as unknown;
    const placement = candidate.placement as unknown;
    if (
      Array.isArray(hierarchy) &&
      (hierarchy as unknown[]).every(isHierarchyNode) &&
      Array.isArray(fileMapping) &&
      (fileMapping as unknown[]).every(
        (mapping) => isObject(mapping) && typeof mapping.src === 'string' && typeof mapping.dst === 'string',
      ) &&
      Array.isArray(operations) &&
      (operations as unknown[]).every(isFileOperation) &&
      proposal &&
      placement &&
      isHierarchyProposal(proposal) &&
      isPlacementResponse(placement)
    ) {
      const completed: CompletedPlacementPlan = {
        strategy: 'two-stage',
        stage: 'completed',
        version: typeof candidate.version === 'string' ? candidate.version : placement.version,
        hierarchy: hierarchy as HierarchyNode[],
        file_mapping: fileMapping as FileMapping[],
        operations: operations as FileOperation[],
        summary: candidate.summary as AiPlanSummary | undefined,
        meta: candidate.meta as Record<string, unknown> | undefined,
        proposal,
        placement,
      };
      return { unifiedPlan: null, proposal: null, completedPlan: completed };
    }
  }

  return { unifiedPlan: null, proposal: null, completedPlan: null };
};

