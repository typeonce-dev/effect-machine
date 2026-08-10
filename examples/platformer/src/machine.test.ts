import { Machine } from "@typeonce/effect-machine"
import { MachineTest } from "@typeonce/effect-machine/testing"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { makeTextRenderer } from "../../../test/machine/visualization/text.ts"
import {
  airJumpMode,
  CharacterMachine,
  type CharacterSnapshot,
  Event,
  facingDirection,
  locomotionMode,
  wallContact
} from "./machine.ts"

const renderMachine = makeTextRenderer<typeof CharacterMachine, CharacterSnapshot>(Machine)

const playingSnapshot = (snapshot: CharacterSnapshot) => {
  const locomotion = snapshot.states.locomotion.state
  if (locomotion.path !== "Character.locomotion.Playing") {
    throw new Error(`Expected Playing, received ${locomotion.path}`)
  }
  return locomotion
}

const runPlan = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as unknown as Effect.Effect<A, E, never>)

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

const invariant = MachineTest.invariants(CharacterMachine)

const pauseAndResumePreserveOrthogonalRegions = invariant.step(
  "pause and resume only replace the locomotion region",
  ({ after, before, event }) =>
    event._tag !== "Pause" && event._tag !== "Resume" ||
    same(before.states.facing, after.states.facing) && same(before.states.contact, after.states.contact) ||
    `${event._tag} changed facing or wall contact`
)

const resetIsCanonical = invariant.step(
  "reset restores the canonical character configuration",
  ({ after, event }) =>
    event._tag !== "Reset" ||
    locomotionMode(after) === "Standing" &&
      facingDirection(after) === "Right" &&
      wallContact(after) === "NoWall" ||
    "reset did not restore Standing + Right + NoWall"
)

const wallJumpFacesItsPush = invariant.state(
  "wall jumps face and push away from the sampled wall",
  ({ snapshot }) => {
    const locomotion = snapshot.states.locomotion.state
    if (
      locomotion.path !== "Character.locomotion.Playing" ||
      locomotion.state.path !== "Character.locomotion.Playing.Airborne" ||
      locomotion.state.states.motion.state.path !== "Character.locomotion.Playing.Airborne.motion.Jumping" ||
      locomotion.state.states.motion.state.value.kind !== "Wall"
    ) return true

    const push = locomotion.state.states.motion.state.value.push
    const facing = facingDirection(snapshot)
    return push === 1 && facing === "Right" || push === -1 && facing === "Left" ||
      `wall jump push ${push} disagrees with facing ${facing}`
  }
)

const resumeRestoresDeepHistory = invariant.trace(
  "resume restores the exact locomotion snapshot captured by pause",
  ({ trace }) => {
    for (const step of trace.steps) {
      if (
        step.event._tag !== "Resume" ||
        step.before.states.locomotion.state.path !== "Character.locomotion.Paused" ||
        step.after.states.locomotion.state.path !== "Character.locomotion.Playing"
      ) continue

      const pause = trace.steps
        .slice(0, step.index)
        .reverse()
        .find((candidate) =>
          candidate.event._tag === "Pause" &&
          candidate.before.states.locomotion.state.path === "Character.locomotion.Playing" &&
          candidate.after.states.locomotion.state.path === "Character.locomotion.Paused"
        )
      if (pause === undefined) return "resume had no matching pause transition"
      if (!same(pause.before.states.locomotion.state, step.after.states.locomotion.state)) {
        return "resume changed the deep locomotion state captured by pause"
      }
    }
    return true
  }
)

const laws = [
  pauseAndResumePreserveOrthogonalRegions,
  resetIsCanonical,
  wallJumpFacesItsPush,
  resumeRestoresDeepHistory
]

const explorationEvents = ({ snapshot }: MachineTest.ExplorationStateContext<typeof CharacterMachine>) => {
  const locomotion = snapshot.states.locomotion.state
  if (locomotion.path === "Character.locomotion.Paused") {
    return [Event.cases.Resume.make({})]
  }

  const pauseAndReset = [Event.cases.Pause.make({ at: 70 }), Event.cases.Reset.make({})]
  if (locomotion.state.path === "Character.locomotion.Playing.Grounded") {
    return [
      Event.cases.JumpPressed.make({ at: 20, y: 100, wall: -1 }),
      Event.cases.JumpPressed.make({ at: 20, y: 100, wall: 0 }),
      Event.cases.JumpPressed.make({ at: 20, y: 100, wall: 1 }),
      ...pauseAndReset
    ]
  }

  const motion = locomotion.state.states.motion.state
  const airborne = [
    Event.cases.JumpPressed.make({ at: 30, y: 80, wall: -1 }),
    Event.cases.JumpPressed.make({ at: 30, y: 80, wall: 1 }),
    Event.cases.Landed.make({ impact: 12, axis: 0, at: 60 }),
    ...pauseAndReset
  ]
  return motion.path === "Character.locomotion.Playing.Airborne.motion.Jumping"
    ? [
      Event.cases.ApexReached.make({ y: 50 }),
      Event.cases.DownPressed.make({ at: 40 }),
      ...airborne
    ]
    : motion.path === "Character.locomotion.Playing.Airborne.motion.Falling"
    ? [Event.cases.DownPressed.make({ at: 40 }), ...airborne]
    : airborne
}

