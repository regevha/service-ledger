import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { request as playwrightRequest } from '@playwright/test';
import { BACKEND_PORT } from '../../playwright.config';

// The accounts the e2e suite signs in with. The backend creates the admin on
// startup (INITIAL_ADMIN_* in the config's webServer command); this setup
// creates the other two through the admin API, then saves the admin's
// session as the default `storageState`, so every spec — its pages and its
// `request` fixture — is signed in as an admin unless it says otherwise.
export const ADMIN = { username: 'e2e-admin', password: 'e2e-admin-password' };
export const TECHNICIAN = { username: 'e2e-technician', password: 'e2e-technician-password' };
export const VIEWER = { username: 'e2e-viewer', password: 'e2e-viewer-password' };

export const ADMIN_STATE = path.join(process.cwd(), 'tests', 'e2e', '.auth', 'admin.json');
export const SIGNED_OUT_STATE = { cookies: [], origins: [] };

export const API = `http://localhost:${BACKEND_PORT}`;

export default async function globalSetup(): Promise<void> {
  const api = await playwrightRequest.newContext({ baseURL: API });
  const login = await api.post('/auth/login', { data: ADMIN });
  if (!login.ok()) throw new Error(`Could not sign in as the e2e admin: ${login.status()} ${await login.text()}`);
  for (const [account, role] of [[TECHNICIAN, 'technician'], [VIEWER, 'viewer']] as const) {
    const created = await api.post('/users', { data: { ...account, role } });
    // 409: the user is already there (a re-run against a reused database).
    if (!created.ok() && created.status() !== 409) throw new Error(`Could not create ${account.username}: ${created.status()}`);
  }
  mkdirSync(path.dirname(ADMIN_STATE), { recursive: true });
  await api.storageState({ path: ADMIN_STATE });
  await api.dispose();
}
