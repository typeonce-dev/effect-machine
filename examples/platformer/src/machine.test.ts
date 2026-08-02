import { Machine } from "@typeonce/effect-machine"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { CharacterMachine, type CharacterSnapshot, Event } from "./machine.ts"

const playingSnapshot = (snapshot: CharacterSnapshot) => {
  const locomotion = snapshot.states.locomotion.state
  if (locomotion.path !== "Character.locomotion.Playing") {
    throw new Error(`Expected Playing, received ${locomotion.path}`)
  }
  return locomotion
}

const runPlan = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect as unknown as Effect.Effect<A, E, never>)

describe("platformer history integration", () => {
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
