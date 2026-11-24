import { Schema } from "effect"
import { Machine } from "../../../src/index.js"
import type { Event, Scenario } from "../support/scenario.js"
import { atOnce, failed, final, named, send, started } from "../support/scenario.js"

const Document = Machine.events({
  Open: { id: Schema.String },
  Rename: { id: Schema.String },
  Touch: {},
  Close: {},
  Note: {},
  Unknown: {}
})

const moves: Scenario = {
  name: "moves between states and carries their data",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Closed: {}, Open: { fields: { id: Schema.String } } } }),
      events: Document
    }).handle({
      initial: { target: "Closed" },
      states: {
        Closed: { on: { Open: { target: "Open", data: ({ event }) => ({ id: event.id }) } } },
        Open: {
          on: {
            Rename: { target: "Open", data: ({ event, state }) => ({ id: `${state.id}/${event.id}` }) },
            Close: { target: "Closed" }
          }
        }
      }
    }),
  start: { happens: [{ Closed: {} }] },
  steps: [
    send({ _tag: "Open", id: "a" }, { happens: [{ Open: { id: "a" } }] }),
    send({ _tag: "Rename", id: "b" }, { happens: [{ Open: { id: "a/b" } }] }),
    send({ _tag: "Close" }, { happens: [{ Closed: {} }] })
  ]
}

const unhandled: Scenario = {
  name: "takes an event that no active state handles, and does nothing",
  machine: moves.machine,
  start: moves.start,
  steps: [
    named("unknown while closed", send({ _tag: "Unknown" })),
    send({ _tag: "Open", id: "a" }, { happens: [{ Open: { id: "a" } }] }),
    named("unknown while open", send({ _tag: "Unknown" })),
    send({ _tag: "Close" }, { happens: [{ Closed: {} }] })
  ]
}

const Change = Machine.events({ Add: { by: Schema.Number }, Take: { by: Schema.Number } })

const declines: Scenario = {
  name: "offers an event that a guard or a branch declines to the ancestor",
  machine: () =>
    Machine.make({
      root: Machine.state({
        fields: { refused: Schema.Number },
        states: { Count: { fields: { value: Schema.Number } }, Empty: {} }
      }),
      events: Change
    }).handle({
      root: () => ({ refused: 0 }),
      initial: { target: "Count", data: { value: 1 } },
      on: {
        Add: { update: { root: ({ root }) => ({ refused: root.refused + 1 }) }, guard: ({ event }) => event.by !== 99 },
        Take: { update: { root: ({ root }) => ({ refused: root.refused + 10 }) } }
      },
      states: {
        Count: {
          on: {
            Add: {
              guard: ({ event }) => event.by > 0 && event.by !== 99,
              target: "Count",
              data: ({ event, state }) => ({ value: state.value + event.by })
            },
            Take: {
              branches: [{ target: "Count" }, { target: "Empty" }, { decline: true }],
              resolve: ({ event, select, state }) =>
                event.by > state.value
                  ? select.decline()
                  : event.by === state.value
                  ? select.target("Empty")
                  : select.target("Count", { data: { value: state.value - event.by } })
            }
          }
        },
        Empty: {}
      }
    }),
  start: { happens: [{ "": { refused: 0 }, Count: { value: 1 } }] },
  steps: [
    named("add 4", send({ _tag: "Add", by: 4 }, { happens: [{ "": { refused: 0 }, Count: { value: 5 } }] })),
    named(
      "add 0, which its state declines",
      send({ _tag: "Add", by: 0 }, { happens: [{ "": { refused: 1 }, Count: { value: 5 } }] })
    ),
    named("add 99, which everything declines", send({ _tag: "Add", by: 99 })),
    named(
      "take 9, which its state declines",
      send({ _tag: "Take", by: 9 }, { happens: [{ "": { refused: 11 }, Count: { value: 5 } }] })
    ),
    named("take 2", send({ _tag: "Take", by: 2 }, { happens: [{ "": { refused: 11 }, Count: { value: 3 } }] })),
    named("take 3", send({ _tag: "Take", by: 3 }, { happens: [{ "": { refused: 11 }, Empty: {} }] }))
  ]
}

const Edit = Machine.events({ Bump: {}, Keep: {}, Again: {}, Turn: {}, Same: {}, Leave: {} })

