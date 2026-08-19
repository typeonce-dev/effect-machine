import { Machine } from "@typeonce/effect-machine"
import { Schema } from "effect"

// Domain schemas are shared by state payloads and the public physics protocol.
export const Axis = Schema.Literals([-1, 0, 1])
export type Axis = typeof Axis.Type
const JumpKind = Schema.Literals(["Ground", "Double", "Wall"])

const State = Schema.TaggedUnion({
  Paused: { pausedAt: Schema.Number },
  Running: { startedAt: Schema.Number },
  Ducking: { startedAt: Schema.Number },
  Landing: { impact: Schema.Number, resumeAxis: Axis, landedAt: Schema.Number },
  Airborne: { originY: Schema.Number },
  Jumping: { startedAt: Schema.Number, push: Axis, kind: JumpKind },
  Falling: { apexY: Schema.Number },
  Diving: { startedAt: Schema.Number }
})

// Inputs and physics facts are one runtime-decoded, statically typed protocol.
export const CharacterEvents = Machine.events(
  Schema.TaggedUnion({
    Move: { axis: Axis, at: Schema.Number },
    JumpPressed: { at: Schema.Number, y: Schema.Number, wall: Axis },
    WallContact: { wall: Axis },
    DownPressed: { at: Schema.Number },
    DownReleased: { axis: Axis, at: Schema.Number },
    ApexReached: { y: Schema.Number },
    Landed: { impact: Schema.Number, axis: Axis, at: Schema.Number },
    Pause: { at: Schema.Number },
    Resume: {},
    Reset: {}
  })
)

const InternalEvents = Machine.internalEvents(
  Schema.TaggedUnion({
    LandingSettled: {},
    AirJumpUnlocked: {},
    TryAirJump: { at: Schema.Number },
    DoubleJump: { at: Schema.Number },
    WallJump: { at: Schema.Number, push: Axis }
  })
)

const awayFrom = (wall: Axis): Axis => (wall === -1 ? 1 : wall === 1 ? -1 : 0)

export const CharacterStates = Machine.states({
  Character: {
    type: "parallel",
    states: {
      locomotion: {
        initial: "Playing",
        states: {
          Playing: {
            initial: "Grounded",
            states: {
              Grounded: {
                initial: "Standing",
                states: {
                  Standing: {},
                  Running: State.cases.Running,
                  Ducking: State.cases.Ducking,
                  Landing: State.cases.Landing
                }
              },
              Airborne: {
                schema: State.cases.Airborne,
                type: "parallel",
                states: {
                  motion: {
                    initial: "Jumping",
                    states: {
                      Jumping: State.cases.Jumping,
                      Falling: State.cases.Falling,
                      Diving: State.cases.Diving
                    }
                  },
                  airJump: {
                    initial: "AirJumpGroundLock",
                    states: {
                      AirJumpGroundLock: {},
                      AirJumpWallLock: {},
                      AirJumpReady: {},
                      AirJumpSpent: {}
                    }
                  }
                }
              },
              resume: {
                type: "history",
                history: "deep"
              }
            }
          },
          Paused: State.cases.Paused
        }
      },
      facing: {
        initial: "Right",
        states: {
          Left: {},
          Right: {}
        }
      },
      contact: {
        initial: "NoWall",
        states: {
          NoWall: {},
          LeftWall: {},
          RightWall: {}
        }
      }
    }
  }
})

