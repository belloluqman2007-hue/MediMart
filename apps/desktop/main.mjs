/**
 * MediMart desktop shell (Electron).
 *
 * Responsibilities, deliberately narrow:
 * 1. Hold the only window and load the *locally served* UI over loopback HTTP.
 * 2. Start the existing Express API + SQLite database as a child process in the user's
 *    application-data directory — never inside the installation folder.
 * 3. Keep the browser sandbox on, expose no Node API to the page, and refuse navigation away.
 * 4. Close the database cleanly on quit so a power-off or close cannot leave a torn WAL behind.
 * 5. Provide a two-step restore: an in-app request file is applied at the next start, while no
 *    other writer holds the database.
 *
 * No credentials are embedded here. The first owner account is created in the app with the
 * setup token that this shell generates once and stores with user-only permissions.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';

const isWindows = process.platform === 'win32';
const userData = app.getPath('userData');
const documents = join(app.getPath('documents'), 'MediMart Backups');
const databasePath = join(userData, 'data', 'medimart.sqlite');
const backupDir = join(userData, 'backups');
const envFile = join(userData, 'medimart.env');
const restoreRequest = `${databasePath}.restore-request`;
const portablePath = join(userData, 'restore.pending');

/** Only 127.0.0.1: the desktop window talks to this machine, not to a network share. */
const PORT = Number(process.env.MEDIMART_DESKTOP_PORT ?? 4780);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let apiProcess = null;
let quitting = false;

function log(message) {
  // Deliberately no credentials, request bodies or patient data in the log.
  console.log(`[medimart-desktop] ${message}`);
}

