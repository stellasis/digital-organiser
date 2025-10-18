import type { Snapshot } from '../types/snapshot';

export const sandboxSampleSnapshot: Snapshot = {
  rootPath: 'C:/Users/Sample/Projects',
  tree: {
    id: 'root',
    name: 'Projects',
    kind: 'folder',
    children: [
      {
        id: 'docs',
        name: 'docs',
        kind: 'folder',
        children: [
          { id: 'intro', name: 'introduction.md', kind: 'file' },
          { id: 'roadmap', name: 'roadmap.md', kind: 'file' },
        ],
      },
      {
        id: 'src',
        name: 'src',
        kind: 'folder',
        children: [
          { id: 'index', name: 'index.ts', kind: 'file' },
          { id: 'app', name: 'App.tsx', kind: 'file' },
        ],
      },
      {
        id: 'tests',
        name: 'tests',
        kind: 'folder',
        children: [
          { id: 'app-test', name: 'App.test.tsx', kind: 'file' },
        ],
      },
      { id: 'package', name: 'package.json', kind: 'file' },
    ],
  },
};