const retained: Scenario = {
  name: "updates retained state, and exits and enters only what it is told to",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({
        states: {
          Away: {},
          Page: {
            fields: { revision: Schema.Number },
            states: { Editing: { fields: { edits: Schema.Number } } }
          }
        }
      }),
      events: Edit
    }).handle({
      initial: { target: "Away" },
      states: {
        Away: { on: { Bump: { target: "Page", data: { revision: 1 } } } },
        Page: {
          initial: { target: "Page.Editing", data: { edits: 0 } },
          entry: () => note("enter page"),
          exit: () => note("exit page"),
          on: {
            Turn: { target: "Page", reenter: true, data: ({ state }) => ({ revision: state.revision + 100 }) },
            Leave: { target: "Away" }
          },
          states: {
            Editing: {
              entry: () => note("enter editing"),
              exit: () => note("exit editing"),
              on: {
                Bump: { update: { "Page.Editing": ({ state }) => ({ edits: state.edits + 1 }) } },
                Keep: { stay: true, commands: () => note("kept") },
                Again: {
                  reenter: true,
                  update: { Page: ({ ancestors }) => ({ revision: ancestors.Page.revision + 10 }) }
                },
                Same: { target: "Page.Editing", data: ({ state }) => ({ edits: state.edits + 100 }) }
              }
            }
          }
        }
      }
    }),
  start: { happens: [{ Away: {} }] },
  steps: [
    named(
      "enter",
      send({ _tag: "Bump" }, {
        happens: [{ Page: { revision: 1 }, "Page.Editing": { edits: 0 } }],
        log: ["enter page", "enter editing"]
      })
    ),
    send({ _tag: "Bump" }, { happens: [{ Page: { revision: 1 }, "Page.Editing": { edits: 1 } }] }),
    send({ _tag: "Keep" }, { log: ["kept"] }),
    send({ _tag: "Again" }, {
      happens: [{ Page: { revision: 11 }, "Page.Editing": { edits: 1 } }],
      log: ["exit editing", "enter editing"]
    }),
    send({ _tag: "Same" }, { happens: [{ Page: { revision: 11 }, "Page.Editing": { edits: 101 } }] }),
    send({ _tag: "Turn" }, {
      happens: [{ Page: { revision: 111 }, "Page.Editing": { edits: 0 } }],
      log: ["exit editing", "exit page", "enter page", "enter editing"]
    }),
    send({ _tag: "Leave" }, { happens: [{ Away: {} }], log: ["exit editing", "exit page"] })
  ]
}

const Level = Machine.events({ Enter: {}, Next: {}, Up: {}, Deep: {} })

const compound: Scenario = {
  name: "enters a compound state from its root and leaves it from its leaf",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({
        states: {
          Out: {},
          A: { states: { First: {}, Second: { states: { Leaf: {} } } } }
        }
      }),
      events: Level
    }).handle({
      initial: { target: "Out" },
      states: {
        Out: {
          exit: () => note("exit Out"),
          on: { Enter: { target: "A" }, Deep: { target: "A.Second" } }
        },
        A: {
          entry: () => note("enter A"),
          exit: () => note("exit A"),
          initial: { target: "A.First" },
          on: { Up: { target: "Out" } },
          states: {
            First: {
              entry: () => note("enter First"),
              exit: () => note("exit First"),
              on: { Next: { target: "A.Second" } }
            },
            Second: {
              entry: () => note("enter Second"),
              exit: () => note("exit Second"),
              initial: { target: "A.Second.Leaf" },
              states: { Leaf: { entry: () => note("enter Leaf"), exit: () => note("exit Leaf") } }
            }
          }
        }
      }
    }),
  start: { happens: [{ Out: {} }] },
  steps: [
    send({ _tag: "Enter" }, {
      happens: [{ "A.First": {} }],
      log: ["exit Out", "enter A", "enter First"]
    }),
    send({ _tag: "Next" }, {
      happens: [{ "A.Second.Leaf": {} }],
      log: ["exit First", "enter Second", "enter Leaf"]
    }),
    send({ _tag: "Up" }, {
      happens: [{ Out: {} }],
      log: ["exit Leaf", "exit Second", "exit A"]
    }),
    send({ _tag: "Deep" }, {
      happens: [{ "A.Second.Leaf": {} }],
      log: ["exit Out", "enter A", "enter Second", "enter Leaf"]
    })
  ]
}

const Regions = Machine.events({ Enter: {}, Go: {}, Back: {}, Close: { handled: Schema.Boolean } })

