import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/support/cloudflare-workers.ts', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Several fork and startup tests take 4–6 s on a 2–4 core machine.
    testTimeout: 20_000,
    // The tests are CPU-bound and the main process stays idle, so CI uses every core:
    // Vitest's default (CPUs − 1) runs one file at a time on a 2-core runner. Local
    // runs keep the default; a worker needs about 0.5 GB.
    ...(process.env.CI === 'true' ? { maxWorkers: availableParallelism() } : {}),
  },
})
