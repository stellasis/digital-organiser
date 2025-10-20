import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { scanDirectory } from '../main/scanner';

describe('scanDirectory', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scanner-test-'));
    await fs.mkdir(path.join(tempDir, 'nested'));
    await fs.writeFile(path.join(tempDir, 'sample.txt'), 'Hello world');
    await fs.writeFile(
      path.join(tempDir, 'nested', 'data.json'),
      '{"foo": "bar"}',
    );
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns metadata for files in nested directories', async () => {
    const snapshot = await scanDirectory(tempDir);

    expect(snapshot.rootPath).toBe(path.resolve(tempDir));
    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.files.every((file) => file.type === 'file')).toBe(true);

    const relativePaths = snapshot.files
      .map((file) => file.relativePath)
      .sort();
    expect(relativePaths).toEqual(['nested/data.json', 'sample.txt']);

    const txtFile = snapshot.files.find(
      (file) => file.relativePath === 'sample.txt',
    );
    expect(txtFile).toBeDefined();
    expect(txtFile?.mimeType).toBe('text/plain');
    expect(txtFile?.size).toBeGreaterThan(0);
    expect(txtFile?.flags).toEqual([]);
  });
});
