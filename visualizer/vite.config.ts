import { defineConfig } from "vite"

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
})
