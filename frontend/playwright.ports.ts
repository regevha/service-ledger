// The numbers the Playwright configs and the specs share. Kept apart from playwright.config.ts so that
// importing them does not load that whole config (and its sign-in setting, which differs per suite).

/** The backend the default suite boots. Specs build their direct API URLs from this one number. */
export const BACKEND_PORT = 8001;

/** The database the e2e suites own end to end: reset_db.py empties it before every run. */
export const E2E_DATABASE_URL = 'postgresql+psycopg2://service_ledger:service_ledger_dev@localhost:5432/service_ledger_e2e';
