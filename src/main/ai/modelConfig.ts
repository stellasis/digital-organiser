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

const adaptOllamaRequest = (payload: unknown, model: string) => ({
  model,
  prompt: JSON.stringify(payload),
  stream: false,
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

const DEFAULT_CONFIGS: Record<AiMode, AiModelConfig> = {
  production: {
    mode: 'production',
    model: process.env.GEMINI_PRO_MODEL ?? 'gemini-2.5-pro-exp-0801',
    endpoint: `${GEMINI_BASE_URL}/models/${process.env.GEMINI_PRO_MODEL ?? 'gemini-2.5-pro-exp-0801'}:generateContent`,
    maxInputTokens: Number(process.env.GEMINI_PRO_MAX_INPUT_TOKENS ?? 128000),
    headers: GEMINI_API_KEY ? { Authorization: `Bearer ${GEMINI_API_KEY}` } : undefined,
  },
  refinement: {
    mode: 'refinement',
    model: process.env.GEMINI_FLASH_MODEL ?? 'gemini-2.0-flash',
    endpoint: `${GEMINI_BASE_URL}/models/${process.env.GEMINI_FLASH_MODEL ?? 'gemini-2.0-flash'}:generateContent`,
    maxInputTokens: Number(process.env.GEMINI_FLASH_MAX_INPUT_TOKENS ?? 65536),
    headers: GEMINI_API_KEY ? { Authorization: `Bearer ${GEMINI_API_KEY}` } : undefined,
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
  if (merged.mode === 'local') {
    merged.requestAdapter = overrides?.requestAdapter ?? ((payload) => adaptOllamaRequest(payload, merged.model));
    merged.responseAdapter = overrides?.responseAdapter ?? adaptOllamaResponse;
  }
  return merged;
};

