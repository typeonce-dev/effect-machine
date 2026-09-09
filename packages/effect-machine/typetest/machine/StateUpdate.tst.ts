import { Schema } from "effect"
import { describe, expect, it } from "tstyche"
import { Machine } from "../../src/index.js"

class Root extends Schema.TaggedClass<Root>("Root")("Root", { revision: Schema.Number }) {}
class Work extends Schema.TaggedClass<Work>("Work")("Work", { revision: Schema.Number }) {}
class Auth extends Schema.TaggedClass<Auth>("Auth")("Auth", { user: Schema.String }) {}
class Sync extends Schema.TaggedClass<Sync>("Sync")("Sync", { cursor: Schema.Number }) {}
class SignedOut extends Schema.TaggedClass<SignedOut>("SignedOut")("SignedOut", {}) {}
class SignedIn extends Schema.TaggedClass<SignedIn>("SignedIn")("SignedIn", {}) {}
class Idle extends Schema.TaggedClass<Idle>("Idle")("Idle", {}) {}
class Tick extends Schema.TaggedClass<Tick>("Tick")("Tick", {}) {}

const States = Machine.state({
  initial: "structural",
  states: {
    root: {
      schema: Root,
      initial: "work",
      states: {
        work: {
          schema: Work,
          type: "parallel",
          states: {
            auth: {
              schema: Auth,
              initial: "signedOut",
              states: { signedOut: SignedOut, signedIn: { schema: SignedIn, type: "final" } }
            },
            sync: {
              schema: Sync,
              initial: "idle",
              states: { idle: Idle }
            }
          }
        },
        routing: { type: "choice" }
      }
    },
    structural: {
      initial: "idle",
      states: { idle: Idle }
    }
  }
})

describe("Machine state-value updates", () => {
  it("exposes updates only for the valued active ancestor chain", () => {
    const targets1 = Machine.targets(States)
    const machine = Machine.make({
      branches: { auth: { owner: { update: targets1.root.root.work.auth } } },
      root: States,
      events: Machine.eventsFromSchemas(Tick),
      initialConfiguration: (root) =>
        root.resolve(({ target }) =>
          target.from((to) =>
            to.root.decoded(new Root({ revision: 0 }), (root) =>
              root.work.decoded(
                new Work({ revision: 0 }),
                (work) =>
                  work.auth.decoded(
                    new Auth({ user: "" }),
                    (auth) => auth.signedOut.decoded(new SignedOut({}))
                  )
                    .sync.decoded(new Sync({ cursor: 0 }), (sync) => sync.idle.decoded(new Idle({})))
              ))
          )
        )
    })

    machine.handle({
      states: {
        root: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: "auth",
                          reenter: true,
                          resolve: ({ ancestors, select, state }) => {
                            expect(state).type.toBe<SignedOut>()
                            expect(ancestors["root.work.auth"]).type.toBe<Auth>()
                            expect(select.owner.decoded).type.toBeCallableWith(new Auth({ user: "next" }))
                            expect(select.owner.from).type.toBeCallableWith({ user: "next" })
                            return select.owner.decoded(new Auth({ user: "next" }))
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })
  })

  it("requires the declared retained owner replacement", () => {
    const targets = Machine.targets(States)
    const machine = Machine.make({
      root: States,
      events: Machine.eventsFromSchemas(Tick),
      branches: {
        signIn: { signedIn: { target: targets.root.root.work.auth.signedIn, update: targets.root.root.work.auth } },
        wrongOwner: { signedIn: { target: targets.root.root.work.auth.signedIn, update: targets.root.root.work.sync } },
        change: { changed: { update: targets.root.root }, unchanged: { none: true } }
      }
    })
    machine.handle({
      states: {
        root: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: "signIn",
                          resolve: ({ ancestors, select }) => {
                            expect(ancestors["root.work.auth"]).type.toBe<Auth>()
                            expect(select.signedIn.from).type.toBeCallableWith({})
                            expect(select.signedIn.decoded).type.toBeCallableWith(new SignedIn({}))
                            const selected = select.signedIn.decoded(new SignedIn({}))
                            expect(selected.update.from).type.toBeCallableWith({ user: "next" })
                            expect(selected.update.decoded).type.toBeCallableWith(new Auth({ user: "next" }))
                            return selected.update.decoded(new Auth({ user: "next" }))
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })
    machine.handle({
      states: {
        root: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: "signIn",
                          // @ts-expect-error! The declared retained owner must be constructed before returning a branch.
                          resolve: ({ select }) => select.signedIn.decoded(new SignedIn({}))
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        root: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: "wrongOwner",
                          resolve: () => undefined
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })
    machine.handle({
      states: {
        root: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: "change",
                          declinable: true,
                          resolve: ({ select, decline, ancestors }) =>
                            ancestors.root.revision === 0 ? select.changed.from({ revision: 1 }) : decline()
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        root: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedOut: {
                      on: {
                        Tick: {
                          branches: "change",
                          resolve: () => undefined
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    })
  })

  it("rejects updates to structural states, choice updates, and final-state transitions", () => {
    const targets = Machine.targets(States)
    const machine = Machine.make({ root: States, events: Machine.eventsFromSchemas(Tick) })
    expect(machine.handle).type.not.toBeCallableWith({
      states: { structural: { on: { Tick: { update: targets.root.structural, from: () => ({}) } } } }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        root: { states: { routing: { choice: { update: targets.root.root, from: () => ({ revision: 1 }) } } } }
      }
    })
    expect(machine.handle).type.not.toBeCallableWith({
      states: {
        root: {
          states: {
            work: {
              states: {
                auth: {
                  states: {
                    signedIn: { on: { Tick: { update: targets.root.root.work.auth, from: () => ({ user: "next" }) } } }
                  }
                }
              }
            }
          }
        }
      }
    })
  })
})
