import type * as DevToolsProtocol from "../DevToolsProtocol.js"

const reportOf = (result: DevToolsProtocol.Checked): {
  readonly ok: boolean
  readonly text: string
} => result.report as never

const failureText = (result: DevToolsProtocol.Failed): string =>
  [
    `FAIL ${result.key}`,
    ...result.diagnostics.map((diagnostic) => `  error ${diagnostic.code}: ${diagnostic.message}`)
  ].join("\n")

/** A project with nothing to check fails too, so a wrong path is not reported as a pass. */
export const isOk = (results: ReadonlyArray<DevToolsProtocol.CheckResult>): boolean =>
  results.length > 0 && results.every((result) => result._tag === "Checked" && reportOf(result).ok)

export const renderJson = (results: ReadonlyArray<DevToolsProtocol.CheckResult>): string =>
  JSON.stringify(
    {
      schemaVersion: 1,
      ok: isOk(results),
      machines: results.map((result) => {
        if (result._tag !== "Checked") {
          return { key: result.key, source: result.source, ok: false, diagnostics: result.diagnostics }
        }
        const { text: _text, ...report } = result.report as Record<string, unknown>
        return { key: result.key, source: result.source, ...report }
      })
    },
    null,
    2
  )

export const renderText = (results: ReadonlyArray<DevToolsProtocol.CheckResult>): string =>
  results.length === 0
    ? "No Effect Machine definitions found"
    : results.map((result) => result._tag === "Checked" ? reportOf(result).text : failureText(result)).join("\n")
