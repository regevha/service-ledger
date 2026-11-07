import { apiFetch } from './http';
import type { AppConfig } from './types';

// ---------- App config ----------

export function getAppConfig(): Promise<AppConfig> {
  return apiFetch('/config');
}