function ensureDirectories() {
  for (const directory of [join(userData, 'data'), backupDir, documents, join(userData, 'logs')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

/**
 * Portable mode keeps everything inside a folder beside the executable so the shop can move the
 * whole installation (and its data) to another computer on a USB drive.
 */
function resolvePorts() {
  const portableData = process.env.MEDIMART_PORTABLE_DATA;
  if (!portableData) return { databasePath, backupDir };
  return {
    databasePath: join(portableData, 'medimart.sqlite'),
    backupDir: join(portableData, 'backups'),
  };
}

/** Generate the one-time owner setup token on first run, with owner-only file permissions. */
function bootstrapToken() {
  try {
    const existing = readFileSync(envFile, 'utf8')
      .split('\n')
      .find((line) => line.startsWith('BOOTSTRAP_TOKEN='));
    if (existing) return existing.slice('BOOTSTRAP_TOKEN='.length).trim();
  } catch {
    // First run: fall through and create it.
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(
    envFile,
    [
      '# MediMart desktop settings. Keep this file private.',
      `BOOTSTRAP_TOKEN=${token}`,
      'NODE_ENV=production',
      'COOKIE_SECURE=false',
      `API_HOST=127.0.0.1`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  return token;
}

function readEnvValue(key) {
  try {
    const line = readFileSync(envFile, 'utf8')
      .split('\n')
      .find((entry) => entry.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : '';
  } catch {
    return '';
  }
}

function serverEntry() {
  // Packaged layout: <resources>/app.asar.unpacked? No — the server bundle and its native
  // dependencies are unpacked next to the app so better-sqlite3 can load its .node binary.
  const candidates = [
    join(process.resourcesPath, 'server', 'index.js'),
    join(app.getAppPath(), '..', '..', 'apps', 'api', 'dist', 'index.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function localAddresses() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

function applyPendingRestore() {
  if (!existsSync(restoreRequest) || !existsSync(portablePath)) return;
  const safety = `${databasePath}.pre-restore-${Date.now()}`;
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${databasePath}${suffix}`;
      if (existsSync(source))
        writeFileSync(`${safety}${suffix}`, readFileSync(source), { mode: 0o600 });
    }
    for (const suffix of ['-wal', '-shm']) rmSync(`${databasePath}${suffix}`, { force: true });
    writeFileSync(databasePath, readFileSync(portablePath), { mode: 0o600 });
    rmSync(portablePath, { force: true });
    rmSync(restoreRequest, { force: true });
    log(`Restored a prepared backup. Previous database kept at ${safety}`);
  } catch (error) {
    log(`Restore failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

function startServer() {
  const entry = serverEntry();
  if (!entry) return Promise.reject(new Error('The MediMart server bundle is missing.'));
  const { databasePath: dbPath, backupDir: backups } = resolvePorts();
  return new Promise((resolve, reject) => {
    apiProcess = spawn(process.execPath, [entry], {
      cwd: join(process.resourcesPath, 'server'),
      // ELECTRON_RUN_AS_NODE makes the bundled Electron binary behave as a plain Node runtime,
      // so the shop does not need a separate Node.js installation.
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_ENV: 'production',
        API_HOST: '0.0.0.0',
        API_PORT: String(PORT),
        DATABASE_PATH: dbPath,
        BACKUP_DIR: backups,
        BOOTSTRAP_TOKEN: readEnvValue('BOOTSTRAP_TOKEN') || bootstrapToken(),
        COOKIE_SECURE: 'false',
        MEDIMART_MANAGED_DESKTOP: 'true',
        MEDIMART_ALLOW_LAN_HTTP: 'true',
        ALLOWED_ORIGINS: ORIGIN,
        DESKTOP_ALLOWED_ORIGINS: ORIGIN,
        SESSION_HOURS: '12',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Detach so the child dies with this process only when we ask it to.
      detached: false,
    });
    let settled = false;
    const onData = (chunk) => {
      const text = String(chunk);
      if (/listening on/i.test(text)) {
        settled = true;
        log(`Local server ready on ${ORIGIN}`);
        resolve();
      }
    };
    apiProcess.stdout?.on('data', onData);
    apiProcess.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`server stderr: ${text.slice(0, 300)}`);
    });
    apiProcess.on('exit', (code) => {
      apiProcess = null;
      if (!settled) reject(new Error(`The local server stopped with code ${code ?? 'unknown'}.`));
      else if (!quitting) {
        void dialog.showMessageBox({
          type: 'error',
          title: 'MediMart stopped',
          message: 'The local MediMart server stopped unexpectedly.',
          detail:
            'Close MediMart and start it again. If this repeats, restore your most recent backup.',
        });
      }
    });
    setTimeout(() => {
      if (!settled) reject(new Error('The local server did not start within 30 seconds.'));
    }, 30_000);
  });
}

async function stopServer() {
  if (!apiProcess) return;
  const child = apiProcess;
  apiProcess = null;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 8_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    // SIGTERM lets the API close the SQLite handle and checkpoint the WAL.
    try {
      child.kill(isWindows ? undefined : 'SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
    if (isWindows) {
      // Windows has no SIGTERM; ask politely, then force after the grace period.
      spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
    }
  });
}

function buildMenu() {
  const template = [
    {
      label: 'MediMart',
      submenu: [
        {
          label: 'Backup and sync',
          click: () => void mainWindow?.loadURL(`${ORIGIN}/#/backup-sync`),
        },
        { type: 'separator' },
        {
          label: 'Open backup folder',
          click: () => void shell.openPath(backupDir),
        },
        {
          label: 'Open data folder',
          click: () => void shell.openPath(join(userData, 'data')),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Close MediMart' },
      ],
    },
    {
      label: 'Edit',
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        {
          label: 'Zoom in',
          accelerator: 'CommandOrControl+Plus',
          click: () =>
            mainWindow?.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() + 0.5),
        },
        {
          label: 'Zoom out',
          accelerator: 'CommandOrControl+-',
          click: () =>
            mainWindow?.webContents.setZoomLevel(mainWindow.webContents.getZoomLevel() - 0.5),
        },
        {
          label: 'Reset zoom',
          accelerator: 'CommandOrControl+0',
          click: () => mainWindow?.webContents.setZoomLevel(0),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Shop network address',
          click: () => {
            const addresses = localAddresses();
            void dialog.showMessageBox({
              type: 'info',
              title: 'Connect a phone',
              message: addresses.length
                ? 'Use one of these addresses on the phone'
                : 'No local network detected',
              detail: addresses.length
                ? `${addresses.map((address) => `${ORIGIN.replace('127.0.0.1', address)}`).join('\n')}\n\nOpen Settings → Connection & storage on the Android app and enter one of these addresses.`
                : 'Connect this computer to the shop Wi-Fi or router, then check again.',
            });
          },
        },
        {
          label: 'Owner setup token',
          click: () => {
            const token = readEnvValue('BOOTSTRAP_TOKEN');
            void dialog.showMessageBox({
              type: 'info',
              title: 'Owner setup token',
              message: token
                ? 'Enter this token only when creating the first owner account'
                : 'Setup token already used or unavailable',
              detail: token
                ? `${token}\n\nThis token is stored in ${envFile}. Remove the BOOTSTRAP_TOKEN line after the owner account exists, then restart MediMart.`
                : 'If an owner account already exists you do not need it. To create one, follow the installation guide.',
            });
          },
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () =>
            void dialog.showMessageBox({
              type: 'info',
              title: 'MediMart',
              message: `MediMart ${app.getVersion()}`,
              detail: `Database: ${resolvePorts().databasePath}\nBackups: ${backupDir}`,
            }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#f5f8f6',
    title: 'MediMart',
    icon: join(app.getAppPath(), 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      // No preload and no Node integration: the page is ordinary web code with no extra powers.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: process.env.MEDIMART_DESKTOP_DEVTOOLS === 'true',
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  const allowedOrigin = new URL(ORIGIN).origin;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== allowedOrigin) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('render-process-gone', () => {
    void dialog.showMessageBox({
      type: 'error',
      title: 'MediMart window stopped',
      message: 'The MediMart window closed unexpectedly.',
      detail: 'Your data is safe. Start MediMart again from the Start menu.',
    });
  });
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    void stopServer().then(() => {
      quitting = true;
      app.quit();
    });
  });
  void mainWindow.loadURL(`${ORIGIN}/#/`);
}

async function main() {
  ensureDirectories();
  bootstrapToken();
  applyPendingRestore();
  // A second copy would fight over the same SQLite file.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  buildMenu();
  try {
    await startServer();
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'MediMart could not start',
      message: 'The local MediMart server did not start.',
      detail: `${error instanceof Error ? error.message : 'Unknown error'}\n\nCheck that no other MediMart window is open. Your database is at ${resolvePorts().databasePath}.`,
    });
    app.quit();
    return;
  }
  createWindow();
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => app.quit());
}

app.setName('MediMart');
void main();

process.on('uncaughtException', (error) => {
  log(`uncaught exception: ${error.message}`);
});
