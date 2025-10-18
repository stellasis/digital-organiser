/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import { scanDirectory } from './scanner';
import { sandboxSampleSnapshot } from '../common/sandboxSample';
import type { Diff } from '../types/diff';
import { generateSnapshot, persistSnapshot } from './snapshotBuilder';
import { applyDiff as executeDiff, dryRunDiff } from './diffExecutor';
import type { DiffApplyResponse } from '../types/diff';
import type { Snapshot } from '../types/snapshot';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;

ipcMain.on('ipc-example', async (event, arg) => {
  const msgTemplate = (pingPong: string) => `IPC test: ${pingPong}`;
  console.log(msgTemplate(arg));
  event.reply('ipc-example', msgTemplate('pong'));
});

ipcMain.handle('dialog:selectDirectory', async () => {
  const browserWindow = BrowserWindow.getFocusedWindow() ?? undefined;
  const result = await dialog.showOpenDialog(browserWindow, {
    properties: ['openDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

ipcMain.handle(
  'scanner:scanDirectory',
  async (_event, directoryPath: string) => {
    if (!directoryPath) {
      return { rootPath: '', files: [] };
    }

    return scanDirectory(directoryPath);
  },
);

const getSnapshotCacheDir = () => {
  const cacheRoot = app.getPath('userData');
  return path.join(cacheRoot, 'snapshots');
};

const decorateSnapshot = async (snapshot: Snapshot) => {
  const cacheDir = getSnapshotCacheDir();
  const persisted = await persistSnapshot(snapshot, cacheDir);
  return {
    ...snapshot,
    persistedPath: persisted.filePath,
    version: snapshot.version ?? persisted.version,
    savedAtIso: new Date().toISOString(),
  };
};

ipcMain.handle('sandbox:requestSnapshot', async (_event, rootPath: string) => {
  if (!rootPath) {
    return sandboxSampleSnapshot;
  }
  const snapshot = await generateSnapshot(rootPath);
  return decorateSnapshot(snapshot);
});

ipcMain.handle('sandbox:createSnapshot', async (_event, rootPath: string) => {
  const snapshot = await generateSnapshot(rootPath);
  return decorateSnapshot(snapshot);
});

ipcMain.handle('sandbox:previewDiff', async (_event, diff: Diff) => {
  const report = await dryRunDiff(diff);
  return {
    ok: report.issues.length === 0,
    dryRunReport: report,
  };
});

ipcMain.handle('sandbox:applyDiff', async (_event, diff: Diff): Promise<DiffApplyResponse> => {
  const browserWindow = BrowserWindow.getFocusedWindow() ?? undefined;
  const response = await executeDiff(diff, {
    confirmApply: async (report) => {
      const detail = report.operations
        .map((operation) => `• ${operation.description}`)
        .join('\n');
      const result = await dialog.showMessageBox(browserWindow, {
        type: 'question',
        buttons: ['Apply', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        title: 'Apply changes',
        message: `Apply ${report.operations.length} changes to ${report.baseRoot}?`,
        detail,
      });
      return result.response === 0;
    },
    onLockedFile: async (filePath) => {
      const result = await dialog.showMessageBox(browserWindow, {
        type: 'warning',
        buttons: ['Retry', 'Skip', 'Abort'],
        defaultId: 0,
        cancelId: 2,
        title: 'File in use',
        message: 'A file is currently in use.',
        detail: `${filePath}\nChoose how to proceed.`,
      });
      if (result.response === 0) return 'retry';
      if (result.response === 1) return 'skip';
      return 'abort';
    },
    generateSnapshot: (rootPath) => generateSnapshot(rootPath),
    persistSnapshot: async (snapshot) => {
      const decorated = await decorateSnapshot(snapshot);
      return { filePath: decorated.persistedPath ?? '', version: decorated.version ?? '' };
    },
  });
  return response;
});

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
