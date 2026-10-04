import { defineConfig } from 'vitest/config'

// Pure logic tests run on plain Node: everything under src that talks to the
// Cloudflare runtime lives in src/durable and is covered by the wrangler dev
// smoke test instead of being imported here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
})