const parallel: Scenario = {
  name: "handles an event in two regions as one step, unless a child stays",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({
        states: {
          Out: {},
          Both: {
            type: "parallel",
            states: {
              left: { states: { A: {}, B: {} } },
              right: { states: { A: {}, B: { fields: { count: Schema.Number } } } }
            }
          }
        }
      }),
      events: Regions
    }).handle({
      initial: { target: "Out" },
      states: {
        Out: { on: { Enter: { target: "Both" } } },
        Both: {
          on: { Close: { target: "Out" } },
          states: {
            left: {
              initial: { target: "Both.left.A" },
              states: {
                A: {
                  on: {
                    Go: { target: "Both.left.B" },
                    Close: {
                      branches: [{ stay: true }, { decline: true }],
                      resolve: ({ event, select }) => event.handled ? select.stay() : select.decline()
                    }
                  }
                },
                B: { entry: () => note("enter left.B"), on: { Back: { target: "Both.left.A" } } }
              }
            },
            right: {
              initial: { target: "Both.right.A" },
              states: {
                A: { on: { Go: { target: "Both.right.B", data: { count: 1 } } } },
                B: {
                  entry: () => note("enter right.B"),
                  on: {
                    Go: { update: { "Both.right.B": ({ state }) => ({ count: state.count + 1 }) } },
                    Back: { target: "Both.right.A" }
                  }
                }
              }
            }
          }
        }
      }
    }),
  start: { happens: [{ Out: {} }] },
  steps: [
    send({ _tag: "Enter" }, { happens: [{ "Both.left.A": {}, "Both.right.A": {} }] }),
    named(
      "go in both regions",
      send({ _tag: "Go" }, {
        happens: [{ "Both.left.B": {}, "Both.right.B": { count: 1 } }],
        log: ["enter left.B", "enter right.B"]
      })
    ),
    named(
      "go in one region",
      send({ _tag: "Go" }, { happens: [{ "Both.left.B": {}, "Both.right.B": { count: 2 } }] })
    ),
    send({ _tag: "Back" }, { happens: [{ "Both.left.A": {}, "Both.right.A": {} }] }),
    named("close, which a child handles by staying", send({ _tag: "Close", handled: true })),
    named(
      "close, which every child leaves to the ancestor",
      send({ _tag: "Close", handled: false }, { happens: [{ Out: {} }] })
    )
  ]
}

const Compete = Machine.events({ Mark: {}, Split: {} })

const competing: Scenario = {
  name: "lets the first of two regions win what both change",
  machine: () =>
    Machine.make({
      root: Machine.state({
        states: {
          Both: {
            fields: { by: Schema.String },
            type: "parallel",
            states: { left: { states: { A: {}, B: {} } }, right: { states: { A: {} } } }
          },
          Out: {}
        }
      }),
      events: Compete
    }).handle({
      initial: { target: "Both", data: { by: "nobody" } },
      states: {
        Both: {
          states: {
            left: {
              initial: { target: "Both.left.A" },
              states: {
                A: {
                  on: {
                    Mark: { update: { Both: () => ({ by: "left" }) } },
                    Split: { target: "Both.left.B" }
                  }
                },
                B: {}
              }
            },
            right: {
              initial: { target: "Both.right.A" },
              states: {
                A: {
                  on: {
                    Mark: { update: { Both: () => ({ by: "right" }) } },
                    Split: { target: "Out" }
                  }
                }
              }
            }
          }
        },
        Out: {}
      }
    }),
  start: { happens: [{ Both: { by: "nobody" }, "Both.left.A": {}, "Both.right.A": {} }] },
  steps: [
    send({ _tag: "Mark" }, { happens: [{ Both: { by: "left" }, "Both.left.A": {}, "Both.right.A": {} }] }),
    send({ _tag: "Split" }, { happens: [{ Both: { by: "left" }, "Both.left.B": {}, "Both.right.A": {} }] })
  ]
}

const Player = Machine.events({ Leave: {}, Shallow: {}, Deep: {}, Next: {}, Later: {} })

