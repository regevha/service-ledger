import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import istanbul from 'vite-plugin-istanbul'

// https://vite.dev/config/
//
// Coverage (npm run test:e2e:coverage): with COVERAGE=1 the source is
// instrumented with Istanbul so the Playwright suite can read
// window.__coverage__ from each page (see tests/e2e/coverage.ts). Off by
// default — instrumented code is slower and bigger, so normal dev and e2e
// runs never see it.
const coverage = process.env.COVERAGE === '1'

// Same-origin API for local use (README, "Running through one port"): with VITE_API_BASE_URL set to
// the empty string, the app asks for /reports, /analytics/... on the dev server's own port and Vite
// forwards everything that is not a Vite or asset request to API_PROXY_TARGET. For a browser that can
// reach only the dev server's port (a browser pane, a forwarded port). Off in every other case, so
// plain `npm run dev`, Vitest and Playwright behave as before.
const sameOriginApi = process.env.VITE_API_BASE_URL === ''
const viteOwn = /^\/($|@|src\/|node_modules\/|assets\/|__|index\.html)|\.(ts|tsx|css|svg|ico|png|js|map)(\?|$)/

export default defineConfig({
  plugins: [
    react(),
    ...(coverage
      ? [istanbul({ include: 'src/*', exclude: ['node_modules', 'src/generated/*', 'src/**/*.test.ts'], extension: ['.ts', '.tsx'], requireEnv: false, forceBuildInstrument: false })]
      : []),
  ],
  server: sameOriginApi
    ? {
        proxy: {
          '/': {
            target: process.env.API_PROXY_TARGET ?? 'http://localhost:8000',
            changeOrigin: true,
            bypass: (req) => (viteOwn.test(req.url ?? '') ? req.url : undefined),
          },
        },
      }
    : undefined,
  // Unit tests (npm test) for pure modules under src/. Playwright's testDirs all
  // live under tests/, so the two runners never see each other's files.
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
