import crypto from 'crypto';
import util from 'util';
import type {
  AiBatchRequestPayload,
  AiBatchResponsePayload,
  AiBatchResult,
  AiMode,
  AiOrganiseRequest,
  AiSnapshotEntry,
  AiState,
  AiSummary,
} from '../../types/ai';
import type {
  AiOrganisationPlan,
  HierarchyNode,
  HierarchyProposal,
  PlacementRequest,
  PlacementResponse,
  FileMapping,
  FileOperation,
} from '../../types/aiResponseSchema';
import {
  mergePlacementPlan,
  parseOrganisationState,
  isPlacementResponse,
} from '../../types/aiResponseSchema';
import { resolveModelConfig, type AiModelConfig } from './modelConfig';
import { streamSnapshotEntries } from './snapshotStream';
import { sliceSnapshotEntries } from './snapshotSlicer';
import { estimateTokensForJson, truncateTextForTokenBudget } from './tokenBudget';
import {
  logBatchStart,
  logRequest,
  logResponse,
  logMerge,
  logSummary,
  logError,
  type RequestLogContext,
} from '../../utils/aiLogger';

export interface RunAiBatchOptions extends AiOrganiseRequest {
  fetchImpl?: typeof fetch;
  modelConfigOverride?: Partial<AiModelConfig>;
  entryStreamFactory?: () => AsyncIterable<AiSnapshotEntry>;
}

// We default to the two-stage pipeline for large roots because it keeps the
// first pass focused on taxonomy design and defers the token-heavy placement
// work. Smaller snapshots can opt back into a single response via
// `useTwoStagePipeline: false`.
const DEFAULT_TWO_STAGE_THRESHOLD = 400;

const INSPECT_USE_COLOR = Boolean(process.stdout?.isTTY);
const HIERARCHY_PREVIEW_LIMIT = 6;
const OPERATIONS_PREVIEW_LIMIT = 6;
const FILE_MAPPING_PREVIEW_LIMIT = 8;
const UNASSIGNED_PREVIEW_LIMIT = 6;

const indentBlock = (value: string, indent = '      ') =>
  value
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');

const inspectValue = (value: unknown, options: util.InspectOptions = {}) =>
  util.inspect(value, {
    depth: 6,
    breakLength: 100,
    maxArrayLength: options.maxArrayLength,
    colors: INSPECT_USE_COLOR,
    ...options,
  });

const logPreviewList = <T>(
  label: string,
  items: T[] | undefined,
  limit: number,
  itemLabel: string,
) => {
  if (!items || items.length === 0) {
    return;
  }
  const shown = items.slice(0, limit);
  console.log(`   ${label} (${Math.min(shown.length, limit)} of ${items.length} ${itemLabel}${
    items.length === 1 ? '' : 's'
  }):`);
  console.log(indentBlock(inspectValue(shown, { maxArrayLength: limit })));
  if (items.length > limit) {
    console.log(indentBlock(`… +${items.length - limit} more ${itemLabel}${
      items.length - limit === 1 ? '' : 's'
    }`));
  }
};

const logHierarchyPreview = (hierarchy: HierarchyNode[] | undefined, context: string) => {
  if (!hierarchy?.length) {
    return;
  }
  logPreviewList(`${context} hierarchy`, hierarchy, HIERARCHY_PREVIEW_LIMIT, 'node');
};

const logOperationsPreview = (operations: FileOperation[] | undefined, context: string) => {
  if (!operations?.length) {
    return;
  }
  logPreviewList(`${context} operations`, operations, OPERATIONS_PREVIEW_LIMIT, 'operation');
};

const logFileMappingPreview = (mappings: FileMapping[] | undefined, context: string) => {
  if (!mappings?.length) {
    return;
  }
  logPreviewList(`${context} file mappings`, mappings, FILE_MAPPING_PREVIEW_LIMIT, 'mapping');
};

