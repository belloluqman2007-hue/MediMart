/**
 * Run npm (or an npm-installed binary) from a build script on any platform.
 *
 * On Windows `npm` is `npm.cmd`, and since the CVE-2024-27980 fix Node refuses to spawn a `.cmd`
 * file with `execFile`/`spawn` unless a shell is involved — it throws `EINVAL`. A build script that
 * simply used `execFileSync('npm.cmd', …)` therefore worked on Linux and failed on every Windows
 * machine, including the Windows runner that packages the desktop application.
 *
 * The reliable way is to run npm's own JavaScript entry point with the current Node binary:
 *   node <npm>/bin/npm-cli.js run build
 * That needs no shell (so no quoting or injection problems) and behaves identically everywhere.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The npm CLI entry point for the Node running this script, or null when it cannot be found. */
function npmCliPath() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && /npm-cli\.js$/.test(fromEnv) && existsSync(fromEnv)) return fromEnv;
  const bin = dirname(process.execPath);
  const candidates = [
    join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(bin, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Run `npm <args>` in `cwd`, streaming output. Throws (non-zero exit) exactly like npm would.
 */
export function runNpm(args, { cwd, env } = {}) {
  const cli = npmCliPath();
  if (cli) {
    execFileSync(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    return;
  }
  // Last resort: let the shell resolve `npm`. Arguments here are always static build words.
  execFileSync('npm', args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

/**
 * A binary installed in the repository's node_modules (for example the Capacitor CLI), run with
 * the current Node so the Windows `.cmd` shim is never involved.
 */
export function runNodeBin(binPath, args, { cwd, env } = {}) {
  execFileSync(process.execPath, [binPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
}
