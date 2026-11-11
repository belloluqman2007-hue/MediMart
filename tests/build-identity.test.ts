import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildStamp, formatBuildLabel, type BuildStamp } from '../apps/web/src/platform/build-info';
import { redact } from '../apps/web/src/platform/diagnostics';

/**
 * Build identity.
 *
 * These tests exist because of a support dead end, not because version numbers are interesting: a
 * shop owner installed an APK that showed "Local storage needs attention", and neither the phone
 * nor the artifact could say *which* build was installed — the pre-fix and post-fix APKs both
 * reported `versionName 0.2.0` / `versionCode 2`. The diagnostic code names the cause; the build
 * stamp names the code that produced it. Both must be present, consistent and safe to display.
 */

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const packageVersion = (JSON.parse(read('package.json')) as { version: string }).version;
const gradle = read('apps/web/android/app/build.gradle');
const gradleVersionName = /versionName\s+"([^"]+)"/.exec(gradle)?.[1];
const gradleVersionCode = Number(/versionCode\s+(\d+)/.exec(gradle)?.[1]);

describe('the installed build is identifiable', () => {
  it('reports the same version on the phone and in the bundle', () => {
    // Settings → Apps → MediMart shows the Gradle versionName; the failure screen shows the bundle
    // stamp. If these drift, a support report names a build that does not exist.
    expect(gradleVersionName).toBe(packageVersion);
    expect(Number.isInteger(gradleVersionCode)).toBe(true);
    // 0.2.0/2 was the version pair shared by two different APKs. Never go back to it.
    expect(gradleVersionCode).toBeGreaterThanOrEqual(3);
  });

  it('is stamped into the bundle by the Vite build', () => {
    const viteConfig = read('apps/web/vite.config.ts');
    expect(viteConfig).toContain('__MEDIMART_BUILD__');
    expect(viteConfig).toContain("rev-parse', '--short=8'");
    // The failure screen and the start-up log are the two places a human reads the stamp.
    expect(read('apps/web/src/App.tsx')).toContain('formatBuildLabel()');
    expect(read('apps/web/src/main.tsx')).toContain("startupLog.info('build'");
    // The native self-check logs the installed APK version before any WebView exists.
    expect(
      read('apps/web/android/app/src/main/java/com/medimart/app/StartupSelfCheck.java'),
    ).toMatch(/version="\s*\n?\s*\+\s*appVersion/);
  });

  it('compiles nothing secret-shaped into the label', () => {
    // The label is shown on screen and written to logcat, so the redactor must have nothing to do:
    // a version, a short commit hash, a date and a build profile are all public.
    const stamp: BuildStamp = {
      version: '0.3.0',
      commit: 'a1b2c3d4',
      builtAt: '2026-11-11T08:54:02.000Z',
      profile: 'production',
    };
    const label = formatBuildLabel(stamp);
    expect(label).toBe('0.3.0 · a1b2c3d4 · 2026-11-11 · production');
    expect(redact(label)).toBe(label);
  });

  it('drops what it does not know instead of inventing it', () => {
    expect(
      formatBuildLabel({ version: '0.3.0', commit: 'unknown', builtAt: '', profile: '' }),
    ).toBe('0.3.0');
    // A source tarball with no Git repository still produces a buildable, honest label.
    expect(
      formatBuildLabel({ version: '', commit: 'unknown', builtAt: '', profile: 'unbundled' }),
    ).toBe('');
  });

  it('never throws when the bundle carries no stamp', () => {
    // Unit tests run without Vite's `define`, which is exactly the unbundled case: the guard must
    // degrade, not raise a ReferenceError during start-up.
    expect(buildStamp.commit).toBe('unknown');
    expect(buildStamp.profile).toBe('unbundled');
    expect(() => formatBuildLabel()).not.toThrow();
  });
});
