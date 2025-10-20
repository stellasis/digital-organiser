import crypto from 'crypto';
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
  };
};

