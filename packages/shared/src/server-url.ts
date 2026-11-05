/** The native server address is an origin, not a route or a credential container. */
export function normalizeServerUrl(value: string, allowDevelopmentHttp = false): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Enter a complete server address, for example https://medimart.local:3001.');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Use only the server origin; omit credentials, paths, queries, and fragments.');
  }
  if (url.protocol !== 'https:') {
    const host = url.hostname;
    const privateHost =
      /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        host,
      ) ||
      host.endsWith('.local') ||
      /^\[(::1|f[cd][a-f\d:]+)\]$/i.test(host);
    if (!(allowDevelopmentHttp && url.protocol === 'http:' && privateHost)) {
      throw new Error(
        'HTTPS is required. HTTP on a private LAN is permitted only in an explicit development build.',
      );
    }
  }
  return url.origin;
}
