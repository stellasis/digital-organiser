import fs from 'fs/promises';
import path from 'path';
import type {
  Diff,
  DiffApplyOperationResult,
  DiffApplyOperationStatus,
  DiffApplyResponse,
  DiffDryRunOperationReport,
  DiffDryRunReport,
  DiffDryRunPrecondition,
  DiffOp,
  MoveOp,
  RenameOp,
} from '../types/diff';
import type { Snapshot } from '../types/snapshot';

interface PathResolution {
  rootName: string;
  toAbsolute: (treePath: string) => string;
  toParentAbsolute: (treePath: string) => string;
}

const inferRootName = (diff: Diff): string => {
  for (const op of diff.ops) {
    if (op.type === 'create' && op.parentPath) {
      return op.parentPath.split('/')[0];
    }
    if (op.type === 'rename') {
      const segment = op.fromPath.split('/')[0];
      if (segment) return segment;
    }
    if (op.type === 'move') {
      const segment = op.fromPath.split('/')[0];
      if (segment) return segment;
    }
    if (op.type === 'delete' && op.atPath) {
      const segment = op.atPath.split('/')[0];
      if (segment) return segment;
    }
  }
  const basename = path.basename(diff.baseRoot);
  if (basename && basename !== path.sep) {
    return basename;
  }
  const parsed = path.parse(diff.baseRoot);
  return parsed.name || parsed.base || parsed.root || diff.baseRoot;
};

const createResolver = (diff: Diff): PathResolution => {
  const rootName = inferRootName(diff);
  const normaliseSegments = (treePath: string): string[] => {
    if (!treePath) return [];
    const cleaned = treePath.replace(/\\/g, '/');
    const segments = cleaned.split('/').filter(Boolean);
    if (segments[0] === rootName) {
      return segments.slice(1);
    }
    return segments;
  };
  const toAbsolute = (treePath: string) => {
    const segments = normaliseSegments(treePath);
    return path.join(diff.baseRoot, ...segments);
  };
  const toParentAbsolute = (treePath: string) => {
    const segments = normaliseSegments(treePath);
    return path.join(diff.baseRoot, ...segments);
  };
  return { rootName, toAbsolute, toParentAbsolute };
};

const describeOp = (op: DiffOp, resolver: PathResolution): string => {
  switch (op.type) {
    case 'create':
      return `Create ${op.kind} ${path.join(resolver.toParentAbsolute(op.parentPath), op.name)}`;
    case 'move':
      return `Move ${op.kind} from ${resolver.toAbsolute(op.fromPath)} to ${resolver.toParentAbsolute(op.toParentPath)}`;
    case 'rename':
      return `Rename ${op.kind} from ${resolver.toAbsolute(op.fromPath)} to ${resolver.toAbsolute(op.toPath)}`;
    case 'delete':
      return `Delete ${op.kind} at ${resolver.toAbsolute(op.atPath)}`;
    default: {
      const exhaustive: never = op;
      throw new Error(`Unsupported diff op ${(exhaustive as { type: string }).type}`);
    }
  }
};

const pathExists = async (targetPath: string) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const resolveRenameSourcePath = async (
  op: RenameOp,
  resolver: PathResolution,
): Promise<string> => {
  const originalPath = resolver.toAbsolute(op.fromPath);
  if (await pathExists(originalPath)) {
    return originalPath;
  }
  const targetDirectory = path.dirname(resolver.toAbsolute(op.toPath));
  const candidate = path.join(targetDirectory, op.fromName);
  return candidate;
};

const resolveMoveTargetPath = (op: MoveOp, resolver: PathResolution): string => {
  const fromAbsolute = resolver.toAbsolute(op.fromPath);
  const parentTarget = resolver.toParentAbsolute(op.toParentPath);
  const name = path.basename(fromAbsolute);
  return path.join(parentTarget, name);
};

