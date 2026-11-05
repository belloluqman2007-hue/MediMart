import type { Database } from '@medimart/database';
export interface Runtime {
  native: boolean;
  deviceId: string | null;
  database: Database | null;
  serverUrl: string;
  getToken(): Promise<string | null>;
  saveToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  setServerUrl(url: string): Promise<void>;
  deviceProof(create?: boolean): Promise<{ id: string; secret: string } | null>;
  recordPairingStatus(status: 'pending' | 'approved' | 'revoked'): Promise<void>;
}
