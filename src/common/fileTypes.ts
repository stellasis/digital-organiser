export interface FileMetadata {
  /** Absolute path on disk */
  path: string;
  /** File name including extension */
  name: string;
  /** Path relative to the scanned root directory */
  relativePath: string;
  /** File size in bytes */
  size: number;
  /** ISO timestamp of the last modification */
  lastModified: string;
  /** MIME type inferred from the file extension */
  mimeType: string | null;
}

export interface DirectorySnapshot {
  /** Root directory that was scanned */
  rootPath: string;
  /** Collection of all discovered file metadata */
  files: FileMetadata[];
}
