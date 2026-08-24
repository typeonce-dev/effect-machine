import { spawn, spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dirname, "..")
const destination = await mkdtemp(join(tmpdir(), "effect-machine-devtools-pack-"))
const consumer = join(destination, "consumer")
const machineFile = join(consumer, "src", "machine.ts")
let child
const childOutput = []

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options
  })
  if (result.status !== 0) {
    throw new Error(
      [`${command} ${args.join(" ")} failed`, result.stdout?.trim(), result.stderr?.trim()]
        .filter(Boolean)
        .join("\n")
    )
  }
  return result
}

const pack = (directory) => {
  const result = run("pnpm", ["pack", "--pack-destination", destination], { cwd: directory })
  const archive = result.stdout.trim().split("\n").at(-1)
  if (archive === undefined) throw new Error(`pnpm pack did not return an archive for ${directory}`)
  return archive
}

const availablePort = () =>
  new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a local test port")))
        return
      }
      server.close((cause) => cause === undefined ? resolvePort(address.port) : reject(cause))
    })
  })

const waitFor = async (description, check, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value !== undefined) return value
    } catch (cause) {
      lastError = cause
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(`Timed out waiting for ${description}${lastError === undefined ? "" : `: ${String(lastError)}`}`)
}

const waitForExit = (process, timeout = 10_000) =>
  new Promise((resolveExit, reject) => {
    let timer
    const done = (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    }
    process.once("exit", done)
    timer = setTimeout(() => {
      process.off("exit", done)
      reject(new Error("The installed devtools process did not stop after SIGINT"))
    }, timeout)
  })

const readyMachine = `import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}

const states = Machine.states({ Idle })

export const machine = Machine.make({
  id: "packed-fixture",
  states: states.states,
  events: Machine.events(),
  initial: (to) => to.Idle().resolve(({ target }) => target.decoded(new Idle()))
}).handle({})
`

try {
  const coreArchive = pack(join(repositoryRoot, "packages", "effect-machine"))
  const devtoolsArchive = pack(join(repositoryRoot, "packages", "devtools"))
  const corePackage = JSON.parse(await readFile(join(repositoryRoot, "packages", "effect-machine", "package.json")))
  const devtoolsPackage = JSON.parse(await readFile(join(repositoryRoot, "packages", "devtools", "package.json")))

  await mkdir(join(consumer, "src"), { recursive: true })
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "@typeonce/effect-machine": `file:${coreArchive}`,
      "@typeonce/effect-machine-devtools": `file:${devtoolsArchive}`,
      effect: devtoolsPackage.peerDependencies.effect
    }
  }, null, 2))
  await writeFile(
    join(consumer, "pnpm-workspace.yaml"),
    `packages:\n  - .\noverrides:\n  "@typeonce/effect-machine": "file:${coreArchive}"\n`
  )
  await writeFile(machineFile, readyMachine)

  run("pnpm", ["install", "--prefer-offline", "--ignore-scripts"], { cwd: consumer })

  const binary = join(consumer, "node_modules", ".bin", "effect-machine")
  const version = run(binary, ["--version"], { cwd: consumer })
  if (!version.stdout.includes(devtoolsPackage.version)) {
    throw new Error(`installed CLI reported the wrong version: ${version.stdout.trim()}`)
  }
  if (corePackage.version !== devtoolsPackage.version) {
    throw new Error(`packed package versions differ: core ${corePackage.version}, devtools ${devtoolsPackage.version}`)
  }
  const help = run(binary, ["--help"], { cwd: consumer })
  if (!help.stdout.includes("--watch-polling")) {
    throw new Error("installed CLI help does not document the polling fallback")
  }

  run(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import("@typeonce/effect-machine-devtools");
     await import("@typeonce/effect-machine-devtools/DevToolsProtocol");
     await import("@typeonce/effect-machine-devtools/MachineDocument");
     await import("@typeonce/effect-machine-devtools/MachineSimulator");`
  ], { cwd: consumer })
  const privateImport = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `await import("@typeonce/effect-machine-devtools/ProjectInspector")`
  ], { cwd: consumer, encoding: "utf8" })
  if (privateImport.status === 0 || !privateImport.stderr.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")) {
    throw new Error("ProjectInspector is unexpectedly importable from the packed package")
  }

  const port = await availablePort()
  child = spawn(binary, ["--root", consumer, "--host", "127.0.0.1", "--port", String(port)], {
    cwd: consumer,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  })
  child.stdout.on("data", (chunk) => childOutput.push(String(chunk)))
  child.stderr.on("data", (chunk) => childOutput.push(String(chunk)))

  const endpoint = `http://127.0.0.1:${port}`
  const initial = await waitFor("the installed machine registry", async () => {
    const response = await fetch(`${endpoint}/api/machines`)
    if (!response.ok) return undefined
    const snapshot = await response.json()
    const result = snapshot.results?.[0]
    return result?._tag === "Ready" && result.document?.machineId === "packed-fixture" ? snapshot : undefined
  })
  const page = await fetch(endpoint)
  if (!page.ok || !(await page.text()).includes("Effect Machine · Text visualizer")) {
    throw new Error("The installed package did not serve the browser application")
  }

  await writeFile(machineFile, "export const building = {")
  const partial = await waitFor("a partial result after an incomplete edit", async () => {
    const snapshot = await fetch(`${endpoint}/api/machines`).then((response) => response.json())
    const result = snapshot.results?.[0]
    return snapshot.revision > initial.revision &&
        result?._tag === "Partial" &&
        result.document?.machineId === "packed-fixture"
      ? snapshot
      : undefined
  })

  await writeFile(machineFile, readyMachine)
  await waitFor("recovery after a valid edit", async () => {
    const snapshot = await fetch(`${endpoint}/api/machines`).then((response) => response.json())
    const result = snapshot.results?.[0]
    return snapshot.revision > partial.revision &&
        result?._tag === "Ready" &&
        result.document?.machineId === "packed-fixture"
      ? snapshot
      : undefined
  })

  child.kill("SIGINT")
  await waitForExit(child)
  child = undefined

  const occupiedPort = await availablePort()
  const occupied = createServer()
  await new Promise((resolveListen, reject) => {
    occupied.once("error", reject)
    occupied.listen(occupiedPort, "127.0.0.1", resolveListen)
  })
  try {
    const collision = spawnSync(
      binary,
      ["--root", consumer, "--host", "127.0.0.1", "--port", String(occupiedPort)],
      { cwd: consumer, encoding: "utf8", timeout: 15_000 }
    )
    const collisionOutput = `${collision.stdout ?? ""}\n${collision.stderr ?? ""}`
    if (collision.status === 0 || !collisionOutput.includes("Could not start the Effect Machine visualizer")) {
      throw new Error(`installed CLI did not report an occupied port\n${collisionOutput.trim()}`)
    }
  } finally {
    await new Promise((resolveClose, reject) =>
      occupied.close((cause) => cause === undefined ? resolveClose() : reject(cause))
    )
  }

  console.log("installed devtools CLI, worker, browser, live reload, shutdown, and failure handling passed")
} catch (cause) {
  if (child !== undefined) {
    child.kill("SIGKILL")
  }
  const logs = childOutput.join("").trim()
  throw new Error(`${cause instanceof Error ? cause.message : String(cause)}${logs === "" ? "" : `\n${logs}`}`, {
    cause
  })
} finally {
  await rm(destination, { recursive: true, force: true })
}
