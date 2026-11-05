import { createContext, useContext } from 'react';
import type { BootstrapStatus, SessionResponse, UserProfile } from '@medimart/shared';
import type { z } from 'zod';
import type { loginSchema, ownerRegistrationSchema } from '@medimart/shared';
import type { Runtime } from '../platform/types';
import type { ApiClient } from './api';
export type ConnectionStatus = 'checking' | 'online' | 'offline' | 'unconfigured';
export interface AppContextValue {
  runtime: Runtime;
  api: ApiClient;
  user: UserProfile | null;
  connection: ConnectionStatus;
  bootstrap: BootstrapStatus | null;
  session: SessionResponse | null;
  refresh(): Promise<void>;
  signIn(input: z.infer<typeof loginSchema>): Promise<void>;
  registerOwner(input: z.infer<typeof ownerRegistrationSchema>): Promise<void>;
  signOut(all?: boolean): Promise<void>;
  saveServer(url: string): Promise<void>;
  notify(message: string, tone?: 'success' | 'error' | 'info'): void;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('AppProvider is missing.');
  return context;
}
