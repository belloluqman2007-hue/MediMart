import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  sourcemap: true,
  noExternal: ['@medimart/shared', '@medimart/database'],
  // Native addons must resolve their own package-relative binary and CommonJS loader.
  // better-sqlite3 belongs to the database workspace, so it is not auto-externalized here.
  external: ['better-sqlite3', 'argon2'],
});