export const CharacterMachine = Machine.make({
  id: "PlatformerCharacter",
  states: CharacterStates.states,
  events: CharacterEvents,
  internalEvents: InternalEvents,
  initial: {
    target: (to) => to.Character.initial(),
    resolve: ({ target }) =>
      target.from((character) =>
        character
          .locomotion.from((locomotion) =>
            locomotion.Playing.from((playing) => playing.Grounded.from((grounded) => grounded.Standing.from()))
          )
          .facing.from((facing) => facing.Right.from())
          .contact.from((contact) => contact.NoWall.from())
      )
  }
}).handle({
  Character: {
    on: {
      Reset: (to) =>
        to.full.Character().resolve(({ target }) =>
          target.from((character) =>
            character
              .locomotion.from((locomotion) =>
                locomotion.Playing.from((playing) => playing.Grounded.from((grounded) => grounded.Standing.from()))
              )
              .facing.from((facing) => facing.Right.from())
              .contact.from((contact) => contact.NoWall.from())
          )
        )
    },
    states: {
      locomotion: {
        states: {
          Playing: {
            history: {
              resume: {
                default: ({ target }) =>
                  target.Character.from((character) =>
                    character
                      .locomotion.from((locomotion) =>
                        locomotion.Playing.from((playing) =>
                          playing.Grounded.from((grounded) => grounded.Standing.from())
                        )
                      )
                      .facing.from((facing) => facing.Right.from())
                      .contact.from((contact) => contact.NoWall.from())
                  )
              }
            },
            on: {
              Pause: (to) =>
                to.branch.Character.locomotion.Paused().resolve(({ event, target }) =>
                  target.from({ pausedAt: event.at })
                )
            },
            states: {
              Grounded: {
                on: {
                  JumpPressed: (to) =>
                    to.full.Character().resolve(({ event, target }) =>
                      target.from((character) =>
                        character
                          .locomotion.from((locomotion) =>
                            locomotion.Playing.from((playing) =>
                              playing.Airborne.from({ originY: event.y }, (airborne) =>
                                airborne
                                  .motion.from((motion) =>
                                    motion.Jumping.from({ startedAt: event.at, push: 0, kind: "Ground" })
                                  )
                                  .airJump.from((airJump) => airJump.AirJumpGroundLock.from()))
                            )
                          )
                          .facing.from((facing) => facing.Right.from())
                          .contact.from((contact) =>
                            event.wall === -1
                              ? contact.LeftWall.from()
                              : event.wall === 1
                              ? contact.RightWall.from()
                              : contact.NoWall.from()
                          )
                      )
                    )
                },
                states: {
                  Standing: {
                    on: {
                      Move: (to) =>
                        to.branches({
                          moving: { target: to.local.Running() },
                          unchanged: { target: to.none() }
                        }).resolve(({ event, select }) =>
                          event.axis === 0
                            ? select.unchanged()
                            : select.moving.from({ startedAt: event.at })
                        ),
                      DownPressed: (to) =>
                        to.local.Ducking().resolve(({ event, target }) => target.from({ startedAt: event.at }))
                    }
                  },
                  Running: {
                    on: {
                      Move: (to) =>
                        to.branches({
                          stopped: { target: to.local.Standing() },
                          unchanged: { target: to.none() }
                        }).resolve(({ event, select }) =>
                          event.axis === 0
                            ? select.stopped.from()
                            : select.unchanged()
                        ),
                      DownPressed: (to) =>
                        to.local.Ducking().resolve(({ event, target }) => target.from({ startedAt: event.at }))
                    }
                  },
                  Ducking: {
                    on: {
                      DownReleased: (to) =>
                        to.branches({
                          stopped: { target: to.local.Standing() },
                          running: { target: to.local.Running() }
                        }).resolve(({ event, select }) =>
                          event.axis === 0
                            ? select.stopped.from()
                            : select.running.from({ startedAt: event.at })
                        )
                    }
                  },
                  Landing: {
                    invoke: Machine.invoke({
                      id: "landing-settle",
                      after: "140 millis",
                      onDone: (to) =>
                        to.none().resolve((_, enqueue) => {
                          enqueue.raise(InternalEvents.LandingSettled())
                          return undefined
                        })
                    }),
                    on: {
                      LandingSettled: (to) =>
                        to.branches({
                          stopped: { target: to.local.Standing() },
                          running: { target: to.local.Running() }
                        }).resolve(({ state, select }) =>
                          state.resumeAxis === 0
                            ? select.stopped.from()
                            : select.running.from({ startedAt: state.landedAt + 140 })
                        ),
                      Move: (to) =>
                        to.local.Landing().resolve(({ event, state, target }) => {
                          const { _tag: _, ...fields } = state
                          return target.from({ ...fields, resumeAxis: event.axis })
                        })
                    }
                  }
                }
              },
              Airborne: {
                on: {
                  JumpPressed: (to) =>
                    to.none().resolve(({ event }, enqueue) => {
                      const push = awayFrom(event.wall)
                      enqueue.raise(
                        push === 0
                          ? InternalEvents.TryAirJump({ at: event.at })
                          : InternalEvents.WallJump({ at: event.at, push })
                      )
                      return undefined
                    }),
                  Landed: (to) =>
                    to.branch.Character.locomotion.Playing.Grounded().resolve(({ event, target }) =>
                      target.from((grounded) =>
                        grounded.Landing.from({
                          impact: event.impact,
                          resumeAxis: event.axis,
                          landedAt: event.at
                        })
                      )
                    )
                },
                states: {
                  motion: {
                    on: {
                      DoubleJump: (to) =>
                        to.local.Jumping().resolve(({ event, target }) =>
                          target.from({ startedAt: event.at, push: 0, kind: "Double" })
                        ),
                      WallJump: (to) =>
                        to.local.Jumping().resolve(({ event, target }) =>
                          target.from({ startedAt: event.at, push: event.push, kind: "Wall" })
                        )
                    },
                    states: {
                      Jumping: {
                        on: {
                          ApexReached: (to) =>
                            to.local.Falling().resolve(({ event, target }) => target.from({ apexY: event.y })),
                          DownPressed: (to) =>
                            to.local.Diving().resolve(({ event, target }) => target.from({ startedAt: event.at }))
                        }
                      },
                      Falling: {
                        on: {
                          DownPressed: (to) =>
                            to.local.Diving().resolve(({ event, target }) => target.from({ startedAt: event.at }))
                        }
                      },
                      Diving: {}
                    }
                  },
                  airJump: {
                    on: {
                      WallJump: (to) =>
                        to.local.AirJumpWallLock().resolve(({ target }) => target.from(), { reenter: true })
                    },
                    states: {
                      AirJumpGroundLock: {
                        invoke: Machine.invoke({
                          id: "ground-air-jump-unlock",
                          after: "120 millis",
                          onDone: (to) => to.local.AirJumpReady().resolve(({ target }) => target.from())
                        }),
                        on: {}
                      },
                      AirJumpWallLock: {
                        invoke: Machine.invoke({
                          id: "wall-air-jump-unlock",
                          after: "240 millis",
                          onDone: (to) => to.local.AirJumpReady().resolve(({ target }) => target.from())
                        }),
                        on: {}
                      },
                      AirJumpReady: {
                        on: {
                          TryAirJump: (to) =>
                            to.local.AirJumpSpent().resolve(({ event, target }, enqueue) => {
                              enqueue.raise(InternalEvents.DoubleJump({ at: event.at }))
                              return target.from()
                            })
                        }
                      },
                      AirJumpSpent: {}
                    }
                  }
                }
              }
            }
          },
          Paused: {
            on: {
              Resume: (to) => to.history.Character.locomotion.Playing.resume().resolve(({ target }) => target())
            }
          }
        }
      },
      facing: {
        states: {
          Left: {
            on: {
              Move: (to) =>
                to.branches({ right: { target: to.local.Right() }, unchanged: { target: to.none() } }).resolve((
                  { event, select }
                ) => event.axis === 1 ? select.right.from() : select.unchanged()),
              WallJump: (to) =>
                to.branches({ right: { target: to.local.Right() }, unchanged: { target: to.none() } }).resolve((
                  { event, select }
                ) => event.push === 1 ? select.right.from() : select.unchanged())
            }
          },
          Right: {
            on: {
              Move: (to) =>
                to.branches({ left: { target: to.local.Left() }, unchanged: { target: to.none() } }).resolve((
                  { event, select }
                ) => event.axis === -1 ? select.left.from() : select.unchanged()),
              WallJump: (to) =>
                to.branches({ left: { target: to.local.Left() }, unchanged: { target: to.none() } }).resolve((
                  { event, select }
                ) => event.push === -1 ? select.left.from() : select.unchanged())
            }
          }
        }
      },
      contact: {
        on: {
          WallContact: (to) =>
            to.branches({
              leftWall: { title: "Left wall", target: to.local.LeftWall() },
              rightWall: { title: "Right wall", target: to.local.RightWall() },
              noWall: { title: "No wall", target: to.local.NoWall() }
            }).resolve(({ event, select }) =>
              event.wall === -1
                ? select.leftWall.from()
                : event.wall === 1
                ? select.rightWall.from()
                : select.noWall.from()
            )
        },
        states: {
          NoWall: {},
          LeftWall: {},
          RightWall: {}
        }
      }
    }
  }
})

