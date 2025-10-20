export const CHARS_PER_TOKEN = 4;

export const estimateTokensFromChars = (chars: number): number => {
  if (chars <= 0) return 0;
  return Math.ceil(chars / CHARS_PER_TOKEN);
};

export const estimateTokensForJson = (payload: unknown): number => {
  const json = JSON.stringify(payload);
  return estimateTokensFromChars(json.length);
};

export const truncateTextForTokenBudget = (text: string, maxTokens: number): string => {
  if (maxTokens <= 0) return '';
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
};

