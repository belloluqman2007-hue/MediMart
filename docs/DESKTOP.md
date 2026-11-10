# MediMart on a Windows computer

The Windows application is the **central computer** of the shop. It holds the one business database,
serves the phones on the same Wi-Fi, and works with no internet connection.

> **What has actually been checked in the build environment, and what has not.** The desktop package
> has been assembled and its server verified (the packaged API starts, migrates a fresh database,
> answers `/api/health`, and serves the built interface). It has **not** been launched as a Windows
> window on a real Windows machine: this build environment is Linux and cannot download the Electron
> Windows runtime. See [Verification status](#verification-status) for the exact list.

---

## 1. What you need

| Item                 | Requirement                                                                          |
| -------------------- | ------------------------------------------------------------------------------------ |
| Computer             | Intel Celeron N3050 or better, 4 GB RAM, 64 GB storage                               |
| Windows              | Windows 10 (21H2 or later) or Windows 11, 64-bit                                     |
| Disk space           | About 400 MB free for the application, plus room for backups                         |
| Network              | Not required for a single computer. A Wi-Fi router is needed only to connect phones. |
| Administrator rights | **Not required.** The application is a folder, not an installer.                     |
| Internet             | Not required to run. Only needed once, to download the zip file.                     |

## 2. Install (about two minutes)

1. Copy `MediMart-<version>-win-x64.zip` to the shop computer.
2. Right-click the zip → **Extract All**. Choose a simple location such as
   `C:\MediMart`. Do **not** run it from inside the zip, and do not put it on a USB stick you plan
   to remove.
3. Open the `MediMart-win32-x64` folder and double-click **MediMart.exe**.
4. Windows may show "Windows protected your PC". This appears for any application that is not
   code-signed. Click **More info** → **Run anyway**. The application is not signed because a
   signing certificate is a paid service; the source is in this repository and can be reviewed.
5. A window opens. On first start MediMart creates its own database and a **setup token**, and shows
   the token on screen: keep that window open, you need the token for step 4 below.

Shortcut: right-click `MediMart.exe` → **Send to** → **Desktop (create shortcut)**. The taskbar and
window icon are the green MediMart cross.

## 3. Where your data lives

MediMart never writes business data inside its own program folder, so you can replace the folder
during an update without losing anything.

| What                     | Where                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Business database        | `%APPDATA%\MediMart\data\medimart.sqlite`                                              |
| Backups                  | `%APPDATA%\MediMart\backups` (a copy is also placed in **Documents\MediMart Backups**) |
| Settings and setup token | `%APPDATA%\MediMart\medimart.env` (readable only by your Windows account)              |
| Logs                     | `%APPDATA%\MediMart\logs` — technical only, no patient or password data                |

To see `%APPDATA%`, press **Win+R**, type `%APPDATA%`, press Enter.

The database is a single file. Copying it while MediMart is running can capture a half-written
state, so **always use the Backup button instead of copying the file** (see section 7).

## 4. First-time setup (the owner does this once)

1. In the MediMart window, choose **Create owner account**.
2. Enter your full name, your email address and a long password (at least 12 characters; a
   sentence you can remember is ideal).
3. Enter the **setup token** shown in the black startup window.
4. Click **Create owner account**. You are signed in as the owner.

The setup token exists only to stop someone else from claiming the shop's database first. After the
owner exists, the token cannot create another owner. Delete nothing; just close the black window only
after MediMart has finished starting (it says the database is ready).

### Create staff accounts

**Settings → Staff → New staff member.** Give each person their own account and the roles they
need: `manager`, `pharmacist`, `cashier`, `healthcare_professional`, `inventory_officer`. Never share
one login: the audit trail records who did what, and a shared account destroys that record.

## 5. Starting and stopping safely

- **Start:** double-click `MediMart.exe`. First start of the day takes a few seconds.
- **Stop:** close the window with the **X**, then wait for the window to disappear. MediMart shuts the
  database down cleanly on close.
- **Do not** end the process from Task Manager or switch the computer off at the wall while MediMart
  is open. If the power does fail, start MediMart again; SQLite recovers its own journal, and the
  application refuses to start rather than run on a damaged file.
- Only one copy can run at a time; a second double-click brings the existing window forward.

## 6. Connecting phones to this computer

1. Connect the computer and the phones to the **same Wi-Fi router**. The router does not need
   internet.
2. In MediMart open **Settings → Connection & storage**. It shows this computer's local address,
   for example `https://192.168.1.20:4780`.
3. On the phone, install the MediMart APK (see [ANDROID.md](ANDROID.md)), open it, and type that
   address.
4. Approve the pairing code on the computer: **Settings → Device pairing**.

If Windows asks whether to allow MediMart on the network, tick **Private networks** and allow it.
On a public network, keep it blocked.

## 7. Backups

**Backup and Sync → Create backup now.**

- Each backup is a complete, self-consistent copy of the business database, written with SQLite's
  own snapshot mechanism, then **verified** by opening it and running integrity checks.
- The file is named with its date and time, e.g. `medimart-backup-20261110T172207054Z-manual.sqlite`,
  so you can tell backups apart at a glance.
- **Verify** re-checks any backup in the list without restoring it.
- Automatic daily backups are on by default. Keep them on.

**A backup on the same computer is not a backup.** Once a week, copy the backup folder to a USB
drive that lives somewhere else, and take one backup before any price change, stock count or big
correction.

### Restoring a backup

1. **Backup and Sync → Restore** next to the backup you want.
2. Read the warning: everything recorded after that backup will disappear from MediMart.
3. Type `RESTORE` and confirm. MediMart prepares, verifies and stages the file, and keeps a safety
   copy of the current database beside it.
4. **Close MediMart and open it again.** The restore is applied during startup, while nothing else is
   writing to the database. This is deliberate: swapping the file under a running server corrupts
   databases.

If the restore cannot be prepared the application says so and leaves your current data alone.

## 8. Clear error messages you may see

| Message                                         | What it means                                                            | What to do                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| "Another copy of MediMart is already running"   | The single-instance guard worked                                         | Use the window that is already open                                                           |
| "MediMart could not open its database"          | The data folder is read-only, on a removed drive, or the file is damaged | Check the drive; restore the newest backup if the file is damaged                             |
| "The shop computer is unreachable" (on a phone) | Wrong address, different Wi-Fi, or Windows Firewall                      | Recheck the address in Settings → Connection & storage and allow MediMart on Private networks |
| "Port 4780 is already in use"                   | Another program took the port                                            | Close the other program, or set `API_PORT` in `medimart.env`                                  |
| "MediMart is already set up"                    | Someone tried to create a second owner                                   | Sign in, then add staff accounts instead                                                      |

## 9. Building the Windows package yourself

```bash
npm ci
npm run build                      # API + web
node scripts/generate-icons.mjs    # regenerate the application icons (optional)
node scripts/build-desktop.mjs     # downloads Electron 38.4.0 for win32-x64 and assembles the folder
```

Output: `dist/desktop/MediMart-win32-x64/` and `dist/desktop/MediMart-<version>-win-x64.zip`.
On a machine with no internet, extract the Electron runtime yourself and point the script at it:
`MEDIMART_ELECTRON_DIR=/path/to/electron-v38.4.0-win32-x64 node scripts/build-desktop.mjs`.

The packaged folder contains: `MediMart.exe`, `resources/app` (the shell and icons) and
`resources/server` (API bundle, native modules, built interface). It contains **no** `.env` file, no
setup token, no staff credentials and no test fixtures. The token is generated on the owner's own
machine at first start.

### How the application is built to be safe

- The window loads only `http://127.0.0.1:4780`; navigation away is blocked and new windows are
  denied. Node integration is off, context isolation and the sandbox are on, and there is no preload
  script, so the interface cannot reach the operating system.
- The API runs as a child process of the same executable, on this computer only.
- Compressed or encrypted-at-rest copies of patient data are **not** provided: the database file is
  protected by Windows file permissions for your account. Keep the computer's login protected and
  the backup folder private.

## Verification status

| Item                                                                                                   | Status                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged server starts, migrates, answers health and serves the built interface                        | **Verified in this environment** (`node index.js` from `resources/server`, empty database)                                                                                                           |
| Packager assembles `MediMart-win32-x64` with the server, web build, native modules, icons and manifest | **Verified** (`dist/desktop/build-manifest.json`)                                                                                                                                                    |
| Desktop shell syntax and configuration (`main.mjs`)                                                    | **Verified** by `node --check` and review; single window, navigation blocked                                                                                                                         |
| Electron Windows runtime download and window launch on Windows                                         | **Not verified here.** This machine is Linux and the download is blocked, so `MediMart.exe` was assembled from a stub runtime. Launching the real window must be confirmed on a Windows 10 computer. |
| Startup/shutdown without database corruption on a real Windows machine                                 | **Not verified here** (same reason)                                                                                                                                                                  |
| Backup creation, verification and restore preparation                                                  | **Verified** by automated tests against real files on disk                                                                                                                                           |

Known limitations: there is no code-signing certificate, so SmartScreen shows a warning on first run;
there is no Windows Installer (`.msi`) or auto-update; and the taskbar icon comes from the window,
not from an embedded resource in the `.exe`.
