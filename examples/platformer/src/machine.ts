import { Machine } from "@typeonce/effect-machine"
import { Effect, Schema } from "effect"

// Domain schemas are shared by state payloads and the public physics protocol.
export const Axis = Schema.Literals([-1, 0, 1])
export type Axis = typeof Axis.Type
const JumpKind = Schema.Literals(["Ground", "Double", "Wall"])

const State = Schema.TaggedUnion({
  Character: {},
  Locomotion: {},
  Playing: {},
  Paused: { pausedAt: Schema.Number },
  Grounded: {},
  Standing: {},
  Running: { startedAt: Schema.Number },
  Ducking: { startedAt: Schema.Number },
  Landing: { impact: Schema.Number, resumeAxis: Axis, landedAt: Schema.Number },
  Airborne: { originY: Schema.Number },
  Motion: {},
  Jumping: { startedAt: Schema.Number, push: Axis, kind: JumpKind },
  Falling: { apexY: Schema.Number },
  Diving: { startedAt: Schema.Number },
  AirJump: {},
  AirJumpGroundLock: {},
  AirJumpWallLock: {},
  AirJumpReady: {},
  AirJumpSpent: {},
  WallContact: {},
  NoWall: {},
  LeftWall: {},
  RightWall: {},
  Facing: {},
  Left: {},
  Right: {}
})