const history: Scenario = {
  name: "returns to what shallow and deep history remember",
  machine: ({ note }) => {
    const Root = Machine.state({
      states: {
        Away: {},
        Album: {
          fields: { plays: Schema.Number },
          states: {
            Side: {
              fields: { name: Schema.String },
              states: { First: {}, Second: { fields: { at: Schema.Number } } }
            },
            Cover: {},
            recent: { type: "history" },
            exact: { type: "history", history: "deep" }
          }
        }
      }
    })
    const fallback = () => {
      note("default")
      return {
        path: "" as const,
        value: undefined,
        state: {
          path: "Album" as const,
          value: { _tag: "Album" as const, plays: 0 },
          state: { path: "Album.Cover" as const, value: undefined }
        }
      }
    }
    return Machine.make({ root: Root, events: Player }).handle({
      initial: { target: "Away" },
      states: {
        Away: {
          on: {
            Shallow: {
              branches: [{ history: "Album.recent" }],
              resolve: ({ select }) => select.history("Album.recent")
            },
            Deep: { branches: [{ history: "Album.exact" }], resolve: ({ select }) => select.history("Album.exact") }
          }
        },
        Album: {
          initial: { target: "Album.Cover" },
          history: { recent: { default: fallback }, exact: { default: fallback } },
          on: { Leave: { target: "Away" } },
          states: {
            Cover: { on: { Next: { target: "Album.Side", data: { name: "A" } } } },
            Side: {
              initial: { target: "Album.Side.First" },
              on: {
                Next: { update: { "Album.Side": ({ state }) => ({ name: `${state.name}'` }) } },
                Later: { target: "Album.Side.Second", data: { at: 3 } }
              },
              states: { First: {}, Second: {} }
            }
          }
        }
      }
    })
  },
  start: { happens: [{ Away: {} }] },
  steps: [
    named(
      "history without a record",
      send({ _tag: "Deep" }, { happens: [{ Album: { plays: 0 }, "Album.Cover": {} }], log: ["default"] })
    ),
    named(
      "enter a side",
      send({ _tag: "Next" }, {
        happens: [{ Album: { plays: 0 }, "Album.Side": { name: "A" }, "Album.Side.First": {} }]
      })
    ),
    send({ _tag: "Later" }, {
      happens: [{ Album: { plays: 0 }, "Album.Side": { name: "A" }, "Album.Side.Second": { at: 3 } }]
    }),
    named(
      "rename the side",
      send({ _tag: "Next" }, {
        happens: [{ Album: { plays: 0 }, "Album.Side": { name: "A'" }, "Album.Side.Second": { at: 3 } }]
      })
    ),
    named("leave once", send({ _tag: "Leave" }, { happens: [{ Away: {} }] })),
    named(
      "deep history",
      send({ _tag: "Deep" }, {
        happens: [{ Album: { plays: 0 }, "Album.Side": { name: "A'" }, "Album.Side.Second": { at: 3 } }]
      })
    ),
    named("leave twice", send({ _tag: "Leave" }, { happens: [{ Away: {} }] })),
    named(
      "shallow history",
      send({ _tag: "Shallow" }, {
        happens: [{ Album: { plays: 0 }, "Album.Side": { name: "A'" }, "Album.Side.First": {} }]
      })
    )
  ]
}

const Score = Machine.events({ Bump: {}, Keep: {}, Reset: {} })

const choice: Scenario = {
  name: "routes through choices without settling in one",
  machine: () =>
    Machine.make({
      root: Machine.state({
        states: {
          Flow: {
            fields: { count: Schema.Number },
            states: {
              Start: { type: "choice" },
              First: { type: "choice" },
              Second: { type: "choice" },
              Even: {},
              Odd: {}
            }
          }
        }
      }),
      events: Score
    }).handle({
      initial: { target: "Flow", data: { count: 0 } },
      states: {
        Flow: {
          on: { Reset: { update: { Flow: () => ({ count: 0 }) } } },
          initial: { target: "Flow.Start" },
          states: {
            Start: {
              choice: { branches: [{ target: "Flow.First" }], resolve: ({ select }) => select.target("Flow.First") }
            },
            First: {
              choice: { branches: [{ target: "Flow.Second" }], resolve: ({ select }) => select.target("Flow.Second") }
            },
            Second: {
              choice: {
                branches: [{ target: "Flow.Even" }, { target: "Flow.Odd" }],
                resolve: ({ containingState, select }) =>
                  containingState.count % 2 === 0 ? select.target("Flow.Even") : select.target("Flow.Odd")
              }
            },
            Even: {
              on: {
                Bump: {
                  target: "Flow.First",
                  update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 }) }
                },
                Keep: {
                  target: "Flow.First",
                  update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 2 }) },
                  reenter: true
                }
              }
            },
            Odd: {
              on: {
                Bump: {
                  target: "Flow.First",
                  update: { Flow: ({ ancestors }) => ({ count: ancestors.Flow.count + 1 }) }
                }
              }
            }
          }
        }
      }
    }),
  start: { happens: [{ Flow: { count: 0 }, "Flow.Even": {} }] },
  steps: [
    named("bump to odd", send({ _tag: "Bump" }, { happens: [{ Flow: { count: 1 }, "Flow.Odd": {} }] })),
    named("bump to even", send({ _tag: "Bump" }, { happens: [{ Flow: { count: 2 }, "Flow.Even": {} }] })),
    send({ _tag: "Keep" }, { happens: [{ Flow: { count: 4 }, "Flow.Even": {} }] }),
    send({ _tag: "Reset" }, { happens: [{ Flow: { count: 0 }, "Flow.Even": {} }] }),
    named("bump again", send({ _tag: "Bump" }, { happens: [{ Flow: { count: 1 }, "Flow.Odd": {} }] }))
  ]
}

