import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import istanbul from 'vite-plugin-istanbul'

// https://vite.dev/config/
//
// Coverage (npm run test:e2e:coverage): with COVERAGE=1 the source is
// instrumented with Istanbul so the Playwright suite can read
// window.__coverage__ from each page (see tests/e2e/coverage.ts). Off by
// default — instrumented code is slower and bigger, so normal dev and e2e
// runs never see it.
const coverage = process.env.COVERAGE === '1'

export default defineConfig({
  plugins: [
    react(),
    ...(coverage
      ? [istanbul({ include: 'src/*', exclude: ['node_modules', 'src/generated/*'], extension: ['.ts', '.tsx'], requireEnv: false, forceBuildInstrument: false })]
      : []),
  ],
})