const buildDryRunReport = async (diff: Diff): Promise<DiffDryRunReport> => {
  const resolver = createResolver(diff);
  const operations: DiffDryRunOperationReport[] = [];
  const issues: string[] = [];

  for (const op of diff.ops) {
    let precondition: DiffDryRunPrecondition = 'ok';
    let message: string | undefined;
    let targetPath = '';

    if (op.type === 'create') {
      targetPath = path.join(resolver.toParentAbsolute(op.parentPath), op.name);
      if (await pathExists(targetPath)) {
        precondition = 'target-exists';
        message = 'Target already exists';
      }
    } else if (op.type === 'move') {
      const sourcePath = resolver.toAbsolute(op.fromPath);
      targetPath = resolveMoveTargetPath(op, resolver);
      if (!(await pathExists(sourcePath))) {
        precondition = 'missing-source';
        message = 'Source path is missing';
      } else if (await pathExists(targetPath)) {
        precondition = 'target-exists';
        message = 'Destination already exists';
      }
    } else if (op.type === 'rename') {
      targetPath = resolver.toAbsolute(op.toPath);
      const sourcePath = await resolveRenameSourcePath(op, resolver);
      if (!(await pathExists(sourcePath))) {
        precondition = 'missing-source';
        message = 'Source path is missing';
      } else if ((await pathExists(targetPath)) && path.normalize(targetPath) !== path.normalize(sourcePath)) {
        precondition = 'target-exists';
        message = 'Destination already exists';
      }
    } else if (op.type === 'delete') {
      targetPath = resolver.toAbsolute(op.atPath);
      if (!(await pathExists(targetPath))) {
        precondition = 'missing-source';
      }
    }

    if (precondition !== 'ok') {
      issues.push(`${describeOp(op, resolver)}: ${message ?? precondition}`);
    }

    operations.push({
      op,
      targetPath,
      description: describeOp(op, resolver),
      precondition,
      message,
    });
  }

  return {
    baseRoot: diff.baseRoot,
    rootName: resolver.rootName,
    operations,
    issues,
  };
};

const defaultCheckFileLock = async (targetPath: string) => {
  try {
    const handle = await fs.open(targetPath, 'r+');
    await handle.close();
    return 'ok' as const;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = (error as { code?: string }).code;
      if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
        return 'locked' as const;
      }
      if (code === 'ENOENT') {
        return 'missing' as const;
      }
    }
    return 'locked' as const;
  }
};

export interface DiffExecutionOptions {
  confirmApply?: (report: DiffDryRunReport) => Promise<boolean>;
  onLockedFile?: (filePath: string) => Promise<'retry' | 'skip' | 'abort'>;
  generateSnapshot: (rootPath: string) => Promise<Snapshot>;
  persistSnapshot?: (snapshot: Snapshot) => Promise<{ filePath: string; version: string }>;
  checkFileLock?: (filePath: string) => Promise<'ok' | 'locked' | 'missing'>;
}

const recordResult = (
  results: DiffApplyOperationResult[],
  op: DiffOp,
  status: DiffApplyOperationStatus,
  targetPath: string,
  message?: string,
) => {
  results.push({
    type: op.type,
    kind: op.kind,
    status,
    targetPath,
    message,
  });
};

const shouldCheckLock = (op: DiffOp) => op.kind === 'file' && op.type !== 'create';

export const dryRunDiff = (diff: Diff) => buildDryRunReport(diff);