const logUnassignedPreview = (files: PlacementRequest['unassigned_files'], context: string) => {
  if (!files?.length) {
    return;
  }
  logPreviewList(`${context} unassigned files`, files, UNASSIGNED_PREVIEW_LIMIT, 'entry');
};

const mergeState = (base: AiState, incoming?: AiState): AiState => {
  if (!incoming) {
    return base;
  }
  const next: AiState = { ...base };
  Object.entries(incoming).forEach(([key, value]) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof next[key] === 'object' &&
      next[key] !== null &&
      !Array.isArray(next[key])
    ) {
      next[key] = mergeState(next[key] as AiState, value as AiState);
    } else {
      next[key] = value;
    }
  });
  return next;
};

const mergeSummary = (base: AiSummary | null, incoming?: AiSummary): AiSummary | null => {
  if (!incoming) return base;
  if (!base) return { ...incoming };
  const merged: AiSummary = {
    text: [base.text, incoming.text].filter(Boolean).join('\n\n') || undefined,
    highlights: [...(base.highlights ?? []), ...(incoming.highlights ?? [])],
    sections: [...(base.sections ?? []), ...(incoming.sections ?? [])],
  };
  if (!merged.highlights?.length) {
    delete merged.highlights;
  }
  if (!merged.sections?.length) {
    delete merged.sections;
  }
  if (!merged.text) {
    delete merged.text;
  }
  return merged;
};

