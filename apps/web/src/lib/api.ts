import type { ApiErrorBody, SessionResponse } from '@medimart/shared';
import type { Runtime } from '../platform/types';
export class ApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 0,
    public readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}
export class ApiClient {
  private csrfToken: string | undefined;
  constructor(private readonly runtime: Runtime) {}
  setSession(session: SessionResponse | null) {
    this.csrfToken = session?.csrfToken;
  }
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    if (!path.startsWith('/api/')) throw new Error('API paths must be relative to /api/.');
    if (this.runtime.native && !this.runtime.serverUrl)
      throw new ApiClientError(
        'SERVER_NOT_CONFIGURED',
        'Add your central server address in Settings first.',
      );
    const baseUrl = this.runtime.serverUrl;
    const token = await this.runtime.getToken();
    if (baseUrl !== this.runtime.serverUrl)
      throw new ApiClientError('SERVER_CHANGED', 'The server configuration changed. Please retry.');
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.csrfToken && !this.runtime.native && method !== 'GET')
      headers['X-CSRF-Token'] = this.csrfToken;
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
        credentials: this.runtime.native ? 'omit' : 'same-origin',
        cache: 'no-store',
        signal: AbortSignal.timeout(7000),
        redirect: 'error',
      });
    } catch {
      throw new ApiClientError(
        'CONNECTION_FAILED',
        'The central server is unreachable. Check your local Wi-Fi and server address.',
      );
    }
    if (response.status === 204) return undefined as T;
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (payload as ApiErrorBody | null)?.error;
      throw new ApiClientError(
        error?.code ?? 'REQUEST_FAILED',
        error?.message ?? 'The server could not complete this request.',
        response.status,
        error?.fields,
      );
    }
    if (payload === null)
      throw new ApiClientError(
        'INVALID_RESPONSE',
        'This address is not responding as a MediMart server.',
      );
    return payload as T;
  }
}
export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.fields)
    return Object.values(error.fields).flat().join(' ');
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
