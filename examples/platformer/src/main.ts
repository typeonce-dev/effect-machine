import "./styles.css"
import { Machine } from "@typeonce/effect-machine"
import { Effect, Fiber, Stream } from "effect"
import { GameAdapter } from "./game.ts"
import {
  activeStateData,
  airJumpMode,
  type CharacterEvent,
  CharacterMachine,
  type CharacterSnapshot,
  facingDirection,
  isPaused,
  locomotionBranch,
  locomotionMode,
  wallContact
} from "./machine.ts"

const requiredElement = <ElementType extends Element>(selector: string) => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`Missing element: ${selector}`)
  return element
}

const modeLabel = requiredElement<HTMLElement>("#active-mode")
const stateData = requiredElement<HTMLElement>("#state-data")
const lastEvent = requiredElement<HTMLElement>("#last-event")
const gameView = requiredElement<SVGSVGElement>("#game")

const showEvent = (event: CharacterEvent) => {
  const { _tag, ...payload } = event
  const detail = Object.keys(payload).length === 0 ? "" : ` ${JSON.stringify(payload)}`
  lastEvent.textContent = `${_tag}${detail}`
}

let deliver: ((event: CharacterEvent) => void) | undefined
const pending: Array<CharacterEvent> = []
const send = (event: CharacterEvent) => {
  showEvent(event)
  deliver === undefined ? pending.push(event) : deliver(event)
}

const game = new GameAdapter(
  send,
  requiredElement<SVGGElement>("#player"),
  requiredElement<SVGGElement>("#player-pose")
)

const publish = (next: CharacterSnapshot) => {
  game.setSnapshot(next)
  const mode = locomotionMode(next)
  const facing = facingDirection(next)
  const contact = wallContact(next)
  const airJump = airJumpMode(next)
  const paused = isPaused(next)
  modeLabel.textContent = [mode, airJump, contact, facing].filter(Boolean).join(" · ")
  stateData.textContent = JSON.stringify(activeStateData(next))
  gameView.classList.toggle("is-paused", paused)

  const active = new Set<string>([mode, facing, contact, locomotionBranch(next)])
  if (!paused) active.add("Playing")
  if (airJump !== undefined) active.add(airJump)
  document.querySelectorAll<HTMLElement>("[data-node]").forEach((node) => {
    node.classList.toggle("is-active", active.has(node.dataset.node ?? ""))
  })
}

const program = Effect.gen(function*() {
  const ref = yield* Machine.start(CharacterMachine)
  deliver = (event) => Effect.runFork(ref.send(event).pipe(Effect.catchTag("StoppedError", () => Effect.void)))
  publish(yield* ref.state)
  for (const event of pending.splice(0)) yield* ref.send(event)
  yield* Stream.runForEach(ref.changes, ({ state }) => Effect.sync(() => publish(state)))
})

const fiber = Effect.runFork(program)

let previous = performance.now()

const frame = (now: number) => {
  game.step((now - previous) / 1_000)
  previous = now
  requestAnimationFrame(frame)
}

requestAnimationFrame(frame)
window.addEventListener("beforeunload", () => {
  game.destroy()
  Effect.runFork(Fiber.interrupt(fiber))
})
