import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { scanDirectory } from '../src/main/scanner';

describe('smart directory traversal', () => {
  const makeTempDir = async () =>
    fs.mkdtemp(path.join(os.tmpdir(), 'smart-scanner-'));

  const cleanupTempDir = async (dirPath: string | null) => {
    if (dirPath) {
      await fs.rm(dirPath, { recursive: true, force: true });
    }
  };

  it('treats language-specific environments as atomic nodes', async () => {
    let workspace: string | null = null;
    try {
      workspace = await makeTempDir();

      const nodeProject = path.join(workspace, 'nodeProject');
      await fs.mkdir(path.join(nodeProject, 'node_modules'), { recursive: true });
      await fs.mkdir(path.join(nodeProject, 'src'), { recursive: true });
      await fs.writeFile(path.join(nodeProject, 'package.json'), '{"name": "sample"}');
      await fs.writeFile(
        path.join(nodeProject, 'src', 'index.js'),
        'console.log("hello");',
      );

      const embeddedVenv = path.join(nodeProject, 'tools', 'venv');
      await fs.mkdir(path.join(embeddedVenv, 'bin'), { recursive: true });
      await fs.mkdir(path.join(embeddedVenv, 'lib', 'python3.11', 'site-packages'), {
        recursive: true,
      });
      await fs.writeFile(path.join(embeddedVenv, 'pyvenv.cfg'), 'home = python');
      await fs.writeFile(path.join(embeddedVenv, 'bin', 'activate'), '#!/bin/bash');

      const pythonEnv = path.join(workspace, 'pythonEnv');
      await fs.mkdir(path.join(pythonEnv, 'bin'), { recursive: true });
      await fs.mkdir(path.join(pythonEnv, 'lib', 'python3.11', 'site-packages'), {
        recursive: true,
      });
      await fs.writeFile(path.join(pythonEnv, 'pyvenv.cfg'), 'home = python');
      await fs.writeFile(path.join(pythonEnv, 'bin', 'activate'), '#!/bin/bash');
      await fs.writeFile(
        path.join(pythonEnv, 'lib', 'python3.11', 'site-packages', 'pkg.py'),
        'pass',
      );

      await fs.writeFile(path.join(workspace, 'readme.md'), '# Notes');

      const snapshot = await scanDirectory(workspace);

      const nodeEntry = snapshot.files.find(
        (file) => file.relativePath === 'nodeProject',
      );
      expect(nodeEntry).toBeDefined();
      expect(nodeEntry).toMatchObject({
        type: 'dir',
        flags: ['node_project'],
      });

      const pythonEntry = snapshot.files.find(
        (file) => file.relativePath === 'pythonEnv',
      );
      expect(pythonEntry).toBeDefined();
      expect(pythonEntry).toMatchObject({
        type: 'dir',
        flags: ['python_venv'],
      });

      const nodeNested = snapshot.files.filter((file) =>
        file.relativePath.startsWith('nodeProject/'),
      );
      expect(nodeNested).toHaveLength(0);

      const pythonNested = snapshot.files.filter((file) =>
        file.relativePath.startsWith('pythonEnv/'),
      );
      expect(pythonNested).toHaveLength(0);

      expect(
        snapshot.files.some((file) => file.relativePath === 'readme.md'),
      ).toBe(true);
    } finally {
      await cleanupTempDir(workspace);
    }
  });

  it('identifies nested environments while keeping sibling content', async () => {
    let workspace: string | null = null;
    try {
      workspace = await makeTempDir();

      const projectRoot = path.join(workspace, 'project');
      await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(projectRoot, 'src', 'main.py'),
        'print("hello")',
      );

      const venvRoot = path.join(projectRoot, 'venv');
      await fs.mkdir(path.join(venvRoot, 'bin'), { recursive: true });
      await fs.mkdir(path.join(venvRoot, 'lib', 'python3.10', 'site-packages'), {
        recursive: true,
      });
      await fs.writeFile(path.join(venvRoot, 'pyvenv.cfg'), 'home = python');
      await fs.writeFile(path.join(venvRoot, 'bin', 'activate'), '#!/bin/bash');

      const snapshot = await scanDirectory(workspace);

      const venvEntry = snapshot.files.find(
        (file) => file.relativePath === 'project/venv',
      );
      expect(venvEntry).toBeDefined();
      expect(venvEntry).toMatchObject({
        type: 'dir',
        flags: ['python_venv'],
      });

      expect(
        snapshot.files.some((file) => file.relativePath === 'project/src/main.py'),
      ).toBe(true);
    } finally {
      await cleanupTempDir(workspace);
    }
  });

  it('treats chrome extensions as atomic directories', async () => {
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
      await fs.writeFile(path.join(extensionRoot, 'background.js'), "console.log('bg');");

      const snapshot = await scanDirectory(workspace);

      const extensionEntry = snapshot.files.find(
        (file) => file.relativePath === 'chrome-ext-gmat-verbal-buddy',
      );

      expect(extensionEntry).toBeDefined();
      expect(extensionEntry).toMatchObject({
        type: 'dir',
        flags: ['chrome_extension'],
      });

      const nestedEntries = snapshot.files.filter((file) =>
        file.relativePath.startsWith('chrome-ext-gmat-verbal-buddy/'),
      );
      expect(nestedEntries).toHaveLength(0);
    } finally {
      await cleanupTempDir(workspace);
    }
  });
});
