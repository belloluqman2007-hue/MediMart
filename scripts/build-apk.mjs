/**
 * Build the Android APK from the existing Capacitor project.
 *
 * Two profiles:
 *   --profile debug  (default)  a debug APK for controlled shop testing. It may talk to the
 *                               central computer over plain HTTP on a private Wi-Fi network,
 *                               because a shop without internet cannot obtain a certificate.
 *   --profile release           a release APK. TLS-only networking. Signing material is read from
 *                               environment variables and never written into the repository.
 *
 * Requirements: JDK 21, an Android SDK with platform 36 and build-tools 36.0.0, and Gradle access.
 * The script refuses to pretend it built something: if the toolchain is absent it says so and exits
 * non-zero after printing exactly what is missing.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : 'debug';
if (!['debug', 'release'].includes(profile)) {
  console.error('Unknown profile. Use --profile debug or --profile release.');
  process.exit(2);
}
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

function require(command, hint) {
  const probe = spawnSync(isWindows ? 'where' : 'which', [command], { encoding: 'utf8' });
  if (probe.status !== 0) {
    console.error(`Missing tool: ${command}. ${hint}`);
    return false;
  }
  return true;
}

const androidHome =
  process.env.ANDROID_HOME ||
  process.env.ANDROID_SDK_ROOT ||
  join(process.env.HOME ?? '', 'Android/Sdk');
process.env.ANDROID_HOME ??= androidHome;
process.env.ANDROID_SDK_ROOT ??= androidHome;

let ok = true;
ok = require('java', 'Install JDK 21 and set JAVA_HOME.') && ok;
if (!existsSync(androidHome)) {
  console.error(
    `Missing Android SDK at ${androidHome}. Install platform 36 and build-tools 36.0.0, then set ANDROID_HOME.`,
  );
  ok = false;
}
if (!ok) {
  console.error(
    '\nNo APK was built. This is a toolchain problem, not a code problem: the checked-in Capacitor project is complete.\n' +
      'The manual GitHub workflow `.github/workflows/android.yml` builds the same debug APK on a machine with the SDK.',
  );
  process.exit(1);
}

const gradle = isWindows ? 'gradlew.bat' : './gradlew';
console.log(`1/4 Building web assets for the ${profile} profile…`);
execFileSync(npm, ['run', profile === 'debug' ? 'android:sync:dev' : 'android:sync'], {
  cwd: root,
  stdio: 'inherit',
});

console.log('2/4 Running Gradle…');
const tasks = profile === 'debug' ? ['assembleDebug'] : ['assembleRelease'];
execFileSync(gradle, ['--no-daemon', ...tasks], {
  cwd: join(root, 'apps', 'web', 'android'),
  stdio: 'inherit',
  env: process.env,
});

const output = join(
  root,
  'apps',
  'web',
  'android',
  'app',
  'build',
  'outputs',
  'apk',
  profile,
  `app-${profile}.apk`,
);
if (!existsSync(output)) {
  console.error(`Gradle reported success but ${output} is missing. No APK is claimed.`);
  process.exit(1);
}

console.log('3/4 Verifying the package identifier…');
const aapt2 = join(androidHome, 'build-tools', '36.0.0', isWindows ? 'aapt2.exe' : 'aapt2');
let applicationId = 'unknown';
if (existsSync(aapt2)) {
  try {
    const dump = execFileSync(aapt2, ['dump', 'badging', output], { encoding: 'utf8' });
    applicationId = /package: name='([^']+)'/.exec(dump)?.[1] ?? 'unknown';
  } catch {
    applicationId = 'unknown';
  }
}
console.log(`    application id: ${applicationId}`);

console.log('4/4 Copying the APK to dist/android…');
const distDir = join(root, 'dist', 'android');
mkdirSync(distDir, { recursive: true });
const target = join(distDir, `medimart-${profile}.apk`);
copyFileSync(output, target);
const size = statSync(target).size;
console.log(`APK: ${target} (${(size / 1024 / 1024).toFixed(2)} MB)`);
if (applicationId !== 'com.medimart.app') {
  console.error('The application identifier is not com.medimart.app. Distribution is refused.');
  process.exit(1);
}
console.log('VERIFIED: application id com.medimart.app');