const Chain = Machine.events({ Go: {}, Fill: {} })

const eventless: Scenario = {
  name: "settles after the eventless and completion transitions of a step",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({
        fields: { level: Schema.Number },
        states: {
          Idle: {},
          Passing: {},
          Work: { states: { Busy: {}, Done: { type: "final", output: Schema.String } } },
          Both: {
            type: "parallel",
            states: {
              left: { states: { Busy: {}, Done: { type: "final" } } },
              right: { states: { Done: { type: "final" } } }
            }
          },
          Ready: {}
        }
      }),
      events: Chain
    }).handle({
      root: () => ({ level: 0 }),
      initial: { target: "Idle" },
      on: { Fill: { update: { root: ({ root }) => ({ level: root.level + 1 }) } } },
      states: {
        Idle: {
          // Enabled by a change of the root alone.
          always: { guard: ({ root }) => root.level > 1, target: "Passing" }
        },
        Passing: {
          entry: () => note("enter Passing"),
          exit: () => note("exit Passing"),
          always: { target: "Work" }
        },
        Work: {
          initial: { target: "Work.Busy" },
          onDone: {
            branches: [{ target: "Both" }],
            resolve: ({ output, select }) => {
              note(`output ${output}`)
              return select.target("Both")
            }
          },
          states: { Busy: { on: { Go: { target: "Work.Done" } } }, Done: { output: () => "worked" } }
        },
        Both: {
          onDone: { target: "Ready" },
          states: {
            left: {
              initial: { target: "Both.left.Busy" },
              states: { Busy: { on: { Go: { target: "Both.left.Done" } } }, Done: {} }
            },
            right: { initial: { target: "Both.right.Done" }, states: { Done: {} } }
          }
        },
        Ready: {}
      }
    }),
  start: { happens: [{ "": { level: 0 }, Idle: {} }] },
  steps: [
    named("fill without passing", send({ _tag: "Fill" }, { happens: [{ "": { level: 1 }, Idle: {} }] })),
    named(
      "fill, which passes a state",
      send({ _tag: "Fill" }, {
        happens: [{ "": { level: 2 }, "Work.Busy": {} }],
        log: ["enter Passing", "exit Passing"]
      })
    ),
    named(
      "complete a compound state",
      send({ _tag: "Go" }, {
        happens: [{ "": { level: 2 }, "Both.left.Busy": {}, "Both.right.Done": {} }],
        log: ["output worked"]
      })
    ),
    named("complete the last region", send({ _tag: "Go" }, { happens: [{ "": { level: 2 }, Ready: {} }] }))
  ]
}

const Begin = Machine.events({ Begin: {}, Keep: {}, Set: { value: Schema.Number }, Again: {} })
const Raised = Machine.internalEvents({ One: {}, Two: {} })
const Noted = Machine.emittedEvents({ Noted: { label: Schema.String } })

const raised: Scenario = {
  name: "plans raised events in the step that raises them, in order",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Working: {}, Finished: {} } }),
      events: Begin,
      internalEvents: Raised
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: {
          exit: () => note("exit Idle"),
          on: {
            Begin: {
              branches: [{ target: "Working" }],
              resolve: ({ select }, enqueue) => {
                note("begin")
                enqueue.raise(Raised.One())
                return select.target("Working")
              }
            }
          }
        },
        Working: {
          entry: (_, enqueue) => {
            note("enter Working")
            enqueue.raise(Raised.Two())
          },
          on: {
            One: { stay: true, commands: () => note("one") },
            Two: { target: "Finished", commands: () => note("two") }
          }
        },
        Finished: { entry: () => note("enter Finished") }
      }
    }),
  start: { happens: [{ Idle: {} }] },
  steps: [
    send({ _tag: "Begin" }, {
      happens: [{ Finished: {} }],
      log: ["begin", "exit Idle", "enter Working", "one", "two", "enter Finished"]
    })
  ]
}

