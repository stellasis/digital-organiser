// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type { DirectorySnapshot } from '../common/fileTypes';
import type { Snapshot } from '../types/snapshot';
import type { Diff } from '../types/diff';

export type Channels = 'ipc-example';

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
  },
  fileSystem: {
    selectDirectory(): Promise<string | null> {
      return ipcRenderer.invoke('dialog:selectDirectory');
    },
    scanDirectory(directoryPath: string): Promise<DirectorySnapshot> {
      return ipcRenderer.invoke('scanner:scanDirectory', directoryPath);
    },
  },
  sandbox: {
    requestSnapshot(rootPath: string): Promise<Snapshot> {
      return ipcRenderer.invoke('sandbox:requestSnapshot', rootPath);
    },
    previewDiff(diff: Diff): Promise<{ ok: boolean; dryRunReport: any }> {
      return ipcRenderer.invoke('sandbox:previewDiff', diff);
    },
    applyDiff(diff: Diff): Promise<{ ok: boolean; results: any[] }> {
      return ipcRenderer.invoke('sandbox:applyDiff', diff);
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
