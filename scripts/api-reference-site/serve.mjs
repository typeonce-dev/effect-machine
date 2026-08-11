import { createReadStream, statSync } from "node:fs"
import { createServer } from "node:http"
import { extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const repositoryDirectory = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const root = resolve(repositoryDirectory, ".data/api-reference-site/v4")
const argument = process.argv.find((value) => value.startsWith("--port="))
const port = Number(argument?.slice("--port=".length) ?? "4173")

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid preview port: ${port}`)
if (statSync(join(root, "index.html"), { throwIfNoEntry: false })?.isFile() !== true) {
  throw new Error("Build the API reference site before starting its preview server")
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"]
])

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost")
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    response.writeHead(400).end("Bad request")
    return
  }
  const requested = resolve(root, `.${pathname}`)
  const relativePath = relative(root, requested)
  if (relativePath.startsWith("..") || relativePath === "") {
    serveFile(join(root, "index.html"), response)
    return
  }
  const status = statSync(requested, { throwIfNoEntry: false })
  const file = status?.isDirectory() === true ? join(requested, "index.html") : requested
  if (statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found")
    return
  }
  serveFile(file, response)
})

const serveFile = (path, response) => {
  response.writeHead(200, {
    "cache-control": "no-cache",
    "content-type": contentTypes.get(extname(path)) ?? "application/octet-stream"
  })
  createReadStream(path).pipe(response)
}

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`API reference preview: http://127.0.0.1:${port}/\n`)
})
