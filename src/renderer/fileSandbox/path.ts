export enum PathKind {
  AbsoluteOrRelative,
  RelativeOnly,
}

const windowsDrivePattern = /^[A-Za-z]:/;
const invalidCharacters = /[\\/:*?"<>|]/;
const reservedNames = new Set(
  [
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ].map((name) => name.toLowerCase()),
);

export const isReservedName = (name: string) =>
  reservedNames.has(name.toLowerCase());

export const hasInvalidCharacters = (name: string) => invalidCharacters.test(name);

export const splitPath = (input: string): string[] =>
  input.split('/').filter((part) => part.length > 0);

export const joinPath = (...parts: string[]) =>
  parts.filter(Boolean).join('/');

const normaliseSegments = (segments: string[]) => {
  const stack: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) {
        throw new Error('Cannot normalise path that escapes root');
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack;
};

const normaliseInternal = (
  raw: string,
  kind: PathKind,
): { root: string | null; segments: string[] } => {
  const trimmed = raw.replace(/\\/g, '/').replace(/\/+/g, '/');
  const hasDrive = windowsDrivePattern.test(trimmed);
  const isAbsolute = trimmed.startsWith('/') || hasDrive;

  if (kind === PathKind.RelativeOnly && isAbsolute) {
    throw new Error('Expected relative path');
  }

  const withoutTrailing = trimmed.endsWith('/') && trimmed.length > 1
    ? trimmed.slice(0, -1)
    : trimmed;

  const root = hasDrive
    ? withoutTrailing.slice(0, 2)
    : withoutTrailing.startsWith('/')
      ? '/'
      : null;

  const rest = root ? withoutTrailing.slice(root === '/' ? 1 : root.length + 1) : withoutTrailing;
  const rawSegments = rest.length === 0 ? [] : rest.split('/');
  const segments = normaliseSegments(rawSegments);

  return { root, segments };
};

export const normalisePath = (raw: string, kind = PathKind.AbsoluteOrRelative): string => {
  const { root, segments } = normaliseInternal(raw, kind);
  const body = segments.join('/');

  if (!root) {
    return body || '.';
  }

  if (root === '/') {
    return `/${body}`.replace(/\/$/, '') || '/';
  }
  const prefix = root.endsWith(':') ? root : `${root}:`;
  const combined = `${prefix}/${body}`;
  return combined.replace(/\/$/, '');
};

export const ensureValidName = (name: string) => {
  if (!name || name.trim().length === 0) {
    throw new Error('Name cannot be empty');
  }
  if (hasInvalidCharacters(name)) {
    throw new Error(`Name ${name} contains invalid characters`);
  }
  if (isReservedName(name)) {
    throw new Error(`Name ${name} is reserved`);
  }
};

export const splitStemAndExtension = (name: string) => {
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, lastDot), extension: name.slice(lastDot) };
};