// Inputs and physics facts are one runtime-decoded, statically typed protocol.
export const Event = Schema.TaggedUnion({
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

const awayFrom = (wall: Axis): Axis => (wall === -1 ? 1 : wall === 1 ? -1 : 0)

export const CharacterStates = Machine.defineStates({
  Character: {
    schema: State.cases.Character,
    type: "parallel",
    states: {
      locomotion: {
        schema: State.cases.Locomotion,
        initial: "Playing",
        states: {
          Playing: {
            schema: State.cases.Playing,
            initial: "Grounded",
            states: {
              Grounded: {
                schema: State.cases.Grounded,
                initial: "Standing",
                states: {
                  Standing: State.cases.Standing,
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
                    schema: State.cases.Motion,
                    initial: "Jumping",
                    states: {
                      Jumping: State.cases.Jumping,
                      Falling: State.cases.Falling,
                      Diving: State.cases.Diving
                    }
                  },
                  airJump: {
                    schema: State.cases.AirJump,
                    initial: "AirJumpGroundLock",
                    states: {
                      AirJumpGroundLock: State.cases.AirJumpGroundLock,
                      AirJumpWallLock: State.cases.AirJumpWallLock,
                      AirJumpReady: State.cases.AirJumpReady,
                      AirJumpSpent: State.cases.AirJumpSpent
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
        schema: State.cases.Facing,
        initial: "Right",
        states: {
          Left: State.cases.Left,
          Right: State.cases.Right
        }
      },
      contact: {
        schema: State.cases.WallContact,
        initial: "NoWall",
        states: {
          NoWall: State.cases.NoWall,
          LeftWall: State.cases.LeftWall,
          RightWall: State.cases.RightWall
        }
      }
    }
  }
})

const initialPlaying = (): Machine.Machine.SnapshotByIdentifier<
  typeof CharacterStates.states,
  "Character.locomotion.Playing"
> => ({
  path: "Character.locomotion.Playing",
  value: State.cases.Playing.make({}),
  state: {
    path: "Character.locomotion.Playing.Grounded",
    value: State.cases.Grounded.make({}),
    state: {
      path: "Character.locomotion.Playing.Grounded.Standing",
      value: State.cases.Standing.make({})
    }
  }
})

const initialCharacter = () =>
  CharacterStates.initial.Character(State.cases.Character.make({}), (character) =>
    character
      .locomotion(State.cases.Locomotion.make({}), (locomotion) =>
        locomotion.Playing(State.cases.Playing.make({}), (playing) =>
          playing.Grounded(State.cases.Grounded.make({}), (grounded) =>
            grounded.Standing(State.cases.Standing.make({})))))
      .facing(State.cases.Facing.make({}), (facing) =>
        facing.Right(State.cases.Right.make({})))
      .contact(State.cases.WallContact.make({}), (contact) =>
        contact.NoWall(State.cases.NoWall.make({}))))

export const CharacterMachine = Machine.make({
  id: "PlatformerCharacter",
  states: CharacterStates.states,
  events: [Event],
  internalEvents: [InternalEvent],
  initial: initialCharacter
}).handle({
  Character: {
    on: {
      Reset: initialCharacter
    },
    states: {
      locomotion: {
        states: {
          Playing: {
            history: {
              resume: {
                default: initialPlaying
              }
            },
            on: {
              Pause: ({ event, target }) =>
                target.branch.Character.locomotion.Paused(State.cases.Paused.make({ pausedAt: event.at }))
            },
            states: {
              Grounded: {
                on: {
                  JumpPressed: ({ event, target }) =>
                    target.full.Character(State.cases.Character.make({}), (character) =>
                      character
                        .locomotion(State.cases.Locomotion.make({}), (locomotion) =>
                          locomotion.Playing(State.cases.Playing.make({}), (playing) =>
                            playing.Airborne(State.cases.Airborne.make({ originY: event.y }), (airborne) =>
                              airborne
                                .motion(State.cases.Motion.make({}), (motion) =>
                                  motion.Jumping(
                                    State.cases.Jumping.make({ startedAt: event.at, push: 0, kind: "Ground" })
                                  ))
                                .airJump(State.cases.AirJump.make({}), (airJump) =>
                                  airJump.AirJumpGroundLock(State.cases.AirJumpGroundLock.make({}))))))
                        .facing(State.cases.Facing.make({}), (facing) =>
                          facing.Right(State.cases.Right.make({})))
                        .contact(State.cases.WallContact.make({}), (contact) =>
                          event.wall === -1
                            ? contact.LeftWall(State.cases.LeftWall.make({}))
                            : event.wall === 1
                            ? contact.RightWall(State.cases.RightWall.make({}))
                            : contact.NoWall(State.cases.NoWall.make({}))))
                },
                states: {
                  Standing: {
                    on: {
                      Move: ({ event, target }) =>
                        event.axis === 0
                          ? undefined
                          : target.local.Running(State.cases.Running.make({ startedAt: event.at })),
                      DownPressed: ({ event, target }) =>
                        target.local.Ducking(State.cases.Ducking.make({ startedAt: event.at }))
                    }
                  },
                  Running: {
                    on: {
                      Move: ({ event, target }) =>
                        event.axis === 0 ? target.local.Standing(State.cases.Standing.make({})) : undefined,
                      DownPressed: ({ event, target }) =>
                        target.local.Ducking(State.cases.Ducking.make({ startedAt: event.at }))
                    }
                  },
                  Ducking: {
                    on: {
                      DownReleased: ({ event, target }) =>
                        event.axis === 0
                          ? target.local.Standing(State.cases.Standing.make({}))
                          : target.local.Running(State.cases.Running.make({ startedAt: event.at }))
                    }
                  },
                  Landing: {
                    invoke: Machine.after("140 millis", InternalEvent.cases.LandingSettled.make({}), {
                      id: "landing-settle"
                    }),
                    on: {
                      Move: ({ event, state, target }) =>
                        target.local.Landing(Machine.retag(State.cases.Landing, state, { resumeAxis: event.axis })),
                      LandingSettled: ({ state, target }) =>
                        state.resumeAxis === 0
                          ? target.local.Standing(State.cases.Standing.make({}))
                          : target.local.Running(State.cases.Running.make({ startedAt: state.landedAt + 140 }))
                    }
                  }
                }
              },
              Airborne: {
                on: {
                  JumpPressed: Effect.fn(function*({ event, runtime }) {
                    const machine = yield* runtime
                    const push = awayFrom(event.wall)
                    yield* machine.raise(
                      push === 0
                        ? InternalEvent.cases.TryAirJump.make({ at: event.at })
                        : InternalEvent.cases.WallJump.make({ at: event.at, push })
                    )
                  }),
                  Landed: ({ event, target }) =>
                    target.branch.Character.locomotion.Playing.Grounded(
                      State.cases.Grounded.make({}),
                      (grounded) =>
                        grounded.Landing(
                          State.cases.Landing.make({
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
                      DoubleJump: ({ event, target }) =>
                        target.local.Jumping(
                          State.cases.Jumping.make({ startedAt: event.at, push: 0, kind: "Double" })
                        ),
                      WallJump: ({ event, target }) =>
                        target.local.Jumping(
                          State.cases.Jumping.make({ startedAt: event.at, push: event.push, kind: "Wall" })
                        )
                    },
                    states: {
                      Jumping: {
                        on: {
                          ApexReached: ({ event, target }) =>
                            target.local.Falling(State.cases.Falling.make({ apexY: event.y })),
                          DownPressed: ({ event, target }) =>
                            target.local.Diving(State.cases.Diving.make({ startedAt: event.at }))
                        }
                      },
                      Falling: {
                        on: {
                          DownPressed: ({ event, target }) =>
                            target.local.Diving(State.cases.Diving.make({ startedAt: event.at }))
                        }
                      },
                      Diving: {}
                    }
                  },
                  airJump: {
                    on: {
                      WallJump: {
                        reenter: true,
                        transition: ({ target }) => target.local.AirJumpWallLock(State.cases.AirJumpWallLock.make({}))
                      }
                    },
                    states: {
                      AirJumpGroundLock: {
                        invoke: Machine.after("120 millis", InternalEvent.cases.AirJumpUnlocked.make({}), {
                          id: "ground-air-jump-unlock"
                        }),
                        on: {
                          AirJumpUnlocked: ({ target }) => target.local.AirJumpReady(State.cases.AirJumpReady.make({}))
                        }
                      },
                      AirJumpWallLock: {
                        invoke: Machine.after("240 millis", InternalEvent.cases.AirJumpUnlocked.make({}), {
                          id: "wall-air-jump-unlock"
                        }),
                        on: {
                          AirJumpUnlocked: ({ target }) => target.local.AirJumpReady(State.cases.AirJumpReady.make({}))
                        }
                      },
                      AirJumpReady: {
                        on: {
                          TryAirJump: Effect.fn(function*({ event, runtime, target }) {
                            const machine = yield* runtime
                            yield* machine.raise(InternalEvent.cases.DoubleJump.make({ at: event.at }))
                            return target.local.AirJumpSpent(State.cases.AirJumpSpent.make({}))
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
              Resume: ({ target }) => target.history.Character.locomotion.Playing.resume()
            }
          }
        }
      },
      facing: {
        states: {
          Left: {
            on: {
              Move: ({ event, target }) =>
                event.axis === 1 ? target.local.Right(State.cases.Right.make({})) : undefined,
              WallJump: ({ event, target }) =>
                event.push === 1 ? target.local.Right(State.cases.Right.make({})) : undefined
            }
          },
          Right: {
            on: {
              Move: ({ event, target }) => event.axis === -1 ? target.local.Left(State.cases.Left.make({})) : undefined,
              WallJump: ({ event, target }) =>
                event.push === -1 ? target.local.Left(State.cases.Left.make({})) : undefined
            }
          }
        }
      },
      contact: {
        on: {
          WallContact: ({ event, target }) =>
            event.wall === -1
              ? target.local.LeftWall(State.cases.LeftWall.make({}))
              : event.wall === 1
              ? target.local.RightWall(State.cases.RightWall.make({}))
              : target.local.NoWall(State.cases.NoWall.make({}))
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
  return playing.path === "Character.locomotion.Playing.Grounded"
    ? playing.state.value
    : playing.states.motion.state.value
}

export type LocomotionMode = ReturnType<typeof locomotionState>["_tag"]

export const locomotionMode = (snapshot: CharacterSnapshot): LocomotionMode => locomotionState(snapshot)._tag

export const locomotionBranch = (snapshot: CharacterSnapshot) => {
  const locomotion = snapshot.states.locomotion.state
  return locomotion.path === "Character.locomotion.Paused" ? locomotion.value._tag : locomotion.state.value._tag
}

export const airJumpMode = (snapshot: CharacterSnapshot) => {
  const locomotion = snapshot.states.locomotion.state
  return locomotion.path === "Character.locomotion.Playing" &&
      locomotion.state.path === "Character.locomotion.Playing.Airborne"
    ? locomotion.state.states.airJump.state.value._tag
    : undefined
}

export const wallContact = (snapshot: CharacterSnapshot) => {
  return snapshot.states.contact.state.value._tag
}

export const facingDirection = (snapshot: CharacterSnapshot) => snapshot.states.facing.state.value._tag

export const activeStateData = (snapshot: CharacterSnapshot) => {
  const locomotion = snapshot.states.locomotion.state
  if (locomotion.path === "Character.locomotion.Paused") {
    const { _tag: _paused, ...pausedData } = locomotion.value
    return pausedData
  }

  const playing = locomotion.state
  const { _tag: _branch, ...branchData } = playing.value
  if (playing.path === "Character.locomotion.Playing.Grounded") {
    const { _tag: _leaf, ...leafData } = playing.state.value
    return { ...branchData, ...leafData }
  }
  const { _tag: _motion, ...motionData } = playing.states.motion.state.value
  return {
    ...branchData,
    ...motionData,
    airJump: playing.states.airJump.state.value._tag
  }
}