describe("platformer history integration", () => {
  it("renders registered and candidate events separately from states", async () => {
    await runPlan(Effect.gen(function*() {
      const initial = yield* Machine.planInitial(CharacterMachine)
      const definitions = Machine.transitionDefinitions(CharacterMachine)
      const rendered = renderMachine(CharacterMachine, initial.state)

      expect(definitions).toHaveLength(27)
      expect(definitions).toContainEqual({
        source: "Character.locomotion.Playing.Airborne.airJump",
        trigger: { type: "event", event: "WallJump" },
        reenter: true,
        targets: {
          type: "declared",
          paths: ["Character.locomotion.Playing.Airborne.airJump.AirJumpWallLock"]
        }
      })
      expect(definitions.every(({ targets }) => targets.type === "declared")).toBe(true)
      expect(rendered).toContain("◇ on: WallJump [reenter] → AirJumpWallLock")
      expect(rendered).toContain(
        "Candidate events: Move, DownPressed, JumpPressed, Pause, WallJump, WallContact, Reset"
      )
      expect(rendered).not.toContain("Observed event samples")
    }))
  })

  it("resumes the exact grounded leaf and its state-local value", async () => {
    await runPlan(Effect.gen(function*() {
      const initial = yield* Machine.planInitial(CharacterMachine)
      const ducking = yield* Machine.plan(
        CharacterMachine,
        initial.state,
        Event.cases.DownPressed.make({ at: 10 })
      )
      const beforePause = playingSnapshot(ducking.next)

      const paused = yield* Machine.plan(
        CharacterMachine,
        ducking.next,
        Event.cases.Pause.make({ at: 20 })
      )
      const pausedLocomotion = paused.next.states.locomotion.state
      expect(pausedLocomotion.path).toBe("Character.locomotion.Paused")
      expect(pausedLocomotion.value).toEqual({ _tag: "Paused", pausedAt: 20 })

      const resumed = yield* Machine.plan(CharacterMachine, paused.next, Event.cases.Resume.make({}))
      expect(playingSnapshot(resumed.next)).toEqual(beforePause)
      expect(resumed.next.states.facing.state.path).toBe("Character.facing.Right")
      expect(resumed.next.states.contact.state.path).toBe("Character.contact.NoWall")
    }))
  })

  it("resumes both airborne parallel regions and all nested values", async () => {
    await runPlan(Effect.gen(function*() {
      const initial = yield* Machine.planInitial(CharacterMachine)
      const airborne = yield* Machine.plan(
        CharacterMachine,
        initial.state,
        Event.cases.JumpPressed.make({ at: 100, y: 207, wall: -1 })
      )
      const falling = yield* Machine.plan(
        CharacterMachine,
        airborne.next,
        Event.cases.ApexReached.make({ y: 91 })
      )
      const beforePause = playingSnapshot(falling.next)

      const paused = yield* Machine.plan(
        CharacterMachine,
        falling.next,
        Event.cases.Pause.make({ at: 180 })
      )
      expect(paused.next.history?.["Character.locomotion.Playing.resume"]?.active).toEqual([
        "Character",
        "Character.locomotion",
        "Character.locomotion.Playing",
        "Character.locomotion.Playing.Airborne",
        "Character.locomotion.Playing.Airborne.motion",
        "Character.locomotion.Playing.Airborne.motion.Falling",
        "Character.locomotion.Playing.Airborne.airJump",
        "Character.locomotion.Playing.Airborne.airJump.AirJumpGroundLock"
      ])

      const resumed = yield* Machine.plan(CharacterMachine, paused.next, Event.cases.Resume.make({}))
      const restored = playingSnapshot(resumed.next)
      expect(restored).toEqual(beforePause)

      if (restored.state.path !== "Character.locomotion.Playing.Airborne") {
        throw new Error(`Expected Airborne, received ${restored.state.path}`)
      }
      expect(restored.state.value).toEqual({ _tag: "Airborne", originY: 207 })
      expect(restored.state.states.motion.state.value).toEqual({ _tag: "Falling", apexY: 91 })
      expect(restored.state.states.airJump.state.path).toBe(
        "Character.locomotion.Playing.Airborne.airJump.AirJumpGroundLock"
      )
    }))
  })
})

describe("platformer semantic exploration", () => {
  it("checks history and orthogonal-region laws across the public state space", async () => {
    await runPlan(Effect.gen(function*() {
      const explored = yield* MachineTest.explore(CharacterMachine, {
        events: explorationEvents,
        stateKey: ({ snapshot }) => JSON.stringify(snapshot),
        invariants: laws
      })

      expect(explored.completeness).toEqual({ _tag: "Complete" })

      const wallJump = yield* MachineTest.assertReachable(
        explored,
        "an airborne wall jump",
        ({ snapshot }) => {
          const locomotion = snapshot.states.locomotion.state
          return locomotion.path === "Character.locomotion.Playing" &&
            locomotion.state.path === "Character.locomotion.Playing.Airborne" &&
            locomotion.state.states.motion.state.path ===
              "Character.locomotion.Playing.Airborne.motion.Jumping" &&
            locomotion.state.states.motion.state.value.kind === "Wall"
        }
      )
      expect(wallJump.trace.scenario.events).toHaveLength(2)

      const pausedAirborne = yield* MachineTest.assertReachable(
        explored,
        "paused airborne deep history",
        ({ snapshot }) =>
          snapshot.states.locomotion.state.path === "Character.locomotion.Paused" &&
          snapshot.history?.["Character.locomotion.Playing.resume"]?.active.includes(
              "Character.locomotion.Playing.Airborne"
            ) === true
      )
      expect(pausedAirborne.trace.scenario.events).toHaveLength(2)

      yield* MachineTest.assertUnreachable(
        explored,
        "AirJumpReady without the internal timer event",
        ({ snapshot }) => airJumpMode(snapshot) === "AirJumpReady"
      )
    }))
  })
})