const emissions: Scenario = {
  name: "emits the events of every kind of transition, in order",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Working: { fields: { value: Schema.Number } } } }),
      events: Begin,
      internalEvents: Raised,
      emittedEvents: Noted
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: {
            Begin: {
              target: "Working",
              data: { value: 0 },
              commands: (_, enqueue) => {
                enqueue.emit(Noted.Noted({ label: "begin" }))
                enqueue.raise(Raised.One())
              }
            }
          }
        },
        Working: {
          entry: (_, enqueue) => {
            enqueue.emit(Noted.Noted({ label: "enter" }))
          },
          on: {
            One: { stay: true, commands: (_, enqueue) => enqueue.emit(Noted.Noted({ label: "raised" })) },
            Keep: { stay: true, commands: (_, enqueue) => enqueue.emit(Noted.Noted({ label: "keep" })) },
            Set: {
              update: { Working: ({ event }) => ({ value: event.value }) },
              commands: ({ event }, enqueue) => enqueue.emit(Noted.Noted({ label: `set ${event.value}` }))
            },
            Again: { reenter: true, commands: (_, enqueue) => enqueue.emit(Noted.Noted({ label: "again" })) }
          }
        }
      }
    }),
  start: { happens: [{ Idle: {} }] },
  steps: [
    send({ _tag: "Begin" }, {
      happens: [{ Working: { value: 0 } }],
      emits: [
        { _tag: "Noted", label: "begin" },
        { _tag: "Noted", label: "enter" },
        { _tag: "Noted", label: "raised" }
      ]
    }),
    send({ _tag: "Keep" }, { emits: [{ _tag: "Noted", label: "keep" }] }),
    send({ _tag: "Set", value: 7 }, {
      happens: [{ Working: { value: 7 } }],
      emits: [{ _tag: "Noted", label: "set 7" }]
    }),
    send({ _tag: "Again" }, {
      emits: [{ _tag: "Noted", label: "again" }, { _tag: "Noted", label: "enter" }]
    })
  ]
}

const Finish = Machine.events({ Finish: { reason: Schema.String }, Note: {} })

const finalState: Scenario = {
  name: "ends in a final state with its output, and takes no event after it",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({
        states: {
          Open: {},
          Closed: { fields: { reason: Schema.String }, type: "final", output: Schema.String }
        }
      }),
      events: Finish
    }).handle({
      initial: { target: "Open" },
      states: {
        Open: {
          exit: () => note("exit Open"),
          on: { Finish: { target: "Closed", data: ({ event }) => ({ reason: event.reason }) } }
        },
        Closed: {
          entry: () => note("enter Closed"),
          output: ({ state }) => {
            note("output")
            return `closed: ${state.reason}`
          }
        }
      }
    }),
  start: { happens: [{ Open: {} }] },
  steps: [
    send({ _tag: "Finish", reason: "late" }, {
      happens: [{ Closed: { reason: "late" } }],
      log: ["exit Open", "enter Closed", "output"],
      outcome: final("closed: late")
    }),
    named("event after the end", send({ _tag: "Note" }, { answers: ["Ended"] }))
  ]
}

const initiallyFinal: Scenario = {
  name: "ends at once when its initial state is final",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Closed: { type: "final", output: Schema.String } } }),
      events: Finish
    }).handle({ initial: { target: "Closed" }, states: { Closed: { output: () => "nothing to do" } } }),
  start: { happens: [{ Closed: {} }], outcome: final("nothing to do") },
  steps: [send({ _tag: "Note" }, { answers: ["Ended"] })]
}

const initialState: Scenario = {
  name: "settles in its initial state before any event",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({ states: { Passing: {}, Idle: { fields: { ready: Schema.Boolean } } } }),
      events: Finish
    }).handle({
      initial: { target: "Passing" },
      states: {
        Passing: { entry: () => note("enter Passing"), always: { target: "Idle", data: { ready: true } } },
        Idle: { entry: () => note("enter Idle") }
      }
    }),
  start: { happens: [{ Idle: { ready: true } }], log: ["enter Passing", "enter Idle"] },
  steps: [send({ _tag: "Note" })]
}

const input: Scenario = {
  name: "starts from its input",
  machine: () =>
    Machine.make({
      root: Machine.state({ fields: { owner: Schema.String }, states: { Idle: { fields: { name: Schema.String } } } }),
      events: Finish,
      input: Schema.Struct({ owner: Schema.String })
    }).handle({
      root: ({ input }) => ({ owner: input.owner }),
      initial: { target: "Idle", data: ({ root }) => ({ name: `${root.owner}'s` }) },
      on: { Finish: { update: { root: ({ event }) => ({ owner: event.reason }) } } },
      states: { Idle: {} }
    }),
  input: { owner: "ada" },
  start: { happens: [{ "": { owner: "ada" }, Idle: { name: "ada's" } }] },
  steps: [send({ _tag: "Finish", reason: "bob" }, { happens: [{ "": { owner: "bob" }, Idle: { name: "ada's" } }] })]
}