export const applyDiff = async (
  diff: Diff,
  options: DiffExecutionOptions,
): Promise<DiffApplyResponse> => {
  const resolver = createResolver(diff);
  const dryRunReport = await buildDryRunReport(diff);

  if (options.confirmApply) {
    const proceed = await options.confirmApply(dryRunReport);
    if (!proceed) {
      return { ok: false, results: [], dryRunReport, aborted: true };
    }
  }

  const results: DiffApplyOperationResult[] = [];
  let aborted = false;
  const checkLock = options.checkFileLock ?? defaultCheckFileLock;

  for (let index = 0; index < diff.ops.length; index += 1) {
    const op = diff.ops[index];
    const dryRunInfo = dryRunReport.operations[index];
    if (aborted) {
      recordResult(results, op, 'aborted', describeOp(op, resolver));
      // eslint-disable-next-line no-continue
      continue;
    }

    let targetPath = '';
    try {
      if (dryRunInfo && dryRunInfo.precondition !== 'ok') {
        recordResult(results, op, 'failed', dryRunInfo.targetPath, dryRunInfo.message);
        // eslint-disable-next-line no-continue
        continue;
      }
      if (op.type === 'create') {
        targetPath = path.join(resolver.toParentAbsolute(op.parentPath), op.name);
        if (op.kind === 'folder') {
          await fs.mkdir(targetPath, { recursive: true });
        } else {
          await fs.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.writeFile(targetPath, '', { flag: 'w' });
        }
        recordResult(results, op, 'applied', targetPath);
        continue;
      }

      if (op.type === 'move') {
        const sourcePath = resolver.toAbsolute(op.fromPath);
        targetPath = resolveMoveTargetPath(op, resolver);
        if (shouldCheckLock(op)) {
          const lockState = await checkLock(sourcePath);
          if (lockState === 'locked' && options.onLockedFile) {
            let decision: 'retry' | 'skip' | 'abort';
            // eslint-disable-next-line no-constant-condition
            while (true) {
              decision = await options.onLockedFile(sourcePath);
              if (decision === 'retry') {
                if ((await checkLock(sourcePath)) !== 'locked') {
                  break;
                }
                // continue loop
              } else {
                break;
              }
            }
            if (decision === 'skip') {
              recordResult(results, op, 'skipped', targetPath, 'User skipped locked file');
              continue;
            }
            if (decision === 'abort') {
              aborted = true;
              recordResult(results, op, 'aborted', targetPath, 'User aborted due to lock');
              continue;
            }
          } else if (lockState === 'locked') {
            recordResult(results, op, 'failed', targetPath, 'File is locked');
            continue;
          }
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.rename(sourcePath, targetPath);
        recordResult(results, op, 'applied', targetPath);
        continue;
      }

      if (op.type === 'rename') {
        const desiredTarget = resolver.toAbsolute(op.toPath);
        targetPath = desiredTarget;
        const sourcePath = await resolveRenameSourcePath(op, resolver);
        if (shouldCheckLock(op)) {
          const lockState = await checkLock(sourcePath);
          if (lockState === 'locked' && options.onLockedFile) {
            let decision: 'retry' | 'skip' | 'abort';
            // eslint-disable-next-line no-constant-condition
            while (true) {
              decision = await options.onLockedFile(sourcePath);
              if (decision === 'retry') {
                if ((await checkLock(sourcePath)) !== 'locked') {
                  break;
                }
              } else {
                break;
              }
            }
            if (decision === 'skip') {
              recordResult(results, op, 'skipped', desiredTarget, 'User skipped locked file');
              continue;
            }
            if (decision === 'abort') {
              aborted = true;
              recordResult(results, op, 'aborted', desiredTarget, 'User aborted due to lock');
              continue;
            }
          } else if (lockState === 'locked') {
            recordResult(results, op, 'failed', desiredTarget, 'File is locked');
            continue;
          }
        }
        await fs.mkdir(path.dirname(desiredTarget), { recursive: true });
        await fs.rename(sourcePath, desiredTarget);
        recordResult(results, op, 'applied', desiredTarget);
        continue;
      }

      if (op.type === 'delete') {
        targetPath = resolver.toAbsolute(op.atPath);
        if (shouldCheckLock(op)) {
          const lockState = await checkLock(targetPath);
          if (lockState === 'locked' && options.onLockedFile) {
            let decision: 'retry' | 'skip' | 'abort';
            // eslint-disable-next-line no-constant-condition
            while (true) {
              decision = await options.onLockedFile(targetPath);
              if (decision === 'retry') {
                if ((await checkLock(targetPath)) !== 'locked') {
                  break;
                }
              } else {
                break;
              }
            }
            if (decision === 'skip') {
              recordResult(results, op, 'skipped', targetPath, 'User skipped locked file');
              continue;
            }
            if (decision === 'abort') {
              aborted = true;
              recordResult(results, op, 'aborted', targetPath, 'User aborted due to lock');
              continue;
            }
          } else if (lockState === 'locked') {
            recordResult(results, op, 'failed', targetPath, 'File is locked');
            continue;
          }
        }
        await fs.rm(targetPath, { recursive: op.recursive ?? false, force: true });
        recordResult(results, op, 'applied', targetPath);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      recordResult(results, op, 'failed', targetPath, message);
    }
  }

  const ok = !results.some((result) => result.status === 'failed' || result.status === 'aborted');
  let snapshot: Snapshot | undefined;
  let snapshotFile: string | undefined;
  let snapshotVersion: string | undefined;
  if (ok || !aborted) {
    snapshot = await options.generateSnapshot(diff.baseRoot);
    if (options.persistSnapshot) {
      const persisted = await options.persistSnapshot(snapshot);
      snapshot.persistedPath = persisted.filePath;
      snapshot.version = persisted.version;
      snapshot.savedAtIso = new Date().toISOString();
      snapshotFile = persisted.filePath;
      snapshotVersion = persisted.version;
    }
  }

  return {
    ok,
    results,
    dryRunReport,
    snapshot,
    snapshotFile,
    snapshotVersion: snapshotVersion ?? snapshot?.version,
    aborted,
  };
};
