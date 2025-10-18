import { useMemo, useState } from 'react';
import type { DirectorySnapshot, FileMetadata } from '../common/fileTypes';
import './App.css';

const formatBytes = (bytes: number): string => {
  if (bytes === 0) {
    return '0 B';
  }

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / k ** i;
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${sizes[i]}`;
};

const formatDate = (iso: string) => new Date(iso).toLocaleString();

export default function App() {
  const [snapshot, setSnapshot] = useState<DirectorySnapshot | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalSize = useMemo(() => {
    if (!snapshot) {
      return 0;
    }

    return snapshot.files.reduce((sum, file) => sum + file.size, 0);
  }, [snapshot]);

  const handleSelectDirectory = async () => {
    setError(null);
    const directoryPath = await window.electron.fileSystem.selectDirectory();

    if (!directoryPath) {
      return;
    }

    setIsScanning(true);
    try {
      const result =
        await window.electron.fileSystem.scanDirectory(directoryPath);
      setSnapshot(result);
    } catch (scanError) {
      const message =
        scanError instanceof Error
          ? scanError.message
          : 'We could not read that folder. Please check the permissions and try again.';
      setError(message);
      setSnapshot(null);
    } finally {
      setIsScanning(false);
    }
  };

  const renderFileRow = (file: FileMetadata) => (
    <tr key={file.path}>
      <td>
        <code>{file.relativePath}</code>
      </td>
      <td>{file.mimeType ?? 'Unknown'}</td>
      <td>{formatBytes(file.size)}</td>
      <td>{formatDate(file.lastModified)}</td>
    </tr>
  );

  return (
    <div className="App">
      <header className="app-header">
        <div>
          <h1>Local file system snapshot</h1>
          <p>
            Select a folder to generate a read-only inventory of every file we
            can access. Only metadata is collected — the app never copies or
            uploads your content.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSelectDirectory}
          disabled={isScanning}
        >
          {isScanning ? 'Scanning…' : 'Choose folder'}
        </button>
      </header>

      {error && <div className="app-alert">{error}</div>}

      {snapshot ? (
        <section className="snapshot">
          <div className="snapshot-summary">
            <div>
              <span className="label">Root directory</span>
              <code className="snapshot-path">{snapshot.rootPath}</code>
            </div>
            <div>
              <span className="label">Files discovered</span>
              <strong>{snapshot.files.length}</strong>
            </div>
            <div>
              <span className="label">Total size</span>
              <strong>{formatBytes(totalSize)}</strong>
            </div>
          </div>

          {snapshot.files.length > 0 ? (
            <div className="file-table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Relative path</th>
                    <th>MIME type</th>
                    <th>Size</th>
                    <th>Last modified</th>
                  </tr>
                </thead>
                <tbody>{snapshot.files.map(renderFileRow)}</tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">
              We didn&apos;t find any files inside this folder.
            </p>
          )}
        </section>
      ) : (
        <section className="empty-state">
          <p>Select a folder to begin exploring its metadata.</p>
        </section>
      )}
    </div>
  );
}
