// Adapted from Effect-TS/website packages/api-reference/src/generate.mjs.
// Local differences: single-package configuration, explicit module mapping,
// repository metadata from package.json, and dataset validation for CI.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { Application } from "typedoc"
import { attachLeadingModuleComment } from "./module-comment.mjs"
import { normalizeApiModule, validateApiDocumentation } from "./normalize.mjs"

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = resolve(scriptDirectory, "../..")
const outputMarker = ".effect-api-reference"

export const generateApiReference = async ({ check = false } = {}) => {
  const config = readConfig(join(repositoryDirectory, "api-reference.config.json"))
  const configuredOutput = resolve(repositoryDirectory, config.output)
  const temporaryDirectory = check ? mkdtempSync(join(tmpdir(), "effect-machine-api-reference-")) : undefined
  const outputDirectory = temporaryDirectory === undefined
    ? configuredOutput
    : join(temporaryDirectory, config.channel)

  try {
    await generateDataset(config, outputDirectory)
    validateDataset(outputDirectory)
    process.stdout.write(
      check
        ? `Validated API reference dataset (${config.modules.length} modules)\n`
        : `Generated API reference dataset in ${relative(repositoryDirectory, outputDirectory)}\n`
    )
  } finally {
    if (temporaryDirectory !== undefined) rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

const generateDataset = async (config, outputDirectory) => {
  assertSafeOutputDirectory(outputDirectory)
  prepareOutputDirectory(outputDirectory)

  const packageDirectory = resolve(repositoryDirectory, config.packageDirectory ?? ".")
  const packageManifestPath = join(packageDirectory, "package.json")
  const packageManifest = readJson(packageManifestPath)
  const tsconfig = resolve(repositoryDirectory, config.tsconfig)
  accessSync(tsconfig, constants.R_OK)

  const barrels = config.barrels.map((barrel) => resolveEntry(packageDirectory, barrel))
  const barrelExports = new Set(barrels.map((barrel) => barrel.export))
  const modules = config.modules.map((module) => {
    if (module.barrel !== undefined && !barrelExports.has(module.barrel)) {
      throw new Error(`Module ${module.export} references unknown barrel ${module.barrel}`)
    }
    return resolveEntry(packageDirectory, module)
  })
  validateUniqueOutputPaths(modules)

  const revision = readRevision(repositoryDirectory)
  const application = await Application.bootstrap({
    name: packageManifest.name,
    entryPoints: modules.map(({ source }) => source),
    entryPointStrategy: "resolve",
    tsconfig,
    basePath: repositoryDirectory,
    displayBasePath: repositoryDirectory,
    alwaysCreateEntryPointModule: true,
    excludeInternal: true,
    excludePrivate: true,
    excludeProtected: true,
    skipErrorChecking: true,
    gitRevision: revision,
    readme: "none",
    pretty: false,
    validation: {
      invalidLink: false,
      notDocumented: false,
      notExported: false
    }
  })
  const entryPoints = application.getEntryPoints()
  if (entryPoints === undefined) throw new Error("TypeDoc could not resolve the configured entry points")
  await application.initializeRepositories(entryPoints)

  const entryPointsBySource = new Map(
    entryPoints.map((entryPoint) => [resolve(entryPoint.sourceFile.fileName), entryPoint])
  )
  const packageOutputDirectory = packageOutputPath(outputDirectory, packageManifest.name)
  const generatedModules = []

  for (const module of modules) {
    const entryPoint = entryPointsBySource.get(module.source)
    if (entryPoint === undefined) throw new Error(`TypeDoc did not create an entry point for ${module.source}`)

    entryPoint.displayName = module.export === "."
      ? packageManifest.name
      : `${packageManifest.name}/${module.export.replace(/^\.\//, "")}`
    const project = application.converter.convert([entryPoint])
    attachLeadingModuleComment(application, project, module.source)
    application.validate(project)

    const jsonPath = join(packageOutputDirectory, `${module.outputPath}.json`)
    mkdirSync(dirname(jsonPath), { recursive: true })
    await application.generateJson(project, jsonPath)

    const reflection = readJson(jsonPath)
    const normalized = normalizeApiModule(reflection)
    validateApiDocumentation(module.export, normalized, module.examples)
    if (
      normalized.name.length === 0 ||
      normalized.description === undefined ||
      normalized.declarationCount === 0
    ) {
      throw new Error(`Generated module is missing normalized documentation: ${module.export}`)
    }

    generatedModules.push({
      export: module.export,
      source: relativePosix(packageDirectory, module.source),
      json: relativePosix(packageOutputDirectory, jsonPath),
      sha256: hashFile(jsonPath),
      ...(module.barrel === undefined ? {} : { barrel: module.barrel })
    })
  }

  const repositoryUrl = repositoryHomepage(packageManifest.repository)
  const packageSourcePath = relativePosix(repositoryDirectory, packageDirectory)
  const packageSourceUrl = `${repositoryUrl}/tree/${revision}${packageSourcePath === "" ? "" : `/${packageSourcePath}`}`
  const packageManifestOutput = join(packageOutputDirectory, "manifest.json")
  writeJson(packageManifestOutput, {
    schemaVersion: 4,
    channel: config.channel,
    name: packageManifest.name,
    version: packageManifest.version,
    revision,
    description: packageManifest.description ?? packageManifest.name,
    npmUrl: `https://www.npmjs.com/package/${packageManifest.name}`,
    repositoryUrl,
    sourceUrl: packageSourceUrl,
    barrels: barrels.map((barrel) => ({
      export: barrel.export,
      source: relativePosix(packageDirectory, barrel.source)
    })),
    modules: generatedModules
  })

  writeJson(join(outputDirectory, "manifest.json"), {
    datasetSchemaVersion: 1,
    channel: config.channel,
    typedocVersion: Application.VERSION,
    typedocSchemaVersion: "2.0",
    revision,
    packages: [{
      name: packageManifest.name,
      version: packageManifest.version,
      manifest: relativePosix(outputDirectory, packageManifestOutput)
    }]
  })
}

export const validateDataset = (outputDirectory) => {
  const dataset = readJson(join(outputDirectory, "manifest.json"))
  if (dataset.datasetSchemaVersion !== 1 || dataset.typedocSchemaVersion !== "2.0") {
    throw new Error("Unsupported API reference dataset schema")
  }
  for (const packageEntry of dataset.packages) {
    const packageManifestPath = safeResolve(outputDirectory, packageEntry.manifest)
    const packageManifest = readJson(packageManifestPath)
    if (
      packageManifest.schemaVersion !== 4 ||
      packageManifest.channel !== dataset.channel ||
      packageManifest.revision !== dataset.revision ||
      packageManifest.name !== packageEntry.name ||
      packageManifest.version !== packageEntry.version ||
      typeof packageManifest.repositoryUrl !== "string"
    ) {
      throw new Error(`Package manifest does not match dataset entry: ${packageManifestPath}`)
    }
    const packageDirectory = dirname(packageManifestPath)
    for (const module of packageManifest.modules) {
      const reflectionPath = safeResolve(packageDirectory, module.json)
      if (hashFile(reflectionPath) !== module.sha256) {
        throw new Error(`Reflection checksum mismatch: ${reflectionPath}`)
      }
      const reflection = readJson(reflectionPath)
      if (reflection.schemaVersion !== "2.0" || reflection.variant !== "project") {
        throw new Error(`Invalid TypeDoc reflection: ${reflectionPath}`)
      }
      validateApiDocumentation(module.export, normalizeApiModule(reflection))
    }
  }
  return dataset
}

const readConfig = (path) => {
  const config = readJson(path)
  if (!/^v\d+$/.test(config.channel)) throw new Error("API reference channel must look like v4")
  if (typeof config.output !== "string" || typeof config.tsconfig !== "string") {
    throw new Error("API reference output and tsconfig must be configured")
  }
  if (!Array.isArray(config.barrels) || !Array.isArray(config.modules) || config.modules.length === 0) {
    throw new Error("API reference barrels and at least one module must be configured")
  }
  if (config.modules.some((module) => module.examples !== undefined && !Array.isArray(module.examples))) {
    throw new Error("API reference module examples must be an array")
  }
  return config
}

const resolveEntry = (packageDirectory, entry) => {
  const source = resolve(packageDirectory, entry.source)
  accessSync(source, constants.R_OK)
  return {
    ...entry,
    source,
    outputPath: exportPathToOutputPath(entry.export),
    examples: entry.examples ?? []
  }
}

const validateUniqueOutputPaths = (modules) => {
  const paths = new Map()
  for (const module of modules) {
    const existing = paths.get(module.outputPath)
    if (existing !== undefined) {
      throw new Error(`${module.export} and ${existing} both map to ${module.outputPath}.json`)
    }
    paths.set(module.outputPath, module.export)
  }
}

const exportPathToOutputPath = (exportPath) => {
  const outputPath = exportPath === "." ? "index" : exportPath.replace(/^\.\//, "")
  if (
    outputPath.length === 0 ||
    outputPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Cannot derive a safe output path from ${JSON.stringify(exportPath)}`)
  }
  return outputPath
}

const assertSafeOutputDirectory = (path) => {
  if (!isAbsolute(path) || path === resolve(path, sep) || path === repositoryDirectory) {
    throw new Error(`Refusing to replace unsafe output directory: ${path}`)
  }
}

const prepareOutputDirectory = (path) => {
  const status = statSync(path, { throwIfNoEntry: false })
  if (status !== undefined) {
    if (!status.isDirectory()) throw new Error(`Output path is not a directory: ${path}`)
    if (!isFile(join(path, outputMarker)) && readdirSync(path).length > 0) {
      throw new Error(`Refusing to replace an output directory not created by this generator: ${path}`)
    }
    rmSync(path, { recursive: true })
  }
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, outputMarker), "")
}

const packageOutputPath = (outputDirectory, packageName) => {
  const parts = packageName.split("/")
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Cannot derive a safe output path from package name ${JSON.stringify(packageName)}`)
  }
  return join(outputDirectory, ...parts)
}

const repositoryHomepage = (repository) => {
  const raw = typeof repository === "string" ? repository : repository?.url
  if (typeof raw !== "string") throw new Error("package.json repository URL is required")
  const https = raw
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
  if (!URL.canParse(https)) throw new Error(`Unsupported repository URL: ${raw}`)
  return https.replace(/\/$/, "")
}

const readRevision = (directory) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim()

const safeResolve = (base, path) => {
  const resolvedBase = resolve(base)
  const resolvedPath = resolve(resolvedBase, path)
  const relativePath = relative(resolvedBase, resolvedPath)
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`API reference path escapes its dataset: ${path}`)
  }
  return resolvedPath
}

const relativePosix = (base, path) => relative(base, path).split(sep).join("/")
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"))
const hashFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
const isFile = (path) => statSync(path, { throwIfNoEntry: false })?.isFile() === true

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  generateApiReference({ check: process.argv.includes("--check") }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
