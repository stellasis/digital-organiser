import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';

export interface SmartStopRule {
  id: string;
  flag: string;
  note: string;
  indicatorSets: string[][];
  verify?: (args: {
    dirPath: string;
    entries: Dirent[];
    context?: SmartStopContext;
  }) => Promise<boolean> | boolean;
}

export interface SmartStopMatch {
  rule: SmartStopRule;
}

export interface SmartStopContext {
  directoryCache?: Map<string, Dirent[]>;
}

const SMART_STOP_RULES: SmartStopRule[] = [
  {
    id: 'python',
    flag: 'python_venv',
    note:
      'Detected Python virtual environment (lib/, bin/, include/, pyvenv.cfg). Skipping deeper traversal.',
    indicatorSets: [
      ['pyvenv.cfg'],
      ['bin/activate', 'lib/python*'],
      ['Scripts/activate', 'Lib/site-packages'],
    ],
  },
  {
    id: 'node',
    flag: 'node_project',
    note:
      'Detected Node.js project (package.json + node_modules). Skipping deeper traversal.',
    indicatorSets: [['package.json', 'node_modules/']],
  },
  {
    id: 'java',
    flag: 'java_project',
    note: 'Detected Java project (pom.xml or build.gradle). Skipping deeper traversal.',
    indicatorSets: [['pom.xml'], ['build.gradle'], ['build.gradle.kts']],
  },
  {
    id: 'dotnet',
    flag: 'dotnet_project',
    note: 'Detected .NET project (*.csproj with bin/ + obj/). Skipping deeper traversal.',
    indicatorSets: [['*.csproj', 'bin/', 'obj/']],
  },
  {
    id: 'go',
    flag: 'go_module',
    note: 'Detected Go module (go.mod). Skipping deeper traversal.',
    indicatorSets: [['go.mod'], ['go.mod', 'vendor/']],
  },
  {
    id: 'rust',
    flag: 'rust_project',
    note: 'Detected Rust project (Cargo.toml + target/). Skipping deeper traversal.',
    indicatorSets: [['Cargo.toml', 'target/']],
  },
  {
    id: 'ruby',
    flag: 'ruby_bundle',
    note: 'Detected Ruby project (Gemfile + .bundle/). Skipping deeper traversal.',
    indicatorSets: [['Gemfile', '.bundle/']],
  },
  {
    id: 'php',
    flag: 'php_project',
    note: 'Detected PHP project (composer.json + vendor/). Skipping deeper traversal.',
    indicatorSets: [['composer.json', 'vendor/']],
  },
  {
    id: 'chrome_extension',
    flag: 'chrome_extension',
    note:
      'Detected Chrome extension (manifest.json). Skipping deeper traversal.',
    indicatorSets: [['manifest.json']],
    verify: async ({ dirPath }) => {
      const manifestPath = path.join(dirPath, 'manifest.json');

      try {
        const rawManifest = await fs.readFile(manifestPath, 'utf8');
        const parsed = JSON.parse(rawManifest) as Record<string, unknown> | null;

        if (!parsed || typeof parsed !== 'object') {
          return false;
        }

        const manifestVersion = (parsed as { manifest_version?: unknown }).manifest_version;
        if (typeof manifestVersion !== 'number') {
          return false;
        }

        const hasExtensionSignal = Boolean(
          (parsed as { action?: unknown }).action ||
            (parsed as { browser_action?: unknown }).browser_action ||
            (parsed as { background?: unknown }).background ||
            (parsed as { content_scripts?: unknown }).content_scripts ||
            (parsed as { chrome_url_overrides?: unknown }).chrome_url_overrides ||
            (Array.isArray((parsed as { permissions?: unknown }).permissions) &&
              ((parsed as { permissions?: unknown }).permissions as unknown[]).length > 0),
        );

        return hasExtensionSignal;
      } catch {
        return false;
      }
    },
  },
];

const defaultDirectoryCache = new Map<string, Dirent[]>();

const getCache = (context?: SmartStopContext) =>
  context?.directoryCache ?? defaultDirectoryCache;

const globToRegExp = (pattern: string) => {
  const escaped = pattern
    .replace(/[-\\^$+?.()|[\]{}]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
};

export const readDirectoryEntries = async (
  dirPath: string,
  context?: SmartStopContext,
  existingEntries?: Dirent[],
): Promise<Dirent[]> => {
  const cache = getCache(context);

  if (existingEntries) {
    cache.set(dirPath, existingEntries);
    return existingEntries;
  }

  const cached = cache.get(dirPath);
  if (cached) {
    return cached;
  }

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    cache.set(dirPath, entries);
    return entries;
  } catch {
    cache.set(dirPath, []);
    return [];
  }
};

const matchIndicatorParts = async (
  dirPath: string,
  entries: Dirent[],
  parts: string[],
  requireDirectoryOnLast: boolean,
  context?: SmartStopContext,
): Promise<boolean> => {
  if (parts.length === 0) {
    return true;
  }

  const [head, ...tail] = parts;
  const matcher = globToRegExp(head);
  const candidates = entries.filter((entry) => matcher.test(entry.name));

  if (candidates.length === 0) {
    return false;
  }

  for (const candidate of candidates) {
    if (tail.length === 0) {
      if (requireDirectoryOnLast && !candidate.isDirectory()) {
        continue;
      }
      return true;
    }

    if (!candidate.isDirectory()) {
      continue;
    }

    const childPath = path.join(dirPath, candidate.name);
    const childEntries = await readDirectoryEntries(childPath, context);
    const matches = await matchIndicatorParts(
      childPath,
      childEntries,
      tail,
      requireDirectoryOnLast,
      context,
    );

    if (matches) {
      return true;
    }
  }

  return false;
};

const matchesIndicator = async (
  dirPath: string,
  entries: Dirent[],
  indicator: string,
  context?: SmartStopContext,
): Promise<boolean> => {
  const trimmed = indicator.trim();
  if (!trimmed) {
    return false;
  }

  const requireDirectoryOnLast = trimmed.endsWith('/');
  const normalised = requireDirectoryOnLast ? trimmed.slice(0, -1) : trimmed;
  const parts = normalised.split(/[/\\]+/).filter(Boolean);

  if (parts.length === 0) {
    return false;
  }

  return matchIndicatorParts(
    dirPath,
    entries,
    parts,
    requireDirectoryOnLast,
    context,
  );
};

const matchesIndicatorSet = async (
  dirPath: string,
  entries: Dirent[],
  indicatorSet: string[],
  context?: SmartStopContext,
): Promise<boolean> => {
  for (const indicator of indicatorSet) {
    const matched = await matchesIndicator(dirPath, entries, indicator, context);
    if (!matched) {
      return false;
    }
  }

  return true;
};

export const detectSmartStop = async ({
  dirPath,
  entries,
  context,
}: {
  dirPath: string;
  entries?: Dirent[];
  context?: SmartStopContext;
}): Promise<SmartStopMatch | null> => {
  const currentEntries = await readDirectoryEntries(dirPath, context, entries);

  for (const rule of SMART_STOP_RULES) {
    for (const indicatorSet of rule.indicatorSets) {
      const matches = await matchesIndicatorSet(
        dirPath,
        currentEntries,
        indicatorSet,
        context,
      );
      if (matches) {
        if (rule.verify) {
          const verified = await rule.verify({
            dirPath,
            entries: currentEntries,
            context,
          });

          if (!verified) {
            continue;
          }
        }

        return { rule };
      }
    }
  }

  return null;
};

export { SMART_STOP_RULES };

export type { SmartStopRule as SmartStopRuleConfig };
