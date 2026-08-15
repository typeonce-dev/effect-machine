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
const Event = Schema.TaggedUnion({
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

const InternalEvent = Schema.TaggedUnion({
  LandingSettled: {},
  AirJumpUnlocked: {},
  TryAirJump: { at: Schema.Number },
  DoubleJump: { at: Schema.Number },
  WallJump: { at: Schema.Number, push: Axis }
})

export const CharacterEvents = Machine.events(Event)
const InternalEvents = Machine.internalEvents(InternalEvent)

const awayFrom = (wall: Axis): Axis => (wall === -1 ? 1 : wall === 1 ? -1 : 0)

export const CharacterStates = Machine.defineStates({
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

const initialCharacter = () =>
  CharacterStates.initial.Character.from((character) =>
    character
      .locomotion.from((locomotion) =>
        locomotion.Playing.from((playing) => playing.Grounded.from((grounded) => grounded.Standing.from()))
      )
      .facing.from((facing) => facing.Right.from())
      .contact.from((contact) => contact.NoWall.from())
  )

const definition = Machine.make({
  id: "PlatformerCharacter",
  states: CharacterStates.states,
  events: CharacterEvents,
  internalEvents: InternalEvents,
  initial: initialCharacter
})

export const CharacterMachine = definition.handle({
  Character: {
    on: {
      Reset: {
        targets: ["Character"],
        transition: initialCharacter
      }
    },
    states: {
      locomotion: {
        states: {
          Playing: {
            history: {
              resume: {
                default: initialCharacter
              }
            },
            on: {
              Pause: {
                targets: ["Character.locomotion.Paused"],
                transition: ({ event, target }) =>
                  target.branch.Character.locomotion.Paused.from({ pausedAt: event.at })
              }
            },
            states: {
              Grounded: {
                on: {
                  JumpPressed: {
                    targets: ["Character"],
                    transition: ({ event, target }) =>
                      target.full.Character.from((character) =>
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
                  }
                },
                states: {
                  Standing: {
                    on: {
                      Move: {
                        targets: ["Character.locomotion.Playing.Grounded.Running"],
                        transition: ({ event, target }) =>
                          event.axis === 0
                            ? undefined
                            : target.local.Running.from({ startedAt: event.at })
                      },
                      DownPressed: {
                        targets: ["Character.locomotion.Playing.Grounded.Ducking"],
                        transition: ({ event, target }) => target.local.Ducking.from({ startedAt: event.at })
                      }
                    }
                  },
                  Running: {
                    on: {
                      Move: {
                        targets: ["Character.locomotion.Playing.Grounded.Standing"],
                        transition: ({ event, target }) => event.axis === 0 ? target.local.Standing.from() : undefined
                      },
                      DownPressed: {
                        targets: ["Character.locomotion.Playing.Grounded.Ducking"],
                        transition: ({ event, target }) => target.local.Ducking.from({ startedAt: event.at })
                      }
                    }
                  },
                  Ducking: {
                    on: {
                      DownReleased: {
                        targets: [
                          "Character.locomotion.Playing.Grounded.Standing",
                          "Character.locomotion.Playing.Grounded.Running"
                        ],
                        transition: ({ event, target }) =>
                          event.axis === 0
                            ? target.local.Standing.from()
                            : target.local.Running.from({ startedAt: event.at })
                      }
                    }
                  },
                  Landing: {
                    invoke: Machine.invoke({
                      id: "landing-settle",
                      after: "140 millis",
                      onDone: {
                        targets: [
                          "Character.locomotion.Playing.Grounded.Standing",
                          "Character.locomotion.Playing.Grounded.Running"
                        ],
                        transition: ({ state, target }) =>
                          state.resumeAxis === 0
                            ? target.local.Standing.from()
                            : target.local.Running.from({ startedAt: state.landedAt + 140 })
                      }
                    }),
                    on: {
                      Move: {
                        targets: ["Character.locomotion.Playing.Grounded.Landing"],
                        transition: ({ event, state, target }) =>
                          target.local.Landing(Machine.retag(State.cases.Landing, state, { resumeAxis: event.axis }))
                      }
                    }
                  }
                }
              },
              Airborne: {
                on: {
                  JumpPressed: {
                    targets: [],
                    transition: ({ event }, enqueue) => {
                      const push = awayFrom(event.wall)
                      enqueue.raise(
                        push === 0
                          ? InternalEvents.TryAirJump({ at: event.at })
                          : InternalEvents.WallJump({ at: event.at, push })
                      )
                    }
                  },
                  Landed: {
                    targets: ["Character.locomotion.Playing.Grounded.Landing"],
                    transition: ({ event, target }) =>
                      target.branch.Character.locomotion.Playing.Grounded.from((grounded) =>
                        grounded.Landing.from({
                          impact: event.impact,
                          resumeAxis: event.axis,
                          landedAt: event.at
                        })
                      )
                  }
                },
                states: {
                  motion: {
                    on: {
                      DoubleJump: {
                        targets: ["Character.locomotion.Playing.Airborne.motion.Jumping"],
                        transition: ({ event, target }) =>
                          target.local.Jumping.from({ startedAt: event.at, push: 0, kind: "Double" })
                      },
                      WallJump: {
                        targets: ["Character.locomotion.Playing.Airborne.motion.Jumping"],
                        transition: ({ event, target }) =>
                          target.local.Jumping.from({ startedAt: event.at, push: event.push, kind: "Wall" })
                      }
                    },
                    states: {
                      Jumping: {
                        on: {
                          ApexReached: {
                            targets: ["Character.locomotion.Playing.Airborne.motion.Falling"],
                            transition: ({ event, target }) => target.local.Falling.from({ apexY: event.y })
                          },
                          DownPressed: {
                            targets: ["Character.locomotion.Playing.Airborne.motion.Diving"],
                            transition: ({ event, target }) => target.local.Diving.from({ startedAt: event.at })
                          }
                        }
                      },
                      Falling: {
                        on: {
                          DownPressed: {
                            targets: ["Character.locomotion.Playing.Airborne.motion.Diving"],
                            transition: ({ event, target }) => target.local.Diving.from({ startedAt: event.at })
                          }
                        }
                      },
                      Diving: {}
                    }
                  },
                  airJump: {
                    on: {
                      WallJump: {
                        reenter: true,
                        targets: ["Character.locomotion.Playing.Airborne.airJump.AirJumpWallLock"],
                        transition: ({ target }) => target.local.AirJumpWallLock.from()
                      }
                    },
                    states: {
                      AirJumpGroundLock: {
                        invoke: Machine.invoke({
                          id: "ground-air-jump-unlock",
                          after: "120 millis",
                          onDone: {
                            targets: ["Character.locomotion.Playing.Airborne.airJump.AirJumpReady"],
                            transition: ({ target }) => target.local.AirJumpReady.from()
                          }
                        }),
                        on: {}
                      },
                      AirJumpWallLock: {
                        invoke: Machine.invoke({
                          id: "wall-air-jump-unlock",
                          after: "240 millis",
                          onDone: {
                            targets: ["Character.locomotion.Playing.Airborne.airJump.AirJumpReady"],
                            transition: ({ target }) => target.local.AirJumpReady.from()
                          }
                        }),
                        on: {}
                      },
                      AirJumpReady: {
                        on: {
                          TryAirJump: {
                            targets: ["Character.locomotion.Playing.Airborne.airJump.AirJumpSpent"],
                            transition: ({ event, target }, enqueue) => {
                              enqueue.raise(InternalEvents.DoubleJump({ at: event.at }))
                              return target.local.AirJumpSpent.from()
                            }
                          }
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
              Resume: {
                targets: ["Character.locomotion.Playing.resume"],
                transition: ({ target }) => target.history.Character.locomotion.Playing.resume()
              }
            }
          }
        }
      },
      facing: {
        states: {
          Left: {
            on: {
              Move: {
                targets: ["Character.facing.Right"],
                transition: ({ event, target }) => event.axis === 1 ? target.local.Right.from() : undefined
              },
              WallJump: {
                targets: ["Character.facing.Right"],
                transition: ({ event, target }) => event.push === 1 ? target.local.Right.from() : undefined
              }
            }
          },
          Right: {
            on: {
              Move: {
                targets: ["Character.facing.Left"],
                transition: ({ event, target }) => event.axis === -1 ? target.local.Left.from() : undefined
              },
              WallJump: {
                targets: ["Character.facing.Left"],
                transition: ({ event, target }) => event.push === -1 ? target.local.Left.from() : undefined
              }
            }
          }
        }
      },
      contact: {
        on: {
          WallContact: {
            targets: ["Character.contact.NoWall", "Character.contact.LeftWall", "Character.contact.RightWall"],
            transition: ({ event, target }) =>
              event.wall === -1
                ? target.local.LeftWall.from()
                : event.wall === 1
                ? target.local.RightWall.from()
                : target.local.NoWall.from()
          }
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
