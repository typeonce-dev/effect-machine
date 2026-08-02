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
        <p className="eyebrow">Machine starter</p>
        <h1>{title}</h1>
        <p className="lede">{summary}</p>
        <code className="file-pill">{machineFile}</code>
      </header>
      <div className="workbench">{children}</div>
    </section>
  )
}

export function StarterPanel({ children }: { readonly children: ReactNode }) {
  return (
    <div className="starter-panel">
      <p className="starter-label">Implementation area</p>
      {children}
    </div>
  )
}