const Typed = Machine.events({ Set: { value: Schema.NonEmptyString } })

const eventPayload: Scenario = {
  name: "refuses the payload of an event that its schema refuses",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Count: { fields: { length: Schema.Number } } } }),
      events: Typed
    }).handle({
      initial: { target: "Count", data: { length: 0 } },
      states: { Count: { on: { Set: { target: "Count", data: ({ event }) => ({ length: event.value.length }) } } } }
    }),
  start: { happens: [{ Count: { length: 0 } }] },
  steps: [
    named("a valid payload", send({ _tag: "Set", value: "ok" }, { happens: [{ Count: { length: 2 } }] })),
    named(
      "an invalid payload",
      send({ _tag: "Set", value: "" }, {
        outcome: failed("MachineSchemaDecodeError: {\"boundary\":\"event\",\"event\":\"Set\"}")
      })
    ),
    named("an event after it", send({ _tag: "Set", value: "later" }, { answers: ["Ended"] }))
  ]
}

const Break = Machine.events({ Throw: {}, Loop: {}, Invalid: {}, Emit: {}, Note: {} })

const breaks = (
  name: string,
  event: Event,
  failure: string
): Scenario => ({
  name,
  machine: () =>
    Machine.make({
      root: Machine.state({
        states: {
          Idle: { fields: { notes: Schema.Number } },
          Busy: { fields: { size: Schema.Number } },
          Ping: {},
          Pong: {}
        }
      }),
      events: Break,
      emittedEvents: Noted
    }).handle({
      initial: { target: "Idle", data: { notes: 0 } },
      states: {
        Idle: {
          on: {
            Note: { update: { Idle: ({ state }) => ({ notes: state.notes + 1 }) } },
            Throw: {
              branches: [{ target: "Ping" }],
              resolve: ({ select, state }) => {
                if (state.notes > 0) throw new Error("cannot leave")
                return select.target("Ping")
              }
            },
            Loop: { target: "Ping" },
            Invalid: { target: "Busy", data: () => ({ size: "large" as never }) },
            Emit: { stay: true, commands: (_, enqueue) => enqueue.emit({ _tag: "Noted", label: 1 } as never) }
          }
        },
        Busy: {},
        Ping: { always: { target: "Pong" } },
        Pong: { always: { target: "Ping" } }
      }
    }),
  start: { happens: [{ Idle: { notes: 0 } }] },
  steps: [
    named("an event that works", send({ _tag: "Note" }, { happens: [{ Idle: { notes: 1 } }] })),
    named("the event that cannot be applied", send(event, { outcome: failed(failure) })),
    named("an event after it", send({ _tag: "Note" }, { answers: ["Ended"] }))
  ]
})

const initialFailure: Scenario = {
  name: "cannot settle in its initial state",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Idle: { fields: { size: Schema.Number } } } }),
      events: Finish
    }).handle({ initial: { target: "Idle", data: () => ({ size: "large" as never }) }, states: { Idle: {} } }),
  start: { outcome: failed("MachineSchemaDecodeError: {\"boundary\":\"state\",\"state\":\"Idle\"}") },
  steps: [send({ _tag: "Note" }, { answers: ["Ended"] })]
}

const burst: Scenario = {
  name: "handles the events of one sender in the order they were sent",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Log: { fields: { entries: Schema.String } } } }),
      events: Machine.events({ Open: {}, Write: { entry: Schema.String } })
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Open: { target: "Log", data: { entries: "" } } } },
        Log: { on: { Write: { update: { Log: ({ event, state }) => ({ entries: state.entries + event.entry }) } } } }
      }
    }),
  start: { happens: [{ Idle: {} }] },
  steps: [
    send({ _tag: "Open" }, { happens: [{ Log: { entries: "" } }] }),
    atOnce([
      send({ _tag: "Write", entry: "a" }),
      send({ _tag: "Write", entry: "b" }),
      send({ _tag: "Write", entry: "c" })
    ], { happens: [{ Log: { entries: "a" } }, { Log: { entries: "ab" } }, { Log: { entries: "abc" } }] })
  ]
}

class Booked extends Schema.TaggedClass<Booked>("ConformanceBooked")("Booked", {
  seats: Schema.NumberFromString
}) {}
class Book extends Schema.TaggedClass<Book>("ConformanceBook")("Book", {
  seats: Schema.NumberFromString
}) {}

