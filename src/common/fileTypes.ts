export type FileSystemEntryType = 'file' | 'dir';

export interface FileMetadata {
  /** Kind of filesystem node */
  type: FileSystemEntryType;
  /** Absolute path on disk */
  path: string;
  /** File or directory name */
  name: string;
  /** Path relative to the scanned root directory */
  relativePath: string;
  /** File size in bytes */
  size: number;
  /** ISO timestamp of the last modification */
  lastModified: string;
  /** MIME type inferred from the file extension (files only) */
  mimeType: string | null;
  /** Contextual flags applied by the smart scanner */
  flags: string[];
  /** Optional explanatory note about the detected context */
  note?: string | null;
}

export interface DirectorySnapshot {
  /** Root directory that was scanned */
  rootPath: string;
  /** Collection of all discovered filesystem nodes */
  files: FileMetadata[];
}