export type CharacterSnapshot = Machine.Machine.Snapshot<typeof CharacterStates.states>
export type CharacterEvent = Machine.Machine.InputEvent<typeof CharacterMachine>

export const isPaused = (snapshot: CharacterSnapshot) =>
  snapshot.states.locomotion.state.path === "Character.locomotion.Paused"

export const locomotionState = (snapshot: CharacterSnapshot) => {
  const locomotion = snapshot.states.locomotion.state
  if (locomotion.path === "Character.locomotion.Paused") {
    return locomotion.value
  }

  const playing = locomotion.state
  if (playing.path === "Character.locomotion.Playing.Airborne") {
    return playing.states.motion.state.value
  }
  return playing.state.path === "Character.locomotion.Playing.Grounded.Standing"
    ? { _tag: "Standing" as const }
    : playing.state.value
}

export type LocomotionMode = ReturnType<typeof locomotionState>["_tag"]

export const locomotionMode = (snapshot: CharacterSnapshot): LocomotionMode => locomotionState(snapshot)._tag

export const locomotionBranch = (snapshot: CharacterSnapshot) => {
  const locomotion = snapshot.states.locomotion.state
  if (locomotion.path === "Character.locomotion.Paused") return "Paused" as const
  return locomotion.state.path === "Character.locomotion.Playing.Grounded" ? "Grounded" as const : "Airborne" as const
}