const createBatchId = () => crypto.randomUUID?.() ?? `batch-${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

const HEADROOM_RATIO = 0.1;
const PREFS_RATIO = 0.1;
const SNAPSHOT_RATIO = 0.8;

const ensureBudgets = (maxTokens: number) => {
  const snapshotBudget = Math.floor(maxTokens * SNAPSHOT_RATIO);
  const prefsBudget = Math.floor(maxTokens * PREFS_RATIO);
  const headroom = Math.floor(maxTokens * HEADROOM_RATIO);
  return { snapshotBudget, prefsBudget, headroom };
};

const countTopLevelCategories = (hierarchy: HierarchyNode[]): number => {
  if (!hierarchy.length) {
    return 0;
  }
  const buckets = new Set<string>();
  hierarchy.forEach((node) => {
    const normalised = node.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const [head] = normalised.split('/').filter(Boolean);
    buckets.add(head ?? normalised);
  });
  return buckets.size || hierarchy.length;
};

const countPlacementTargets = (mappings: FileMapping[]): number => {
  if (!mappings.length) {
    return 0;
  }
  const buckets = new Set<string>();
  mappings.forEach((mapping) => {
    const normalised = mapping.dst.replace(/\\/g, '/');
    const parts = normalised.split('/').filter(Boolean);
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : parts[0] ?? normalised;
    buckets.add(folder);
  });
  return buckets.size;
};

const buildPlacementRequest = (
  proposal: HierarchyProposal,
  rootPath: string,
  mode: AiMode,
): PlacementRequest => ({
  ...proposal.placementRequest,
  hierarchy:
    proposal.placementRequest.hierarchy && proposal.placementRequest.hierarchy.length > 0
      ? proposal.placementRequest.hierarchy
      : proposal.hierarchy,
  meta: {
    ...(proposal.placementRequest.meta ?? {}),
    root: rootPath,
    pipeline: 'two-stage',
    stage: 'placement',
    proposal_version: proposal.version,
    mode,
  },
});

const buildRequestPayload = (
  sliceEntries: AiSnapshotEntry[],
  options: {
    batchId: string;
    model: AiModelConfig;
    sliceIndex: number;
    cursorToken?: string;
    freeText: string;
    constraints?: Record<string, unknown>;
    stateHash?: string;
    stateIn: AiState;
  },
): AiBatchRequestPayload => ({
  meta: {
    batch_id: options.batchId,
    mode: options.model.mode,
    model: options.model.model,
    cursor: options.cursorToken ? { token: options.cursorToken, index: options.sliceIndex } : { index: options.sliceIndex },
    state_hash_in: options.stateHash,
  },
  snapshot: {
    slice: sliceEntries,
  },
  prefs: {
    free_text: options.freeText,
    constraints: options.constraints ?? null,
  },
  state_in: options.stateIn,
});

const adaptRequestBody = (payload: AiBatchRequestPayload, config: AiModelConfig) => {
  if (config.requestAdapter) {
    return config.requestAdapter(payload);
  }
  return payload;
};

const adaptResponseBody = (payload: unknown, config: AiModelConfig): AiBatchResponsePayload => {
  if (config.responseAdapter) {
    return config.responseAdapter(payload) as AiBatchResponsePayload;
  }
  return payload as AiBatchResponsePayload;
};

const sendBatch = async (
  config: AiModelConfig,
  payload: AiBatchRequestPayload,
  fetchImpl: typeof fetch,
  context: RequestLogContext,
): Promise<AiBatchResponsePayload> => {
  const requestBody = adaptRequestBody(payload, config);
  const startedAt = context.startedAt ?? Date.now();
  let response: Response | undefined;
  let rawText: string | undefined;
  let parsedBody: unknown;
  try {
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(requestBody),
    });

    const durationMs = Date.now() - startedAt;
    rawText = await response.text();
    if (rawText) {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = rawText;
      }
    }

    if (!response.ok) {
      logError(new Error(`AI request failed with ${response.status}`), {
        batchId: context.batchId,
        sliceIndex: context.sliceIndex,
        model: context.model,
        mode: context.mode,
        stage: 'response',
        status: response.status,
        payloadSnippet: context.payloadPreview,
        responseSnippet: parsedBody ?? rawText,
        durationMs,
      });
      throw new Error(`AI request failed with ${response.status}: ${rawText}`);
    }

    const adapted = adaptResponseBody(parsedBody ?? {}, config);
    logResponse({
      ...context,
      status: response.status,
      durationMs,
      response: adapted,
      rawBody: parsedBody,
      headers: response.headers,
    });
    return adapted;
  } catch (error) {
    if (!(error as Error & { __aiLoggerLogged?: boolean }).__aiLoggerLogged) {
      logError(error, {
        batchId: context.batchId,
        sliceIndex: context.sliceIndex,
        model: context.model,
        mode: context.mode,
        stage: response ? 'response' : 'request',
        status: response?.status,
        payloadSnippet: context.payloadPreview,
        responseSnippet: parsedBody ?? rawText,
        durationMs: Date.now() - startedAt,
      });
    }
    throw error;
  }
};

const sendPlacementRequest = async (
  config: AiModelConfig,
  payload: PlacementRequest,
  fetchImpl: typeof fetch,
  context: { batchId: string; mode: AiMode; model: string },
): Promise<PlacementResponse> => {
  const startedAt = Date.now();
  let response: Response | undefined;
  let rawText: string | undefined;
  let parsedBody: unknown;
  try {
    const requestBody = config.requestAdapter ? config.requestAdapter(payload) : payload;
    response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(requestBody),
    });

    rawText = await response.text();
    if (rawText) {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = rawText;
      }
    }

    if (!response.ok) {
      logError(new Error('AI placement request failed'), {
        batchId: context.batchId,
        model: context.model,
        mode: context.mode,
        stage: 'placement-response',
        status: response.status,
        payloadSnippet: payload,
        responseSnippet: parsedBody ?? rawText,
        durationMs: Date.now() - startedAt,
      });
      throw new Error(`AI placement request failed with ${response.status}`);
    }

    const adapted = config.responseAdapter ? config.responseAdapter(parsedBody ?? rawText ?? {}) : parsedBody ?? rawText ?? {};
    if (!isPlacementResponse(adapted)) {
      throw new Error('AI placement response did not match the expected schema.');
    }
    return adapted;
  } catch (error) {
    if (!(error as Error & { __aiLoggerLogged?: boolean }).__aiLoggerLogged) {
      logError(error, {
        batchId: context.batchId,
        model: context.model,
        mode: context.mode,
        stage: 'placement-request',
      });
    }
    throw error;
  }
};

export const runAiBatchOrganisation = async (
  options: RunAiBatchOptions,
): Promise<AiBatchResult> => {
  const {
    rootPath,
    mode = (process.env.AI_MODEL_MODE as AiMode) ?? 'local',
    freeText = '',
    constraints,
    state: initialState = {},
    fetchImpl = fetch,
    modelConfigOverride,
    entryStreamFactory,
    useTwoStagePipeline,
    twoStageThreshold,
  } = options;

  const model = resolveModelConfig(mode, modelConfigOverride);
  const batchId = createBatchId();
  const budgets = ensureBudgets(model.maxInputTokens);
  const truncatedFreeText = truncateTextForTokenBudget(freeText, budgets.prefsBudget);

  const entryStream = entryStreamFactory
    ? entryStreamFactory()
    : streamSnapshotEntries({ rootPath });

  const sliceGenerator = sliceSnapshotEntries(entryStream, { maxTokens: budgets.snapshotBudget });

  let accumulatedState: AiState = { ...initialState };
  let summary: AiSummary | null = null;
  const responses: AiBatchResponsePayload[] = [];
  let cursorToken: string | undefined;
  let stateHash: string | undefined;
  let totalEntries = 0;
  let sliceCount = 0;
  const startedAt = Date.now();
  let failure: Error | null = null;
  let organisationPlan: AiOrganisationPlan | null = null;
  let organisationProposal: HierarchyProposal | null = null;
  let placementResponse: PlacementResponse | null = null;

  try {
    for await (const slice of sliceGenerator) {
      const estimatedTokens = estimateTokensForJson(slice.entries);
      logBatchStart({
        batchId,
        sliceIndex: slice.index,
        entryCount: slice.entries.length,
        approxChars: slice.approxChars,
        estimatedTokens,
        model: model.model,
        mode: model.mode,
        cursorToken,
        sampleEntries: slice.entries,
      });

      totalEntries += slice.entries.length;

      const payload = buildRequestPayload(slice.entries, {
        batchId,
        model,
        sliceIndex: slice.index,
        cursorToken,
        freeText: truncatedFreeText,
        constraints,
        stateHash,
        stateIn: accumulatedState,
      });

      const requestContext = logRequest({
        batchId,
        sliceIndex: slice.index,
        model: model.model,
        mode: model.mode,
        entryCount: slice.entries.length,
        estimatedTokens,
        maxTokens: model.maxInputTokens,
        payload,
        cursorToken,
      });

      const response = await sendBatch(model, payload, fetchImpl, requestContext);
      responses.push(response);
      accumulatedState = mergeState(accumulatedState, response.state_out);
      summary = mergeSummary(summary, response.summary);
      cursorToken = response.meta?.cursor?.next ?? cursorToken;
      stateHash = response.meta?.state_hash_out ?? stateHash;
      sliceCount += 1;

      logMerge({
        batchId,
        sliceIndex: slice.index,
        model: model.model,
        mode: model.mode,
        stateOut: response.state_out,
        summary: response.summary ?? undefined,
        cursorToken,
        stateHash,
        totalStateKeys: Object.keys(accumulatedState).length,
      });
    }

    const parsedOrganisation = parseOrganisationState(
      (accumulatedState as { organisation?: unknown })?.organisation,
    );
    organisationPlan = parsedOrganisation.completedPlan ?? parsedOrganisation.unifiedPlan ?? null;
    organisationProposal = parsedOrganisation.completedPlan?.proposal ?? parsedOrganisation.proposal ?? null;
    placementResponse = parsedOrganisation.completedPlan?.placement ?? null;

    // The orchestrator still understands the single-stage schema for smaller
    // trees, but the two-stage pipeline scales better: the first pass focuses
    // on taxonomy design while the follow-up specialises on file placement.
    // We therefore default to two-stage once the snapshot crosses a sensible
    // threshold unless the caller explicitly opts out.
    const preferTwoStage =
      useTwoStagePipeline ?? totalEntries >= (twoStageThreshold ?? DEFAULT_TWO_STAGE_THRESHOLD);

    const logStageOne = (hierarchy: HierarchyNode[]) => {
      const categories = countTopLevelCategories(hierarchy);
      console.log(
        `🧩 [AI Orchestrator] Stage 1: Proposed hierarchy (${categories} top-level ${
          categories === 1 ? 'category' : 'categories'
        })`,
      );
    };

    if (organisationPlan) {
      logStageOne(organisationPlan.hierarchy);
      logHierarchyPreview(organisationPlan.hierarchy, 'Stage 1');
      (accumulatedState as Record<string, unknown>).organisation = organisationPlan;
      if (organisationPlan.strategy === 'single-stage') {
        console.log(
          `🧩 [AI Orchestrator] Single-stage plan enumerated ${organisationPlan.operations.length} ` +
            `operation${organisationPlan.operations.length === 1 ? '' : 's'}.`,
        );
        logOperationsPreview(organisationPlan.operations, 'Proposed');
      } else {
        const classified = organisationPlan.file_mapping.length;
        const groups = countPlacementTargets(organisationPlan.file_mapping);
        console.log(
          `🧩 [AI Orchestrator] Stage 2: Classified ${classified} file${
            classified === 1 ? '' : 's'
          } into ${groups} group${groups === 1 ? '' : 's'}.`,
        );
        logFileMappingPreview(organisationPlan.file_mapping, 'Stage 2');
        logOperationsPreview(organisationPlan.operations, 'Resulting');
      }
    } else if (organisationProposal) {
      logStageOne(organisationProposal.hierarchy);
      logHierarchyPreview(organisationProposal.hierarchy, 'Stage 1');
      logHierarchyPreview(organisationProposal.placementRequest.hierarchy, 'Placement');
      logUnassignedPreview(organisationProposal.placementRequest.unassigned_files, 'Placement');
      if (preferTwoStage && organisationProposal.placementRequest.unassigned_files.length > 0) {
        const placementRequest = buildPlacementRequest(organisationProposal, rootPath, model.mode);
        const placementResult = await sendPlacementRequest(model, placementRequest, fetchImpl, {
          batchId,
          mode: model.mode,
          model: model.model,
        });
        placementResponse = placementResult;
        organisationPlan = mergePlacementPlan(organisationProposal, placementResult);
        organisationProposal = organisationPlan.proposal;
        (accumulatedState as Record<string, unknown>).organisation = organisationPlan;
        const classified = placementResult.file_mapping.length;
        const groups = countPlacementTargets(placementResult.file_mapping);
        console.log(
          `🧩 [AI Orchestrator] Stage 2: Classified ${classified} file${
            classified === 1 ? '' : 's'
          } into ${groups} group${groups === 1 ? '' : 's'}.`,
        );
        logFileMappingPreview(placementResult.file_mapping, 'Stage 2');
        logOperationsPreview(placementResult.operations, 'Stage 2');
      } else {
        (accumulatedState as Record<string, unknown>).organisation = organisationProposal;
        if (preferTwoStage) {
          console.log('🧩 [AI Orchestrator] Stage 2 skipped: no files required classification.');
        }
      }
    }
  } catch (error) {
    failure = error as Error;
    if (!(failure as Error & { __aiLoggerLogged?: boolean }).__aiLoggerLogged) {
      logError(failure, {
        batchId,
        model: model.model,
        mode: model.mode,
        stage: 'unknown',
      });
    }
    throw error;
  } finally {
    logSummary({
      batchId,
      model: model.model,
      mode: model.mode,
      sliceCount,
      entryCount: totalEntries,
      durationMs: Date.now() - startedAt,
      responses,
      error: failure,
    });
  }

  return {
    batchId,
    model: model.model,
    mode: model.mode,
    slices: sliceCount,
    entries: totalEntries,
    state: accumulatedState,
    summary,
    responses,
    organisationPlan,
    organisationProposal,
    placementResponse: placementResponse ?? null,
  };
};

