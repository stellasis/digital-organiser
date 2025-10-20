import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AiSnapshotEntry } from '../src/types/ai';
import { streamSnapshotEntries } from '../src/main/ai/snapshotStream';

const collectEntries = async (rootPath: string): Promise<AiSnapshotEntry[]> => {
  const entries: AiSnapshotEntry[] = [];
  for await (const entry of streamSnapshotEntries({ rootPath })) {
    entries.push(entry);
  }
  return entries;
};

describe('snapshot stream smart stop integration', () => {
  const makeTempDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-stream-'));

  const cleanup = async (dirPath: string | null) => {
    if (dirPath) {
      await fs.rm(dirPath, { recursive: true, force: true });
    }
  };

  it('emits atomic entries for detected environments', async () => {
    let workspace: string | null = null;
    try {
      workspace = await makeTempDir();
      const pythonEnv = path.join(workspace, 'python-env');
      await fs.mkdir(path.join(pythonEnv, 'bin'), { recursive: true });
      await fs.mkdir(path.join(pythonEnv, 'lib', 'python3.11', 'site-packages'), {
        recursive: true,
      });
      await fs.writeFile(path.join(pythonEnv, 'pyvenv.cfg'), 'home = python');
      await fs.writeFile(path.join(pythonEnv, 'bin', 'activate'), '#!/bin/bash');
      await fs.writeFile(path.join(workspace, 'notes.txt'), 'memo');

      const entries = await collectEntries(workspace);
      const envEntry = entries.find((entry) => entry.path === 'python-env');
      expect(envEntry).toBeDefined();
      expect(envEntry?.flags).toEqual(['python_venv']);
      expect(envEntry?.note).toMatch(/Python virtual environment/i);

      const nestedEnvEntries = entries.filter((entry) =>
        entry.path.startsWith('python-env/') ||
        entry.path === 'python-env/bin' ||
        entry.path.startsWith('python-env/bin/'),
      );
      expect(nestedEnvEntries).toHaveLength(0);

      const fileEntry = entries.find((entry) => entry.path === 'notes.txt');
      expect(fileEntry).toBeDefined();
      expect(fileEntry?.kind).toBe('file');
    } finally {
      await cleanup(workspace);
    }
  });

  it('flags chrome extension directories as atomic entries', async () => {
    let workspace: string | null = null;
    try {
      workspace = await makeTempDir();
      const extensionRoot = path.join(workspace, 'chrome-ext-gmat-verbal-buddy');
      await fs.mkdir(extensionRoot, { recursive: true });

      await fs.writeFile(
        path.join(extensionRoot, 'manifest.json'),
        JSON.stringify(
          {
            manifest_version: 3,
            name: 'GMAT Verbal Buddy',
            version: '1.0.0',
            action: {
              default_popup: 'popup.html',
            },
            permissions: ['storage'],
          },
          null,
          2,
        ),
      );
      await fs.writeFile(path.join(extensionRoot, 'content.js'), "console.log('content');");

      const entries = await collectEntries(workspace);
      const extensionEntry = entries.find(
        (entry) => entry.path === 'chrome-ext-gmat-verbal-buddy',
      );

      expect(extensionEntry).toBeDefined();
      expect(extensionEntry?.flags).toEqual(['chrome_extension']);
      expect(extensionEntry?.note).toMatch(/Chrome extension/i);

      const nestedExtensionEntries = entries.filter((entry) =>
        entry.path.startsWith('chrome-ext-gmat-verbal-buddy/'),
      );
      expect(nestedExtensionEntries).toHaveLength(0);
    } finally {
      await cleanup(workspace);
    }
  });
});
