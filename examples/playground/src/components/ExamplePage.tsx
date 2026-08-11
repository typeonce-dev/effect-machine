import type { ReactNode } from "react"

export function ExamplePage({
  title,
  summary,
  machineFile,
  children
}: {
  readonly title: string
  readonly summary: string
  readonly machineFile: string
  readonly children: ReactNode
}) {
  return (
    <section className="example-page">
      <header className="example-header">
        <p className="eyebrow">Interactive example</p>
        <h1>{title}</h1>
        <p className="lede">{summary}</p>
        <code className="file-pill">{machineFile}</code>
      </header>
      <div className="workbench">{children}</div>
    </section>
  )
}
