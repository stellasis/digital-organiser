import util from 'util';
import { bold, cyan, dim, green, magenta, red, yellow, blue } from 'colorette';
import type {
  AiBatchRequestPayload,
  AiBatchResponsePayload,
  AiMode,
  AiSnapshotEntry,
  AiState,
  AiSummary,
} from '../types/ai';

const MAX_SLICE_PREVIEW = 12;
const MAX_STATE_PREVIEW_KEYS = 6;
const MAX_TEXT_LENGTH = 240;

const numberFormatter = new Intl.NumberFormat('en-US');

const coerceBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    return ['1', 'true', 't', 'yes', 'y', 'on'].includes(normalised);
  }
  return false;
};

const isProbablyPackaged = () => {
  if (typeof process.env.ELECTRON_IS_DEV === 'string') {
    return process.env.ELECTRON_IS_DEV === '0';
  }
  if (typeof (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === 'boolean') {
    return !(process as NodeJS.Process & { defaultApp?: boolean }).defaultApp;
  }
  return false;
};

const isProductionBuild = () => {
  const nodeEnv = process.env.NODE_ENV;
  if (process.env.DEBUG_PROD === 'true') {
    return false;
  }
  if (nodeEnv && nodeEnv !== 'production') {
    return false;
  }
  return isProbablyPackaged();
};

const verboseFlagEnabled = () =>
  coerceBoolean(process.env.AI_LOG_VERBOSE) || coerceBoolean(process.env.DEBUG_AI);

const isVerboseEnabled = () => verboseFlagEnabled() && !isProductionBuild();

const shouldLogErrors = () => !isProductionBuild();

const timestamp = () => dim(new Date().toISOString());

const indentBlock = (value: string, indent = '   ') => value.split('\n').map((line) => `${indent}${line}`).join('\n');

const formatDuration = (durationMs: number) => `${(durationMs / 1000).toFixed(durationMs >= 10000 ? 1 : 2)} s`;

const formatNumber = (value: number | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? numberFormatter.format(value) : '—';

const truncateText = (text: string | undefined) => {
  if (!text) return text;
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`;
};

const copyEntry = (entry: AiSnapshotEntry): Record<string, unknown> => ({
  path: entry.path,
  name: entry.name,
  kind: entry.kind,
  depth: entry.depth,
  ...(entry.children ? { children: entry.children.slice(0, 8) } : {}),
  ...(entry.flags?.length ? { flags: entry.flags } : {}),
  ...(entry.note ? { note: entry.note } : {}),
});

const buildSlicePreview = (entries: AiSnapshotEntry[]) => {
  const preview = entries.slice(0, MAX_SLICE_PREVIEW).map((entry) => copyEntry(entry));
  if (entries.length > MAX_SLICE_PREVIEW) {
    preview.push({ note: `… truncated, +${formatNumber(entries.length - MAX_SLICE_PREVIEW)} more entries` });
  }
  return preview;
};

const buildStatePreview = (state: AiState | undefined) => {
  if (!state || typeof state !== 'object') return undefined;
  const entries = Object.entries(state);
  if (!entries.length) return {};
  const previewEntries = entries.slice(0, MAX_STATE_PREVIEW_KEYS);
  const preview: Record<string, unknown> = {};
  previewEntries.forEach(([key, value]) => {
    preview[key] = value;
  });
  if (entries.length > MAX_STATE_PREVIEW_KEYS) {
    preview['…'] = `+${formatNumber(entries.length - MAX_STATE_PREVIEW_KEYS)} more keys`;
  }
  return preview;
};

const formatJson = (value: unknown) =>
  util.inspect(value, { colors: true, depth: 6, breakLength: 80, maxArrayLength: 20 });

const buildPayloadPreview = (payload: AiBatchRequestPayload) => ({
  meta: payload.meta,
  snapshot: {
    ...payload.snapshot,
    slice: buildSlicePreview(payload.snapshot.slice ?? []),
  },
  prefs: {
    ...payload.prefs,
    free_text: truncateText(payload.prefs?.free_text ?? ''),
  },
  state_in: buildStatePreview(payload.state_in ?? undefined),
});

const modelPrefix = (model: string) => {
  const lower = model?.toLowerCase?.() ?? '';
  if (lower.includes('ollama') || lower.includes('llama') || lower.includes('local')) {
    return cyan('🧠 [LocalAI]');
  }
  return magenta('☁️ [Gemini]');
};

const emit = (header: string, details: string[] = []) => {
  const lines = [`${timestamp()} ${header}`];
  details.forEach((detail) => {
    if (detail.includes('\n')) {
      lines.push(...detail.split('\n'));
    } else {
      lines.push(`   ${detail}`);
    }
  });
  lines.forEach((line, index) => {
    if (index === 0) {
      console.log(line);
    } else if (line.startsWith('   ')) {
      console.log(line);
    } else {
      console.log(`   ${line}`);
    }
  });
};

const emitError = (header: string, details: string[] = []) => {
  const lines = [`${timestamp()} ${header}`];
  details.forEach((detail) => {
    if (detail.includes('\n')) {
      lines.push(...detail.split('\n').map((line) => `   ${line}`));
    } else {
      lines.push(`   ${detail}`);
    }
  });
  lines.forEach((line) => console.error(line));
};

const parseNumeric = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number.parseFloat(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return undefined;
};

const extractUsage = (
  diagnostics?: Record<string, unknown>,
  headers?: Headers | Record<string, string>,
): { total?: number; input?: number; output?: number } | undefined => {
  let headerTotal: number | undefined;
  if (headers) {
    const getHeader = (key: string) => {
      if (headers instanceof Headers) {
        return headers.get(key);
      }
      const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase());
      return entry ? entry[1] : undefined;
    };
    headerTotal =
      parseNumeric(getHeader('x-usage-tokens')) ??
      parseNumeric(getHeader('x-token-usage-total')) ??
      parseNumeric(getHeader('x-total-tokens')) ??
      undefined;
  }

  const usageCandidate = diagnostics && typeof diagnostics === 'object'
    ? (diagnostics.usage ?? diagnostics.token_usage ?? diagnostics.tokens ?? diagnostics.tokenUsage)
    : undefined;

  if (!usageCandidate && headerTotal === undefined) {
    return undefined;
  }

  if (!usageCandidate && headerTotal !== undefined) {
    return { total: headerTotal };
  }

  if (usageCandidate && typeof usageCandidate === 'object') {
    const usageObj = usageCandidate as Record<string, unknown>;
    return {
      total:
        parseNumeric(usageObj.total_tokens ?? usageObj.total ?? usageObj.totalTokens ?? usageObj.tokens) ??
        headerTotal,
      input: parseNumeric(
        usageObj.input_tokens ?? usageObj.prompt_tokens ?? usageObj.prompt ?? usageObj.input,
      ),
      output: parseNumeric(
        usageObj.output_tokens ?? usageObj.completion_tokens ?? usageObj.completions ?? usageObj.output,
      ),
    };
  }

  return { total: headerTotal };
};

const summariseOperations = (responses: AiBatchResponsePayload[]): number | undefined => {
  let total = 0;
  let found = false;
  responses.forEach((response) => {
    if (!response) return;
    const diagnostics = response.diagnostics as Record<string, unknown> | undefined;
    if (diagnostics && typeof diagnostics === 'object') {
      const candidate =
        parseNumeric(diagnostics.operations_proposed) ??
        parseNumeric(diagnostics.operation_count) ??
        parseNumeric(diagnostics.operations) ??
        parseNumeric(diagnostics.ops);
      if (candidate !== undefined) {
        total += candidate;
        found = true;
        return;
      }
      const opsArray = diagnostics.operations ?? diagnostics.ops;
      if (Array.isArray(opsArray)) {
        total += opsArray.length;
        found = true;
        return;
      }
    }
    const state = response.state_out as Record<string, unknown> | undefined;
    if (state && typeof state === 'object') {
      const operations = state.operations ?? state.ops;
      if (Array.isArray(operations)) {
        total += operations.length;
        found = true;
      }
    }
  });
  return found ? total : undefined;
};

export interface BatchStartInfo {
  batchId: string;
  sliceIndex: number;
  entryCount: number;
  approxChars: number;
  estimatedTokens: number;
  model: string;
  mode: AiMode;
  cursorToken?: string;
  sampleEntries: AiSnapshotEntry[];
}

export interface RequestLogContext {
  batchId: string;
  sliceIndex: number;
  model: string;
  mode: AiMode;
  startedAt: number;
  entryCount: number;
  estimatedTokens: number;
  maxTokens: number;
  cursorToken?: string;
  payloadPreview?: unknown;
}

export interface RequestLogOptions extends Omit<RequestLogContext, 'startedAt'> {
  payload: AiBatchRequestPayload;
  cursorToken?: string;
}

export interface ResponseLogOptions extends RequestLogContext {
  status: number;
  durationMs: number;
  response?: AiBatchResponsePayload;
  rawBody?: unknown;
  headers?: Headers | Record<string, string>;
}

export interface MergeLogInfo {
  batchId: string;
  sliceIndex: number;
  model: string;
  mode: AiMode;
  stateOut?: AiState;
  summary?: AiSummary;
  cursorToken?: string;
  stateHash?: string;
  totalStateKeys: number;
}

export interface SummaryLogInfo {
  batchId: string;
  model: string;
  mode: AiMode;
  sliceCount: number;
  entryCount: number;
  durationMs: number;
  responses: AiBatchResponsePayload[];
  error?: Error | null;
}

export interface ErrorLogInfo {
  batchId?: string;
  sliceIndex?: number;
  model?: string;
  mode?: AiMode;
  stage?: 'prepare' | 'request' | 'response' | 'merge' | 'summary' | 'unknown';
  status?: number;
  retryAfterSeconds?: number;
  payloadSnippet?: unknown;
  responseSnippet?: unknown;
  durationMs?: number;
}

export const logBatchStart = (info: BatchStartInfo) => {
  if (!isVerboseEnabled()) return;
  const prefix = modelPrefix(info.model);
  const header = `${prefix} ${blue('Preparing batch')} ${bold(`#${info.sliceIndex + 1}`)} ${dim(`(${info.batchId})`)}`;
  const samples = info.sampleEntries.slice(0, 3).map((entry) => entry.path);
  const details = [
    `Mode: ${info.mode}`,
    `Entries in slice: ${formatNumber(info.entryCount)} (≈${formatNumber(info.approxChars)} chars)`,
    `Estimated tokens: ${formatNumber(info.estimatedTokens)}`,
    `Cursor token: ${info.cursorToken ?? '—'}`,
  ];
  if (samples.length) {
    details.push(`Sample paths: ${samples.join(', ')}`);
  }
  emit(header, details);
};

export const logRequest = (options: RequestLogOptions): RequestLogContext => {
  const context: RequestLogContext = {
    batchId: options.batchId,
    sliceIndex: options.sliceIndex,
    model: options.model,
    mode: options.mode,
    startedAt: Date.now(),
    entryCount: options.entryCount,
    estimatedTokens: options.estimatedTokens,
    maxTokens: options.maxTokens,
    cursorToken: options.cursorToken,
    payloadPreview: buildPayloadPreview(options.payload),
  };
  if (!isVerboseEnabled()) {
    return context;
  }
  const prefix = modelPrefix(options.model);
  const percent = options.maxTokens
    ? Math.min(999, Math.round((options.estimatedTokens / options.maxTokens) * 1000) / 10)
    : 0;
  const payloadPreview = context.payloadPreview as Record<string, unknown>;
  const header = `${prefix} ${green('Dispatching batch')} ${bold(`#${options.sliceIndex + 1}`)} ${dim(`(${options.batchId})`)}`;
  const details = [
    `Model: ${options.model} (${options.mode})`,
    `Tokens: ${formatNumber(options.estimatedTokens)} / ${formatNumber(options.maxTokens)} (${percent}%)`,
    `Entries in slice: ${formatNumber(options.entryCount)}`,
    `Cursor token: ${options.cursorToken ?? '—'}`,
    'Payload (truncated):',
    indentBlock(formatJson(payloadPreview)),
  ];
  emit(header, details);
  return context;
};

export const logResponse = (options: ResponseLogOptions) => {
  if (!isVerboseEnabled()) return;
  const prefix = modelPrefix(options.model);
  const usage = extractUsage(options.response?.diagnostics as Record<string, unknown> | undefined, options.headers);
  const header = `${prefix} ${magenta('Response received')} ${bold(`#${options.sliceIndex + 1}`)} ${dim(`(${options.batchId})`)} ${yellow(`status ${options.status}`)} ${dim(`in ${formatDuration(options.durationMs)}`)}`;
  const details: string[] = [];
  if (usage) {
    const usageParts = [
      usage.total !== undefined ? `total: ${formatNumber(usage.total)}` : null,
      usage.input !== undefined ? `input: ${formatNumber(usage.input)}` : null,
      usage.output !== undefined ? `output: ${formatNumber(usage.output)}` : null,
    ].filter(Boolean);
    if (usageParts.length) {
      details.push(`Tokens used → ${usageParts.join(', ')}`);
    }
  }
  const cursor = options.response?.meta?.cursor?.next;
  details.push(`Next cursor: ${cursor ?? '—'}`);
  if (options.response?.summary?.text) {
    details.push(`Summary preview: ${truncateText(options.response.summary.text)}`);
  }
  if (options.response?.summary?.highlights?.length) {
    details.push(`Highlights: ${formatNumber(options.response.summary.highlights.length)}`);
  }
  const statePreview = buildStatePreview(options.response?.state_out ?? undefined);
  if (statePreview) {
    details.push('state_out (preview):');
    details.push(indentBlock(formatJson(statePreview)));
  }
  const diagnostics = options.response?.diagnostics;
  if (diagnostics && Object.keys(diagnostics).length) {
    details.push('diagnostics (preview):');
    details.push(indentBlock(formatJson(diagnostics)));
  }
  emit(header, details);
};

export const logMerge = (info: MergeLogInfo) => {
  if (!isVerboseEnabled()) return;
  const prefix = modelPrefix(info.model);
  const header = `${prefix} ${cyan('Merged state_out')} ${bold(`#${info.sliceIndex + 1}`)} ${dim(`(${info.batchId})`)}`;
  const details: string[] = [`Total state keys: ${formatNumber(info.totalStateKeys)}`];
  if (info.cursorToken) {
    details.push(`Cursor advanced to: ${info.cursorToken}`);
  }
  if (info.stateHash) {
    details.push(`State hash: ${info.stateHash}`);
  }
  if (info.summary?.text) {
    details.push(`Summary appended (${info.summary?.sections?.length ?? 0} sections)`);
  }
  const statePreview = buildStatePreview(info.stateOut);
  if (statePreview) {
    details.push('Merged keys preview:');
    details.push(indentBlock(formatJson(statePreview)));
  }
  emit(header, details);
};

export const logSummary = (info: SummaryLogInfo) => {
  if (!isVerboseEnabled()) return;
  const prefix = modelPrefix(info.model);
  const ok = !info.error;
  const header = `${prefix} ${ok ? green('Completed batches') : yellow('Batches finished with warnings')} ${bold(info.sliceCount.toString())} ${dim(`(${info.batchId})`)}`;
  const ops = summariseOperations(info.responses);
  const details = [
    `Mode: ${info.mode}`,
    `Slices processed: ${formatNumber(info.sliceCount)}`,
    `Total files processed: ${formatNumber(info.entryCount)}`,
    `Duration: ${formatDuration(info.durationMs)}`,
  ];
  if (ops !== undefined) {
    details.push(`Total ops proposed: ${formatNumber(ops)}`);
  }
  if (info.error) {
    details.push(`Error: ${info.error.message}`);
  }
  emit(header, details);
};

export const logError = (error: unknown, info: ErrorLogInfo = {}) => {
  if (!shouldLogErrors()) return;
  const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : 'Unknown AI error');
  const prefix = info.model ? modelPrefix(info.model) : red('☠️ [AI]');
  const header = `${prefix} ${red('AI flow error')} ${info.batchId ? dim(`(${info.batchId})`) : ''}`.trim();
  const details: string[] = [];
  if (info.sliceIndex !== undefined) {
    details.push(`Slice: #${info.sliceIndex + 1}`);
  }
  if (info.stage) {
    details.push(`Stage: ${info.stage}`);
  }
  if (info.status) {
    details.push(`HTTP status: ${info.status}`);
  }
  if (info.durationMs !== undefined) {
    details.push(`Duration: ${formatDuration(info.durationMs)}`);
  }
  if (info.retryAfterSeconds !== undefined) {
    details.push(`Retry after: ${formatNumber(info.retryAfterSeconds)} s`);
  }
  if (info.payloadSnippet) {
    details.push('Payload snippet:');
    details.push(indentBlock(formatJson(info.payloadSnippet)));
  }
  if (info.responseSnippet !== undefined) {
    details.push('Response snippet:');
    details.push(indentBlock(formatJson(info.responseSnippet)));
  }
  if (err.stack) {
    details.push(err.stack);
  } else {
    details.push(err.message);
  }
  emitError(header, details);
  try {
    (err as Error & { __aiLoggerLogged?: boolean }).__aiLoggerLogged = true;
  } catch {
    // ignore assignment failures
  }
};

export const aiLogger = {
  logBatchStart,
  logRequest,
  logResponse,
  logMerge,
  logSummary,
  logError,
};

