import path from 'path';

const EXACT_NAMES = [
  '.git',
  '.github',
  '.gitlab',
  '.svn',
  '.hg',
  '.idea',
  '.vscode',
  '.fleet',
  '.vs',
  'node_modules',
  'bower_components',
  'vendor',
  'Pods',
  'Carthage',
  'DerivedData',
  'build',
  'dist',
  'target',
  'out',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.parcel-cache',
  '.cache',
  '.vite',
  '.vercel',
  '.netlify',
  '.serverless',
  '.gradle',
  '.m2',
  '.terraform',
  '.tox',
  '.docusaurus',
  '.yarn',
  '.pnpm-store',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.ipynb_checkpoints',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'logs',
  'log',
  'coverage',
  '.coverage',
  '.nyc_output',
  'tmp',
  'temp',
  '$RECYCLE.BIN',
  'System Volume Information',
  'lost+found',
  '.Trash',
  '.TemporaryItems',
  '.MobileBackups',
  '.iCloud',
  '.iCloudDrive',
  '.OneDrive',
  'OneDrive',
  '.OneDriveTemp',
  '.sync',
  '.Dropbox',
  '.dropbox',
  '.dropbox.cache',
  '.dropbox.attr',
  '.dropbox-triggers',
  'My Drive',
  '.shortcut-targets-by-id',
  '.tmp.drivedownload',
  '.tmp.driveupload',
  '.gdrive',
  '.GoogleDriveFS',
  '.Box',
  '.MegaSync',
  '.pCloudDrive',
  '.Syncthing',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'Gemfile.lock',
];

const PREFIX_PATTERNS = ['~$', '.icloud~', '.sync-conflict-'];
const SUFFIX_PATTERNS = ['.tmp', '.bak', '.swp', '.swo'];

const LOWER_EXACT_NAMES = new Set(EXACT_NAMES.map((name) => name.toLowerCase()));

const matchesPrefixPattern = (value: string) => {
  const lowerValue = value.toLowerCase();
  return PREFIX_PATTERNS.some((pattern) => lowerValue.startsWith(pattern));
};

const matchesSuffixPattern = (value: string) => {
  const lowerValue = value.toLowerCase();
  return SUFFIX_PATTERNS.some((pattern) => lowerValue.endsWith(pattern));
};

const endsWithLock = (value: string) => value.toLowerCase().endsWith('.lock');

export const normaliseRelativePath = (rootPath: string, entryPath: string) => {
  const relative = path.relative(rootPath, entryPath);
  return relative.split(path.sep).filter(Boolean).join('/') || '';
};

export const shouldIgnorePath = (relativePath: string, isDirectory: boolean): boolean => {
  if (!relativePath) {
    return false;
  }

  const segments = relativePath.split('/');
  return segments.some((segment, index) => {
    const isLast = index === segments.length - 1;
    const lower = segment.toLowerCase();
    if (LOWER_EXACT_NAMES.has(lower) || matchesPrefixPattern(segment)) {
      return true;
    }
    if (!isDirectory || isLast) {
      if (endsWithLock(segment)) {
        return true;
      }
      if (matchesSuffixPattern(segment)) {
        return true;
      }
    }
    return false;
  });
};

