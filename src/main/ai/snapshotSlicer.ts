import type { AiSnapshotEntry, AiSnapshotSlice } from '../../types/ai';
import { CHARS_PER_TOKEN } from './tokenBudget';

export interface SliceOptions {
  maxTokens: number;
}

export async function* sliceSnapshotEntries(
  entryStream: AsyncIterable<AiSnapshotEntry>,
  { maxTokens }: SliceOptions,
): AsyncGenerator<AiSnapshotSlice> {
  const maxChars = Math.max(maxTokens * CHARS_PER_TOKEN, 32);
  let buffer: AiSnapshotEntry[] = [];
  let approxChars = 2;
  let index = 0;

  const flush = async () => {
    if (buffer.length === 0) return null;
    const slice: AiSnapshotSlice = { entries: buffer, index, approxChars };
    buffer = [];
    approxChars = 2;
    index += 1;
    return slice;
  };

  for await (const entry of entryStream) {
    const entryChars = JSON.stringify(entry).length + (buffer.length > 0 ? 1 : 0);
    if (entryChars > maxChars) {
      if (buffer.length > 0) {
        const slice = await flush();
        if (slice) {
          yield slice;
        }
      }
      yield { entries: [entry], index, approxChars: entryChars };
      index += 1;
      continue;
    }

    if (approxChars + entryChars > maxChars && buffer.length > 0) {
      const slice = await flush();
      if (slice) {
        yield slice;
      }
    }

    buffer.push(entry);
    approxChars += entryChars;
  }

  const slice = await flush();
  if (slice) {
    yield slice;
  }
}

