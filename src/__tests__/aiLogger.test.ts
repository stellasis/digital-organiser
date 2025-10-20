import type { AiBatchRequestPayload } from '../types/ai';

const withVerboseEnv = async () => {
  process.env.AI_LOG_VERBOSE = 'true';
  process.env.NODE_ENV = 'test';
  const module = await import('../utils/aiLogger');
  return module;
};

describe('aiLogger', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('pretty prints payload slices with truncation markers', async () => {
    const { logRequest } = await withVerboseEnv();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const payload: AiBatchRequestPayload = {
      meta: { batch_id: 'b1', mode: 'local', model: 'ollama_llama', cursor: { index: 0 } },
      snapshot: {
        slice: Array.from({ length: 15 }).map((_, index) => ({
          path: `docs/file-${index}.md`,
          name: `file-${index}.md`,
          kind: 'file',
          depth: 1,
        })),
      },
      prefs: { free_text: 'sample' },
      state_in: {},
    };

    logRequest({
      batchId: 'b1',
      sliceIndex: 0,
      model: 'ollama_llama3',
      mode: 'local',
      entryCount: payload.snapshot.slice.length,
      estimatedTokens: 2048,
      maxTokens: 4096,
      payload,
    });

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('… truncated');
    expect(output).toContain('Payload (truncated)');
  });

  it('treats numeric verbose env toggles as enabled', async () => {
    process.env.AI_LOG_VERBOSE = '1';
    process.env.NODE_ENV = 'test';
    const { logBatchStart } = await import('../utils/aiLogger');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    logBatchStart({
      batchId: 'b4',
      sliceIndex: 0,
      entryCount: 1,
      approxChars: 42,
      estimatedTokens: 10,
      model: 'gemini',
      mode: 'production',
      cursorToken: undefined,
      sampleEntries: [
        { path: 'foo', name: 'foo', kind: 'file', depth: 0 },
      ],
    });

    expect(logSpy).toHaveBeenCalled();
  });

  it('suppresses verbose logs when AI_LOG_VERBOSE is not enabled but still prints errors', async () => {
    delete process.env.AI_LOG_VERBOSE;
    const { logBatchStart, logError } = await import('../utils/aiLogger');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    logBatchStart({
      batchId: 'b2',
      sliceIndex: 1,
      entryCount: 3,
      approxChars: 1200,
      estimatedTokens: 300,
      model: 'gemini-2.0',
      mode: 'production',
      cursorToken: undefined,
      sampleEntries: [],
    });

    expect(logSpy).not.toHaveBeenCalled();

    const error = new Error('network failed');
    error.stack = 'Error: network failed\n    at sendBatch (aiBatcher.ts:10)';
    logError(error, { batchId: 'b2', model: 'gemini-2.0', stage: 'request' });
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('network failed');
  });

  it('captures error stack traces in output', async () => {
    delete process.env.AI_LOG_VERBOSE;
    const { logError } = await import('../utils/aiLogger');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('merge failed');
    err.stack = 'Error: merge failed\n    at mergeState (aiBatcher.ts:42)';

    logError(err, { batchId: 'b3', model: 'ollama', stage: 'merge' });

    const output = errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Error: merge failed');
    expect(output).toContain('mergeState');
  });
});
