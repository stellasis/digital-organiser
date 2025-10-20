describe('modelConfig', () => {
  const originalEnv: NodeJS.ProcessEnv = { ...process.env };
  let resolveModelConfig!: typeof import('../main/ai/modelConfig').resolveModelConfig;

  const loadModule = async () => {
    jest.resetModules();
    ({ resolveModelConfig } = await import('../main/ai/modelConfig'));
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('provides Gemini adapters in production mode', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    await loadModule();

    const config = resolveModelConfig('production');
    expect(typeof config.requestAdapter).toBe('function');
    expect(typeof config.responseAdapter).toBe('function');
    expect(config.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'test-key',
    });

    const payload = { meta: { batch_id: 'test' } };
    const adapted = config.requestAdapter?.(payload) as Record<string, unknown>;
    expect(adapted).toMatchObject({
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    });
    const systemInstruction = (adapted.systemInstruction as { parts: Array<{ text: string }> }).parts[0]?.text;
    expect(systemInstruction).toContain('Digital Organiser');
    const userText = (adapted.contents as Array<{ parts: Array<{ text: string }> }>)[0]?.parts[0]?.text;
    expect(userText).toContain('<request>');
    expect(userText).toContain('batch_id');
  });

  it('parses Gemini responses into organiser payloads', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    await loadModule();

    const config = resolveModelConfig('refinement');
    const jsonBody = JSON.stringify({ summary: { text: 'Hello' } });
    const response = config.responseAdapter?.({
      candidates: [
        {
          content: {
            parts: [
              {
                text: jsonBody,
              },
            ],
          },
        },
      ],
    });

    expect(response).toEqual({ summary: { text: 'Hello' } });
  });

  it('falls back to content-type header when API key is missing', async () => {
    delete process.env.GEMINI_API_KEY;
    await loadModule();

    const config = resolveModelConfig('production');
    expect(config.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('normalises Gemini endpoints when base URL includes a trailing slash', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.GEMINI_BASE_URL = 'https://example.com/v1beta/';
    process.env.GEMINI_PRO_MODEL = 'custom-model';
    await loadModule();

    const config = resolveModelConfig('production');
    expect(config.endpoint).toBe('https://example.com/v1beta/models/custom-model:generateContent');
  });
});

