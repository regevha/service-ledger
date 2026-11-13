// The one place the Playwright suites get their sign-in from. Nothing else in frontend/tests or the
// playwright*.config.ts files builds credentials, so when real per-user sign-in arrives (Phase 4) this is
// the only file the suites need to learn it from.
//
// E2E_AUTH picks how the suites authenticate:
//   none        (default) as today: the built and smoke suites send the shared password they already
//               run behind, the others send nothing.
//   shared      the same, but a suite with no shared password to send is an error, not a silent skip.
//               The default suite and the live suite cannot use it: they serve the page and the API on
//               two ports, and the shared password's browser prompt does not work across origins.
//   entra-test  per-user sign-in with a test token. Not available until the Entra sign-in is built.

export type E2EAuthMode = 'none' | 'shared' | 'entra-test';

export function authMode(): E2EAuthMode {
  const value = process.env.E2E_AUTH ?? 'none';
  if (value === 'none' || value === 'shared' || value === 'entra-test') return value;
  throw new Error(`E2E_AUTH must be none, shared or entra-test, not "${value}".`);
}

/** HTTP Basic credentials as Playwright's `httpCredentials` takes them: sent on every request, not only after a 401. */
export function basicCredentials(password: string, username = 'tester') {
  return { username, password, send: 'always' as const };
}

/**
 * The `use` options (credentials) for a suite. `sharedPassword` is the password the suite's backend
 * runs behind, if any; a suite whose backend has no password passes nothing.
 */
export function suiteAuth(sharedPassword?: string, username = 'tester') {
  const mode = authMode();
  if (mode === 'entra-test') {
    throw new Error('E2E_AUTH=entra-test is not available yet: it needs the Entra sign-in (Phase 4, SL-39), which has not been built.');
  }
  if (mode === 'shared' && !sharedPassword) {
    throw new Error(
      'E2E_AUTH=shared needs a suite that runs behind the shared password (the built-page and smoke suites). ' +
        'The default and live suites serve the page and the API on two ports, which the password prompt cannot span.'
    );
  }
  return sharedPassword ? { httpCredentials: basicCredentials(sharedPassword, username) } : {};
}

/** Context options for a request that must arrive with no credentials at all (a stranger). */
export const noCredentials = { httpCredentials: undefined };

/** Context options for the given credentials, for the specs that check a wrong password or another user name. */
export function asUser(password: string, username = 'tester') {
  return { httpCredentials: basicCredentials(password, username) };
}
