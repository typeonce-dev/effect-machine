import type { Axis, CharacterEvent, CharacterSnapshot, LocomotionMode } from "./machine.ts"
import { airJumpMode, facingDirection, isPaused, locomotionState } from "./machine.ts"

const FLOOR = 324
const SIZE = 30

const pose = {
  Standing: "translate(0 0)",
  Running: "rotate(6 15 30)",
  Jumping: "rotate(-12 15 15)",
  Falling: "rotate(12 15 15)",
  Ducking: "translate(0 15) scale(1 .5)",
  Diving: "rotate(90 15 15) scale(.8 1.15)",
  Landing: "translate(-3 12) scale(1.2 .6)",
  Paused: "translate(0 0)"
} as const satisfies Record<LocomotionMode, string>

export class GameAdapter {
  private readonly position = { x: 84, y: FLOOR - SIZE, vy: 0 }
  private readonly held = new Set<string>()
  private snapshot: CharacterSnapshot | undefined
  private previousMode: LocomotionMode = "Standing"
  private lastJumpAt = -1
  private wallPushSpeed = 0
  private wallPushUntil = 0
  private reportedWall: Axis | undefined
  private grounded = true
  private apexReported = false

  constructor(
    private readonly send: (event: CharacterEvent) => void,
    private readonly player: SVGGElement,
    private readonly playerPose: SVGGElement
  ) {
    window.addEventListener("keydown", this.onKeyDown)
    window.addEventListener("keyup", this.onKeyUp)
  }

  setSnapshot(snapshot: CharacterSnapshot) {
    this.snapshot = snapshot
  }

  step(seconds: number) {
    if (this.snapshot === undefined) return
    const dt = Math.min(seconds, 1 / 30)
    const state = locomotionState(this.snapshot)

    if (state._tag === "Paused") {
      this.player.dataset.paused = "true"
      return
    }

    delete this.player.dataset.paused
    const mode = state._tag
    const p = this.position

    if (state._tag === "Jumping" && state.startedAt !== this.lastJumpAt) {
      p.vy = -430
      this.wallPushSpeed = state.push * 330
      this.wallPushUntil = state.push === 0 ? 0 : state.startedAt + 240
      this.grounded = false
      this.apexReported = false
      this.lastJumpAt = state.startedAt
    }
    if (mode === "Diving" && this.previousMode !== "Diving") p.vy = 610

    const inputSpeed = mode === "Ducking" || mode === "Landing" ? 0 : this.axis * (this.grounded ? 190 : 135)
    const speed = performance.now() < this.wallPushUntil ? this.wallPushSpeed : inputSpeed
    if (!this.grounded) p.vy += 1_180 * dt
    p.x = Math.max(0, Math.min(640 - SIZE, p.x + speed * dt))
    p.y += p.vy * dt

    if (this.jumpWall !== this.reportedWall) {
      this.reportedWall = this.jumpWall
      this.send({ _tag: "WallContact", wall: this.reportedWall })
    }

    if (!this.apexReported && p.vy >= 0 && mode === "Jumping") {
      this.apexReported = true
      this.send({ _tag: "ApexReached", y: Math.round(p.y) })
    }
    if (!this.grounded && p.y >= FLOOR - SIZE) {
      const impact = Math.round(p.vy)
      Object.assign(p, { y: FLOOR - SIZE, vy: 0 })
      this.grounded = true
      this.send({ _tag: "Landed", impact, axis: this.axis, at: performance.now() })
    }

    const x = facingDirection(this.snapshot) === "Left" ? p.x + SIZE : p.x
    const flip = facingDirection(this.snapshot) === "Left" ? " scale(-1 1)" : ""
    this.player.setAttribute("transform", `translate(${x.toFixed(1)} ${p.y.toFixed(1)})${flip}`)
    this.playerPose.setAttribute("transform", pose[mode])
    this.player.dataset.mode = mode
    this.player.dataset.airJump = airJumpMode(this.snapshot) === "AirJumpSpent" ? "spent" : "ready"
    if (state._tag === "Jumping") this.player.dataset.jumpKind = state.kind
    else delete this.player.dataset.jumpKind
    this.previousMode = mode
  }

  reset() {
    Object.assign(this.position, { x: 84, y: FLOOR - SIZE, vy: 0 })
    this.held.clear()
    this.grounded = true
    this.previousMode = "Standing"
    this.lastJumpAt = -1
    this.wallPushUntil = 0
    this.reportedWall = undefined
  }

  destroy() {
    window.removeEventListener("keydown", this.onKeyDown)
    window.removeEventListener("keyup", this.onKeyUp)
  }

  private get axis(): Axis {
    const left = this.held.has("KeyA") || this.held.has("ArrowLeft")
    const right = this.held.has("KeyD") || this.held.has("ArrowRight")
    return left === right ? 0 : left ? -1 : 1
  }

  private get wall(): Axis {
    return this.position.x <= 1 ? -1 : this.position.x >= 640 - SIZE - 1 ? 1 : 0
  }

  private get jumpWall(): Axis {
    return performance.now() < this.wallPushUntil ? 0 : this.wall
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.isGameKey(event.code)) return
    event.preventDefault()

    if (event.code === "KeyP") {
      if (event.repeat || this.snapshot === undefined) return
      this.send(isPaused(this.snapshot) ? { _tag: "Resume" } : { _tag: "Pause", at: performance.now() })
      return
    }

    if (this.snapshot !== undefined && isPaused(this.snapshot) && event.code !== "KeyR") return

    const previousAxis = this.axis
    this.held.add(event.code)
    if (previousAxis !== this.axis) this.send({ _tag: "Move", axis: this.axis, at: performance.now() })
    if (event.repeat) return

    if (event.code === "Space" || event.code === "KeyW" || event.code === "ArrowUp") {
      this.send({ _tag: "JumpPressed", at: performance.now(), y: this.position.y, wall: this.jumpWall })
    } else if (event.code === "KeyS" || event.code === "ArrowDown") {
      this.send({ _tag: "DownPressed", at: performance.now() })
    } else if (event.code === "KeyR") {
      this.reset()
      this.send({ _tag: "Reset" })
    }
  }

  private readonly onKeyUp = (event: KeyboardEvent) => {
    const previousAxis = this.axis
    this.held.delete(event.code)
    if (this.snapshot !== undefined && isPaused(this.snapshot)) return
    if (previousAxis !== this.axis) this.send({ _tag: "Move", axis: this.axis, at: performance.now() })
    if (event.code === "KeyS" || event.code === "ArrowDown") {
      this.send({ _tag: "DownReleased", axis: this.axis, at: performance.now() })
    }
  }

  private isGameKey(code: string) {
    return [
      "KeyA",
      "KeyD",
      "KeyW",
      "KeyS",
      "KeyP",
      "KeyR",
      "Space",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown"
    ].includes(code)
  }
}
