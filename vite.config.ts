import { defineConfig } from 'vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  plugins: [cloudflare({ configPath: './wrangler.jsonc' })],
  build: {
    minify: true,
  },
})
