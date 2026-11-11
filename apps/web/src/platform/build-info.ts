/**
 * Identity of the running build.
 *
 * `apps/web/vite.config.ts` compiles `__MEDIMART_BUILD__` into every bundle. On the phone this is
 * the only way to answer "which MediMart is installed?" without a computer: the label is shown on
 * the start-up failure screen and written to logcat at launch, next to the diagnostic code.
 *
 * Nothing here is secret — a version, a public commit hash, a timestamp and the build profile.
 */
export type BuildStamp = {
  version: string;
  commit: string;
  /** ISO-8601, UTC. */
  builtAt: string;
  /** The Vite mode the bundle was built in, e.g. `production` or `native-development`. */
  profile: string;
};

/** Replaced at build time. Absent in unit tests and in a bare `tsc` run, hence the `typeof` guard. */
declare const __MEDIMART_BUILD__: BuildStamp | undefined;

const injected: BuildStamp | undefined =
  typeof __MEDIMART_BUILD__ === 'undefined' ? undefined : __MEDIMART_BUILD__;

/**
 * The stamp for this bundle.
 *
 * The fallback keeps un-bundled contexts (vitest, a dev import of this module) honest instead of
 * throwing: `commit: 'unknown'` is displayed as-is, and never pretends to be a real build.
 */
export const buildStamp: BuildStamp = injected ?? {
  version: '0.0.0',
  commit: 'unknown',
  builtAt: '',
  profile: 'unbundled',
};

/**
 * One line for a human: `0.3.0 · a1b2c3d4 · 2026-11-11 · production`.
 *
 * Parts that are missing are dropped rather than printed as placeholders, so a screenshot of the
 * failure screen is never ambiguous about what was and was not known at build time.
 */
export function formatBuildLabel(stamp: BuildStamp = buildStamp): string {
  return [
    stamp.version || null,
    stamp.commit && stamp.commit !== 'unknown' ? stamp.commit : null,
    stamp.builtAt ? stamp.builtAt.slice(0, 10) : null,
    stamp.profile && stamp.profile !== 'unbundled' ? stamp.profile : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}