const classes: Scenario = {
  name: "carries class instances and transformed fields in events and states",
  machine: ({ note }) =>
    Machine.make({
      root: Machine.state({ states: { Open: {}, Booked } }),
      events: Machine.eventsFromSchemas(Book)
    }).handle({
      initial: { target: "Open" },
      states: {
        Open: {
          on: {
            Book: {
              target: "Booked",
              decoded: true,
              data: ({ event }) => {
                note(`${event instanceof Book} ${typeof event.seats}`)
                return new Booked({ seats: event.seats })
              }
            }
          }
        },
        Booked: {
          on: {
            Book: {
              target: "Booked",
              decoded: true,
              data: ({ event, state }) => {
                note(`${state instanceof Booked} ${typeof state.seats}`)
                return new Booked({ seats: state.seats + event.seats })
              }
            }
          }
        }
      }
    }),
  start: { happens: [{ Open: {} }] },
  steps: [
    named("book", send(new Book({ seats: 2 }), { happens: [{ Booked: { seats: "2" } }], log: ["true number"] })),
    named("book more", send(new Book({ seats: 3 }), { happens: [{ Booked: { seats: "5" } }], log: ["true number"] }))
  ]
}

const knowsItself: Scenario = {
  name: "names itself to its transitions and to its work",
  machine: (fixture) =>
    Machine.make({
      id: "Named",
      root: Machine.state({ states: { Idle: {}, Working: {} } }),
      events: Machine.events({ Go: {} }),
      effects: { work: (id: string) => fixture.work("work", id) }
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: { on: { Go: { target: "Working", commands: ({ self }) => fixture.note(`transition of ${self.id}`) } } },
        Working: {
          entry: ({ self }) => fixture.note(`entry of ${self.id}`),
          invoke: { src: "work", input: ({ self }) => self.id, onDone: { stay: true }, onFailure: { stay: true } }
        }
      }
    }),
  start: { happens: [{ Idle: {} }] },
  steps: [
    send({ _tag: "Go" }, {
      happens: [{ Working: {} }, started("work", "Named")],
      log: ["transition of Named", "entry of Named"]
    })
  ]
}

const sendsCommand: Scenario = {
  name: "takes the event that its own command sends to it, in a later step",
  machine: () =>
    Machine.make({
      root: Machine.state({ states: { Idle: {}, Asked: {}, Answered: {} } }),
      events: Machine.events({ Ask: {}, Answer: {} })
    }).handle({
      initial: { target: "Idle" },
      states: {
        Idle: {
          on: { Ask: { target: "Asked", commands: ({ self }, enqueue) => enqueue.sendTo(self, { _tag: "Answer" }) } }
        },
        Asked: { on: { Answer: { target: "Answered" } } },
        Answered: {}
      }
    }),
  needs: ["Commands"],
  start: { happens: [{ Idle: {} }] },
  steps: [send({ _tag: "Ask" }, { happens: [{ Asked: {} }, { Answered: {} }] })]
}

const constructed: Scenario = {
  name: "takes an event that a constructor of its protocol built",
  machine: moves.machine,
  start: moves.start,
  steps: [
    send(Document.Open({ id: "a" }), { happens: [{ Open: { id: "a" } }] }),
    send(Document.Close(), { happens: [{ Closed: {} }] })
  ]
}

export const transitions: ReadonlyArray<Scenario> = [
  initialState,
  input,
  moves,
  constructed,
  unhandled,
  declines,
  retained,
  compound,
  parallel,
  competing,
  history,
  choice,
  eventless,
  raised,
  emissions,
  finalState,
  initiallyFinal,
  eventPayload,
  breaks("a transition throws", { _tag: "Throw" }, "Error: cannot leave"),
  breaks(
    "a step never settles",
    { _tag: "Loop" },
    "InfiniteTransitionError: {\"state\":\"Ping\",\"maxIterations\":1000}"
  ),
  breaks(
    "a transition leads to a state that its schema refuses",
    { _tag: "Invalid" },
    "MachineSchemaDecodeError: {\"boundary\":\"state\",\"state\":\"Busy\"}"
  ),
  breaks(
    "a transition emits an event that its schema refuses",
    { _tag: "Emit" },
    "MachineSchemaDecodeError: {\"boundary\":\"emission\",\"event\":\"Noted\"}"
  ),
  initialFailure,
  burst,
  classes,
  knowsItself,
  sendsCommand
]