export const airJumpMode = (snapshot: CharacterSnapshot) => {
  const locomotion = snapshot.states.locomotion.state
  if (
    locomotion.path !== "Character.locomotion.Playing" ||
    locomotion.state.path !== "Character.locomotion.Playing.Airborne"
  ) return undefined

  const path = locomotion.state.states.airJump.state.path
  if (path === "Character.locomotion.Playing.Airborne.airJump.AirJumpGroundLock") return "AirJumpGroundLock" as const
  if (path === "Character.locomotion.Playing.Airborne.airJump.AirJumpWallLock") return "AirJumpWallLock" as const
  if (path === "Character.locomotion.Playing.Airborne.airJump.AirJumpReady") return "AirJumpReady" as const
  return "AirJumpSpent" as const
}

export const wallContact = (snapshot: CharacterSnapshot) => {
  const path = snapshot.states.contact.state.path
  if (path === "Character.contact.NoWall") return "NoWall" as const
  return path === "Character.contact.LeftWall" ? "LeftWall" as const : "RightWall" as const
}

export const facingDirection = (snapshot: CharacterSnapshot) =>
  snapshot.states.facing.state.path === "Character.facing.Left" ? "Left" as const : "Right" as const

export const activeStateData = (snapshot: CharacterSnapshot) => {
  const locomotion = snapshot.states.locomotion.state
  if (locomotion.path === "Character.locomotion.Paused") {
    const { _tag: _paused, ...pausedData } = locomotion.value
    return pausedData
  }

  const playing = locomotion.state
  if (playing.path === "Character.locomotion.Playing.Grounded") {
    if (playing.state.path === "Character.locomotion.Playing.Grounded.Standing") return {}
    const { _tag: _leaf, ...leafData } = playing.state.value
    return leafData
  }
  const { _tag: _branch, ...branchData } = playing.value
  const { _tag: _motion, ...motionData } = playing.states.motion.state.value
  return {
    ...branchData,
    ...motionData,
    airJump: airJumpMode(snapshot)
  }
}
