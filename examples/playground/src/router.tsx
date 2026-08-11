import { createRootRoute, createRoute, createRouter, Link, Outlet } from "@tanstack/react-router"
import { MediaPlayerPage } from "./examples/media-player/MediaPlayerPage.tsx"
import { MicrowavePage } from "./examples/microwave/MicrowavePage.tsx"
import { TrafficLightPage } from "./examples/traffic-light/TrafficLightPage.tsx"
import { TurnstilePage } from "./examples/turnstile/TurnstilePage.tsx"
import { WorkerTabsPage } from "./examples/worker-tabs/WorkerTabsPage.tsx"

const examples = [
  {
    to: "/turnstile" as const,
    title: "Turnstile",
    description: "A compact baseline for states, events, and legal transitions.",
    concepts: ["atomic states", "typed events"]
  },
  {
    to: "/traffic-light" as const,
    title: "Traffic light",
    description: "A timed cycle with state-scoped delays and repeated transitions.",
    concepts: ["timers", "entry and exit"]
  },
  {
    to: "/microwave" as const,
    title: "Microwave",
    description: "Door and engine behavior modeled as cooperating parallel regions.",
    concepts: ["parallel states", "conditions"]
  },
  {
    to: "/media-player" as const,
    title: "Media player",
    description: "Coordinate parallel transport and sound modes with state-scoped Effects.",
    concepts: ["parallel states", "compound states", "Effect services"]
  },
  {
    to: "/worker-tabs" as const,
    title: "Workers and tabs",
    description: "Host a machine off the main thread and synchronize browser tabs.",
    concepts: ["Web Worker", "BroadcastChannel"]
  }
]

const rootRoute = createRootRoute({
  component: RootLayout
})

function RootLayout() {
  return (
    <div className="app-shell">
      <header className="site-header">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Effect Machine
        </Link>
        <nav aria-label="Examples">
          {examples.map((example) => (
            <Link key={example.to} to={example.to} activeProps={{ className: "is-active" }}>
              {example.title}
            </Link>
          ))}
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomePage
})

function HomePage() {
  return (
    <section className="home-page">
      <header className="hero">
        <p className="eyebrow">Examples playground</p>
        <h1>Learn one machine at a time.</h1>
        <p className="lede">
          Each route is a complete, focused implementation of one state-machine pattern.
        </p>
      </header>
      <div className="example-grid">
        {examples.map((example, index) => (
          <Link key={example.to} to={example.to} className="example-card">
            <span className="card-index">{String(index + 1).padStart(2, "0")}</span>
            <h2>{example.title}</h2>
            <p>{example.description}</p>
            <ul>
              {example.concepts.map((concept) => <li key={concept}>{concept}</li>)}
            </ul>
            <span className="card-action">Open example →</span>
          </Link>
        ))}
      </div>
    </section>
  )
}

const turnstileRoute = createRoute({ getParentRoute: () => rootRoute, path: "/turnstile", component: TurnstilePage })
const trafficLightRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/traffic-light",
  component: TrafficLightPage
})
const microwaveRoute = createRoute({ getParentRoute: () => rootRoute, path: "/microwave", component: MicrowavePage })
const mediaPlayerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/media-player",
  component: MediaPlayerPage
})
const workerTabsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/worker-tabs",
  component: WorkerTabsPage
})

const routeTree = rootRoute.addChildren([
  homeRoute,
  turnstileRoute,
  trafficLightRoute,
  microwaveRoute,
  mediaPlayerRoute,
  workerTabsRoute
])

export const router = createRouter({ routeTree })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
