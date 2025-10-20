import log from 'electron-log';
import type { AiMode } from '../../types/ai';

export interface AiModelConfig {
  mode: AiMode;
  model: string;
  endpoint: string;
  maxInputTokens: number;
  headers?: Record<string, string>;
  requestAdapter?: (payload: unknown) => unknown;
  responseAdapter?: (payload: unknown) => unknown;
}

const logger = log.scope?.('ai-model-config') ?? log;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';

const normaliseBaseUrl = (url: string) => url.replace(/\/$/, '');

const buildGeminiEndpoint = (model: string) =>
  `${normaliseBaseUrl(GEMINI_BASE_URL)}/models/${model}:generateContent`;

const buildGeminiHeaders = () => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (GEMINI_API_KEY) {
    headers['x-goog-api-key'] = GEMINI_API_KEY;
  }
  return headers;
};

const ORGANISER_SYSTEM_PROMPT = `You are an assistant embedded in the Digital Organiser app.
You receive a JSON request that describes a slice of a filesystem snapshot and
any running assistant state.

Return a JSON object that matches this TypeScript type:
{
  "meta"?: {
    "cursor"?: { "next"?: string };
    "state_hash_out"?: string;
  };
  "state_out"?: Record<string, unknown>;
  "summary"?: {
    "text"?: string;
    "highlights"?: string[];
    "sections"?: { "title"?: string; "body": string }[];
  };
  "diagnostics"?: Record<string, unknown>;
}

Only include properties that have useful values. Preserve and extend any
information found inside "state_in". Use the provided snapshot to suggest
highlights, summaries and sections that help the user organise their files.`;

const formatBatchPayload = (payload: unknown) => JSON.stringify(payload, null, 2);

const wrapRequestPayload = (payload: unknown) =>
  `<request>${formatBatchPayload(payload)}</request>`;

const adaptOllamaRequest = (payload: unknown, model: string) => ({
  model,
  prompt: `${ORGANISER_SYSTEM_PROMPT}\n\n${wrapRequestPayload(payload)}`,
  stream: false,
  format: 'json',
  options: {
    temperature: 0,
  },
});

const adaptOllamaResponse = (payload: unknown): unknown => {
  if (payload && typeof payload === 'object' && 'response' in (payload as Record<string, unknown>)) {
    const { response } = payload as { response?: unknown };
    if (typeof response === 'string') {
      try {
        return JSON.parse(response);
      } catch (error) {
        logger.warn('Failed to parse Ollama response as JSON; returning text summary instead.', error);
        return { summary: { text: response } };
      }
    }
  }
  return payload;
};

const adaptGeminiRequest = (payload: unknown) => ({
  systemInstruction: {
    role: 'system',
    parts: [{ text: ORGANISER_SYSTEM_PROMPT }],
  },
  contents: [
    {
      role: 'user',
      parts: [
        {
          text: `The following JSON describes the organiser batch request. Respond with a JSON object that matches the documented schema.\n\n${wrapRequestPayload(
            payload,
          )}`,
        },
      ],
    },
  ],
  generationConfig: {
    temperature: 0,
    responseMimeType: 'application/json',
  },
});

const adaptGeminiResponse = (payload: unknown): unknown => {
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch (error) {
      logger.warn('Failed to parse Gemini string response as JSON; returning original text.', error);
      return { summary: { text: payload } };
    }
  }

  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const record = payload as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string | null } | null> | null };
    }>;
  };

  const parts = record.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? [];
  const textPart = parts.find((part) => typeof part?.text === 'string')?.text ?? null;

  if (typeof textPart === 'string') {
    try {
      return JSON.parse(textPart);
    } catch (error) {
      logger.warn('Failed to parse Gemini response part as JSON; returning text summary instead.', error);
      return { summary: { text: textPart } };
    }
  }

  return payload;
};

const DEFAULT_CONFIGS: Record<AiMode, AiModelConfig> = {
  production: {
    mode: 'production',
    model: process.env.GEMINI_PRO_MODEL ?? 'gemini-2.5-pro-exp-0801',
    endpoint: buildGeminiEndpoint(process.env.GEMINI_PRO_MODEL ?? 'gemini-2.5-pro-exp-0801'),
    maxInputTokens: Number(process.env.GEMINI_PRO_MAX_INPUT_TOKENS ?? 128000),
    headers: buildGeminiHeaders(),
  },
  refinement: {
    mode: 'refinement',
    model: process.env.GEMINI_FLASH_MODEL ?? 'gemini-2.0-flash',
    endpoint: buildGeminiEndpoint(process.env.GEMINI_FLASH_MODEL ?? 'gemini-2.0-flash'),
    maxInputTokens: Number(process.env.GEMINI_FLASH_MAX_INPUT_TOKENS ?? 65536),
    headers: buildGeminiHeaders(),
  },
  local: {
    mode: 'local',
    model: process.env.OLLAMA_MODEL ?? 'llama3.1:8b',
    endpoint: `${OLLAMA_BASE_URL.replace(/\/$/, '')}/api/generate`,
    maxInputTokens: Number(process.env.OLLAMA_MAX_INPUT_TOKENS ?? 4096),
  },
};

export const resolveModelConfig = (
  mode: AiMode = (process.env.AI_MODEL_MODE as AiMode) ?? 'local',
  overrides?: Partial<AiModelConfig>,
): AiModelConfig => {
  const base = DEFAULT_CONFIGS[mode] ?? DEFAULT_CONFIGS.local;
  if (!GEMINI_API_KEY && (mode === 'production' || mode === 'refinement')) {
    logger.warn('GEMINI_API_KEY is not set; Gemini requests will likely fail.');
  }
  const merged: AiModelConfig = { ...base, ...overrides };
  if (base.headers || overrides?.headers) {
    merged.headers = { ...(base.headers ?? {}), ...(overrides?.headers ?? {}) };
  }
  if (merged.mode === 'local') {
    merged.requestAdapter = overrides?.requestAdapter ?? ((payload) => adaptOllamaRequest(payload, merged.model));
    merged.responseAdapter = overrides?.responseAdapter ?? adaptOllamaResponse;
  } else if (merged.mode === 'production' || merged.mode === 'refinement') {
    merged.requestAdapter = overrides?.requestAdapter ?? adaptGeminiRequest;
    merged.responseAdapter = overrides?.responseAdapter ?? adaptGeminiResponse;
  }
  return merged;
};

