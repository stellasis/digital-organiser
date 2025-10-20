import { runAiBatchOrganisation } from '../main/ai/aiBatcher';
import { shouldIgnorePath } from '../main/ai/ignoreRules';
import { sliceSnapshotEntries } from '../main/ai/snapshotSlicer';
import type { AiSnapshotEntry } from '../types/ai';

describe('ignore rules', () => {
  it('ignores configured folders and files', () => {
    expect(shouldIgnorePath('node_modules', true)).toBe(true);
    expect(shouldIgnorePath('src/node_modules', true)).toBe(true);
    expect(shouldIgnorePath('src/package-lock.json', false)).toBe(true);
    expect(shouldIgnorePath('src/data/file.lock', false)).toBe(true);
    expect(shouldIgnorePath('src/data/index.ts', false)).toBe(false);
  });

  it('ignores extended cloud-sync and temp patterns', () => {
    expect(shouldIgnorePath('My Drive/photos', true)).toBe(true);
    expect(shouldIgnorePath('documents/.sync-conflict-12345', true)).toBe(true);
    expect(shouldIgnorePath('drafts/~$proposal.docx', false)).toBe(true);
    expect(shouldIgnorePath('drafts/report.tmp', false)).toBe(true);
    expect(shouldIgnorePath('notes/meeting.txt', false)).toBe(false);
  });
});

describe('sliceSnapshotEntries', () => {
  const createEntries = (count: number): AsyncIterable<AiSnapshotEntry> => ({
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index < count; index += 1) {
        yield {
          path: index === 0 ? '' : `folder-${index - 1}`,
          name: `entry-${index}`,
          kind: index === 0 ? 'folder' : 'file',
          depth: index,
          children: index === 0 ? ['child'] : undefined,
        };
      }
    },
  });

  it('chunks entries according to token budget', async () => {
    const slices = [];
    for await (const slice of sliceSnapshotEntries(createEntries(5), { maxTokens: 30 })) {
      slices.push(slice);
    }

    expect(slices.length).toBeGreaterThan(1);
    expect(slices[0].entries.length).toBeGreaterThan(0);
    expect(slices.map((slice) => slice.entries.length).reduce((sum, count) => sum + count, 0)).toBe(5);
  });
});

describe('runAiBatchOrganisation', () => {
  const buildEntryStream = (): AsyncIterable<AiSnapshotEntry> => ({
    async *[Symbol.asyncIterator]() {
      yield {
        path: '',
        name: 'root',
        kind: 'folder',
        depth: 0,
        children: ['a', 'b'],
      };
      yield {
        path: 'a',
        name: 'a',
        kind: 'folder',
        depth: 1,
        children: ['a.txt'],
      };
      yield {
        path: 'a/a.txt',
        name: 'a.txt',
        kind: 'file',
        depth: 2,
      };
    },
  });

  it('sequentially dispatches batches and merges state', async () => {
    const payloads: unknown[] = [];
    const responses = [
      {
        state_out: { tree: { nodes: 1 } },
        summary: { text: 'First batch' },
        meta: { cursor: { next: 'cursor-1' }, state_hash_out: 'hash-1' },
      },
      {
        state_out: { tree: { nodes: 2 } },
        summary: { text: 'Second batch', highlights: ['Finished'] },
        meta: { cursor: { next: 'cursor-2' }, state_hash_out: 'hash-2' },
      },
      {
        state_out: { tree: { nodes: 3 } },
        summary: { text: 'Third batch', sections: [{ title: 'Next steps', body: 'Apply diff' }] },
        meta: { state_hash_out: 'hash-3' },
      },
    ];

    const fetchImpl: typeof fetch = async (_url, init) => {
      payloads.push(init?.body ? JSON.parse(init.body as string) : null);
      const response = responses.shift();
      if (!response) {
        throw new Error('Unexpected request');
      }
      return {
        ok: true,
        status: 200,
        json: async () => response,
        text: async () => JSON.stringify(response),
      } as Response;
    };

    const result = await runAiBatchOrganisation({
      rootPath: '/tmp/mock',
      mode: 'local',
      freeText: 'Instructions that are way too long for the prefs budget.',
      fetchImpl,
      modelConfigOverride: {
        model: 'test-model',
        endpoint: 'http://localhost/test',
        maxInputTokens: 40,
        requestAdapter: (payload) => payload,
        responseAdapter: (payload) => payload,
      },
      entryStreamFactory: buildEntryStream,
    });

    expect(payloads).toHaveLength(3);
    const firstPayload = payloads[0] as { prefs: { free_text: string } };
    const secondPayload = payloads[1] as { meta: { cursor: { token?: string }; state_hash_in?: string } };
    const thirdPayload = payloads[2] as { meta: { cursor: { token?: string }; state_hash_in?: string } };
    expect(firstPayload.prefs.free_text.length).toBeLessThanOrEqual(16);
    expect(secondPayload.meta.cursor.token).toBe('cursor-1');
    expect(secondPayload.meta.state_hash_in).toBe('hash-1');
    expect(thirdPayload.meta.cursor.token).toBe('cursor-2');
    expect(thirdPayload.meta.state_hash_in).toBe('hash-2');

    expect(result.state.tree).toEqual({ nodes: 3 });
    expect(result.summary?.text).toContain('Third batch');
    expect(result.summary?.highlights).toEqual(['Finished']);
    expect(result.summary?.sections).toEqual([{ title: 'Next steps', body: 'Apply diff' }]);
    expect(result.slices).toBe(3);
    expect(result.entries).toBe(3);
  });
});

