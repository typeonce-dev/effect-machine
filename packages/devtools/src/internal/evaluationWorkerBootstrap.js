import { workerData } from "node:worker_threads"
import { createServer } from "vite"

const server = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: {
    hmr: false,
    middlewareMode: true
  },
  optimizeDeps: {
    noDiscovery: true
  }
})

try {
  const runtime = await server.ssrLoadModule(workerData.runtimeModuleUrl)
  await runtime.run(server)
} finally {
  await server.close()
}
