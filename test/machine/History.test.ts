import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Fiber, Schema, Stream } from "effect"
import { Machine } from "../../src/index.js"

class Checkout extends Schema.TaggedClass<Checkout>("Checkout")("Checkout", {
  orderId: Schema.String
}) {}
class Shipping extends Schema.TaggedClass<Shipping>("Shipping")("Shipping", {
  address: Schema.String
}) {}
class Payment extends Schema.TaggedClass<Payment>("Payment")("Payment", {
  attempt: Schema.Number
}) {}
class CardEntry extends Schema.TaggedClass<CardEntry>("CardEntry")("CardEntry", {
  cardNumber: Schema.String
}) {}
class Verifying extends Schema.TaggedClass<Verifying>("Verifying")("Verifying", {
  challengeId: Schema.String
}) {}
class Support extends Schema.TaggedClass<Support>("Support")("Support", {
  ticket: Schema.String
}) {}

class Leave extends Schema.TaggedClass<Leave>("Leave")("Leave", {}) {}
class ResumeShallow extends Schema.TaggedClass<ResumeShallow>("ResumeShallow")("ResumeShallow", {}) {}
class ResumeDeep extends Schema.TaggedClass<ResumeDeep>("ResumeDeep")("ResumeDeep", {}) {}
class GoShipping extends Schema.TaggedClass<GoShipping>("GoShipping")("GoShipping", {
  address: Schema.String
}) {}
class EnterVerifying extends Schema.TaggedClass<EnterVerifying>("EnterVerifying")("EnterVerifying", {}) {}
class ReenterHistory extends Schema.TaggedClass<ReenterHistory>("ReenterHistory")("ReenterHistory", {}) {}

class Workspace extends Schema.TaggedClass<Workspace>("Workspace")("Workspace", {
  id: Schema.String
}) {}
class Editor extends Schema.TaggedClass<Editor>("Editor")("Editor", {
  documentId: Schema.String
}) {}
class Writing extends Schema.TaggedClass<Writing>("Writing")("Writing", {
  draft: Schema.String
}) {}
class Preview extends Schema.TaggedClass<Preview>("Preview")("Preview", {
  page: Schema.Number
}) {}
class Sidebar extends Schema.TaggedClass<Sidebar>("Sidebar")("Sidebar", {
  width: Schema.Number
}) {}
class Files extends Schema.TaggedClass<Files>("Files")("Files", {
  directory: Schema.String
}) {}
class Search extends Schema.TaggedClass<Search>("Search")("Search", {
  query: Schema.String
}) {}
class Away extends Schema.TaggedClass<Away>("Away")("Away", {}) {}

class LeaveWorkspace extends Schema.TaggedClass<LeaveWorkspace>("LeaveWorkspace")("LeaveWorkspace", {}) {}
class ResumeWorkspaceShallow extends Schema.TaggedClass<ResumeWorkspaceShallow>("ResumeWorkspaceShallow")(
  "ResumeWorkspaceShallow",
  {}
) {}
class ResumeWorkspaceDeep extends Schema.TaggedClass<ResumeWorkspaceDeep>("ResumeWorkspaceDeep")(
  "ResumeWorkspaceDeep",
  {}
) {}
class RestoreEditor extends Schema.TaggedClass<RestoreEditor>("RestoreEditor")("RestoreEditor", {}) {}
class DefaultEditor extends Schema.TaggedClass<DefaultEditor>("DefaultEditor")("DefaultEditor", {}) {}

const CheckoutStates = Machine.states({
  checkout: {
    schema: Checkout,
    initial: "shipping",
    states: {
      shipping: Shipping,
      payment: {
        schema: Payment,
        initial: "cardEntry",
        states: {
          cardEntry: CardEntry,
          verifying: Verifying
        }
      },
      recent: {
        type: "history"
      },
      exact: {
        type: "history",
        history: "deep"
      }
    }
  },
  support: Support
})

const checkoutPaymentVerifying = (
  orderId: string,
  attempt: number,
  challengeId: string
): Machine.Machine.Snapshot<typeof CheckoutStates.states> => ({
  path: "checkout" as const,
  value: new Checkout({ orderId }),
  state: {
    path: "checkout.payment" as const,
    value: new Payment({ attempt }),
    state: {
      path: "checkout.payment.verifying" as const,
      value: new Verifying({ challengeId })
    }
  }
})

const checkoutShipping = (orderId: string, address: string) => ({
  path: "checkout" as const,
  value: new Checkout({ orderId }),
  state: { path: "checkout.shipping" as const, value: new Shipping({ address }) }
})

const makeCheckoutMachine = (
  initial: Machine.Machine.Snapshot<typeof CheckoutStates.states>,
  onInitialize?: () => void,
  lifecycle?: Array<string>,
  onDefault?: () => void,
  exactDefault?: () => ReturnType<typeof checkoutShipping>
) =>
  Machine.make({
    states: CheckoutStates.states,
    events: Machine.events(Leave, ResumeShallow, ResumeDeep, GoShipping, EnterVerifying, ReenterHistory),
    initial: ((to: any) =>
      initial.path === "checkout"
        ? to.checkout.initial.resolve(({ target }: any) =>
          target(
            new Checkout({ orderId: "initial" }),
            (checkout: any) => checkout.shipping(new Shipping({ address: "initial" }))
          )
        )
        : to.support().resolve(() => initial)) as any
  }).handle({
    checkout: {
      entry: () => {
        lifecycle?.push("entry:checkout")
      },
      exit: () => {
        lifecycle?.push("exit:checkout")
      },
      history: {
        recent: {
          default: () => {
            onDefault?.()
            return checkoutShipping("fallback-order", "fallback-address")
          }
        },
        exact: {
          default: exactDefault ?? (() => {
            onDefault?.()
            return checkoutShipping("fallback-order", "fallback-address")
          })
        }
      },
      on: {
        Leave: (to) => to.full.support().resolve(({ target }) => target(new Support({ ticket: "ticket-1" }))),
        GoShipping: (to) =>
          to.local.shipping().resolve(({ event, target }) => target(new Shipping({ address: event.address }))),
        ReenterHistory: (to) => to.history.checkout.exact.resolve(({ target }) => target(), { reenter: true })
      },
      states: {
        shipping: {
          on: {
            EnterVerifying: (to) =>
              to.local.payment().resolve(({ target }) =>
                target(
                  new Payment({ attempt: 2 }),
                  (payment) => payment.verifying(new Verifying({ challengeId: "challenge-7" }))
                )
              )
          }
        },
        payment: {
          entry: () => {
            lifecycle?.push("entry:payment")
          },
          exit: () => {
            lifecycle?.push("exit:payment")
          },
          initialize: ({ state, builder }) => {
            onInitialize?.()
            return builder(new CardEntry({ cardNumber: `fresh-${state.attempt}` }))
          },
          states: {
            verifying: {
              entry: () => {
                lifecycle?.push("entry:verifying")
              },
              exit: () => {
                lifecycle?.push("exit:verifying")
              }
            }
          }
        }
      }
    },
    support: {
      entry: () => {
        lifecycle?.push("entry:support")
      },
      exit: () => {
        lifecycle?.push("exit:support")
      },
      on: {
        ResumeShallow: (to) => to.history.checkout.recent.resolve(({ target }) => target()),
        ResumeDeep: (to) => to.history.checkout.exact.resolve(({ target }) => target())
      }
    }
  })

const waitForPath = <State, Event, Error, Output>(
  actor: Machine.MachineRef<State, Event, Error, Output>,
  path: string
) =>
  actor.changes.pipe(
    Stream.filter((snapshot) => snapshot.status === "active" && hasPath(snapshot.state, path)),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((snapshots) => Array.from(snapshots)[0]!)
  )

const hasPath = (snapshot: unknown, path: string): boolean => {
  if (typeof snapshot !== "object" || snapshot === null) return false
  const value = snapshot as any
  if (value.path === path) return true
  if (value.state !== undefined && hasPath(value.state, path)) return true
  return value.states !== undefined && Object.values(value.states).some((child) => hasPath(child, path))
}

const sendAndWaitForPath = <State, Event, Error, Output>(
  actor: Machine.MachineRef<State, Event, Error, Output>,
  event: Event,
  path: string
) =>
  Effect.gen(function*() {
    const observer = yield* waitForPath(actor, path).pipe(Effect.forkChild)
    yield* actor.send(event)
    return yield* Fiber.join(observer)
  })

const WorkspaceStates = Machine.states({
  workspace: {
    schema: Workspace,
    type: "parallel",
    states: {
      editor: {
        schema: Editor,
        initial: "writing",
        states: {
          writing: Writing,
          preview: Preview
        }
      },
      sidebar: {
        schema: Sidebar,
        initial: "files",
        states: {
          files: Files,
          search: Search
        }
      },
      recent: {
        type: "history"
      },
      exact: {
        type: "history",
        history: "deep"
      }
    }
  },
  away: Away
})

const activeWorkspace: Machine.Machine.Snapshot<typeof WorkspaceStates.states> = {
  path: "workspace" as const,
  value: new Workspace({ id: "workspace-1" }),
  states: {
    editor: {
      path: "workspace.editor" as const,
      value: new Editor({ documentId: "document-1" }),
      state: {
        path: "workspace.editor.preview" as const,
        value: new Preview({ page: 4 })
      }
    },
    sidebar: {
      path: "workspace.sidebar" as const,
      value: new Sidebar({ width: 320 }),
      state: {
        path: "workspace.sidebar.search" as const,
        value: new Search({ query: "history" })
      }
    }
  }
}

const makeWorkspaceMachine = (initialized: Array<string>) =>
  Machine.make({
    states: WorkspaceStates.states,
    events: Machine.events(LeaveWorkspace, ResumeWorkspaceShallow, ResumeWorkspaceDeep),
    initial: (to) =>
      to.workspace.initial.resolve(({ target }) =>
        target(new Workspace({ id: "initial" }), (workspace) =>
          workspace
            .editor(new Editor({ documentId: "initial" }), (editor) => editor.writing(new Writing({ draft: "" })))
            .sidebar(new Sidebar({ width: 0 }), (sidebar) => sidebar.files(new Files({ directory: "/" }))))
      )
  }).handle({
    workspace: {
      history: {
        recent: {
          default: ({ target }) =>
            target.workspace(
              new Workspace({ id: "fallback" }),
              (workspace) =>
                workspace
                  .editor(
                    new Editor({ documentId: "fallback" }),
                    (editor) => editor.writing(new Writing({ draft: "" }))
                  )
                  .sidebar(
                    new Sidebar({ width: 200 }),
                    (sidebar) => sidebar.files(new Files({ directory: "/" }))
                  )
            )
        },
        exact: {
          default: ({ target }) =>
            target.workspace(
              new Workspace({ id: "fallback" }),
              (workspace) =>
                workspace
                  .editor(
                    new Editor({ documentId: "fallback" }),
                    (editor) => editor.writing(new Writing({ draft: "" }))
                  )
                  .sidebar(
                    new Sidebar({ width: 200 }),
                    (sidebar) => sidebar.files(new Files({ directory: "/" }))
                  )
            )
        }
      },
      on: {
        LeaveWorkspace: (to) => to.full.away().resolve(({ target }) => target(new Away({})))
      },
      states: {
        editor: {
          initialize: ({ state, builder }) => {
            initialized.push("editor")
            return builder(new Writing({ draft: `fresh:${state.documentId}` }))
          }
        },
        sidebar: {
          initialize: ({ state, builder }) => {
            initialized.push("sidebar")
            return builder(new Files({ directory: `/fresh/${state.width}` }))
          }
        }
      }
    },
    away: {
      on: {
        ResumeWorkspaceShallow: (to) => to.history.workspace.recent.resolve(({ target }) => target()),
        ResumeWorkspaceDeep: (to) => to.history.workspace.exact.resolve(({ target }) => target())
      }
    }
  })

const NestedHistoryStates = Machine.states({
  workspace: {
    schema: Workspace,
    type: "parallel",
    states: {
      editor: {
        schema: Editor,
        initial: "writing",
        states: {
          writing: Writing,
          preview: Preview,
          exact: {
            type: "history",
            history: "deep"
          }
        }
      },
      sidebar: Search
    }
  }
})

const nestedParallelSnapshot: Machine.Machine.Snapshot<typeof NestedHistoryStates.states> = {
  path: "workspace" as const,
  value: new Workspace({ id: "workspace-1" }),
  states: {
    editor: {
      path: "workspace.editor" as const,
      value: new Editor({ documentId: "document-1" }),
      state: {
        path: "workspace.editor.preview" as const,
        value: new Preview({ page: 4 })
      }
    },
    sidebar: {
      path: "workspace.sidebar" as const,
      value: new Search({ query: "untouched" })
    }
  }
}

const nestedHistoryMachine = Machine.make({
  states: NestedHistoryStates.states,
  events: Machine.events(RestoreEditor, DefaultEditor),
  initial: (to) =>
    to.workspace.initial.resolve(({ target }) =>
      target(
        new Workspace({ id: "workspace-1" }),
        (workspace) =>
          workspace
            .editor(
              new Editor({ documentId: "document-1" }),
              (editor) => editor.writing(new Writing({ draft: "" }))
            )
            .sidebar(new Search({ query: "untouched" }))
      )
    )
}).handle({
  workspace: {
    states: {
      editor: {
        history: {
          exact: {
            default: ({ target }) =>
              target.workspace(
                new Workspace({ id: "fallback-workspace" }),
                (workspace) =>
                  workspace
                    .editor(
                      new Editor({ documentId: "fallback" }),
                      (editor) => editor.writing(new Writing({ draft: "" }))
                    )
                    .sidebar(new Search({ query: "fallback" }))
              )
          }
        },
        states: {
          preview: {
            on: {
              RestoreEditor: (to) =>
                to.history.workspace.editor.exact.resolve(({ target }) => target(), { reenter: true }),
              DefaultEditor: (to) => to.history.workspace.editor.exact.resolve(({ target }) => target())
            }
          },
          writing: {
            on: {
              DefaultEditor: (to) => to.history.workspace.editor.exact.resolve(({ target }) => target())
            }
          }
        }
      }
    }
  }
})

describe("Machine history states", () => {
  it.effect("uses the typed default before a history record exists", () =>
    Effect.gen(function*() {
      let initialized = 0
      const machine = makeCheckoutMachine(
        { path: "support" as const, value: new Support({ ticket: "new" }) },
        () => initialized++
      )

      const initial = yield* Machine.planInitial(machine)
      const resumed = yield* Machine.plan(machine, initial.state, new ResumeDeep({}))

      assert.deepStrictEqual(resumed.next, checkoutShipping("fallback-order", "fallback-address"))
      assert.strictEqual(resumed.microsteps[0]?.transitions[0]?.target, "checkout.exact")
      assert.strictEqual(resumed.microsteps[0]?.transitions[0]?.resolvedTarget, "checkout")
      assert.strictEqual(initialized, 0)
    }))

  it.effect("deep history restores exact values and is overwritten rather than consumed or stacked", () =>
    Effect.gen(function*() {
      const original = checkoutPaymentVerifying("order-1", 2, "challenge-7")
      const machine = makeCheckoutMachine(original)

      const firstLeave = yield* Machine.plan(machine, original, new Leave({}))
      assert.deepStrictEqual(Object.keys(firstLeave.next.history ?? {}).sort(), [
        "checkout.exact",
        "checkout.recent"
      ])

      const exact = yield* Machine.plan(machine, firstLeave.next, new ResumeDeep({}))
      assert.strictEqual(exact.microsteps[0]?.transitions[0]?.target, "checkout.exact")
      assert.strictEqual(exact.microsteps[0]?.transitions[0]?.resolvedTarget, "checkout")
      assert.strictEqual(exact.next.path, original.path)
      assert.deepStrictEqual(exact.next.value, original.value)
      assert.deepStrictEqual((exact.next as any).state, (original as any).state)
      assert.deepStrictEqual(exact.next.history, firstLeave.next.history)

      const shipping = yield* Machine.plan(machine, exact.next, new GoShipping({ address: "Second Street" }))
      const secondLeave = yield* Machine.plan(machine, shipping.next, new Leave({}))
      const resumedOnce = yield* Machine.plan(machine, secondLeave.next, new ResumeDeep({}))
      assert.strictEqual(resumedOnce.next.path, "checkout")
      assert.deepStrictEqual((resumedOnce.next as any).state, {
        path: "checkout.shipping" as const,
        value: new Shipping({ address: "Second Street" })
      })

      const thirdLeave = yield* Machine.plan(machine, resumedOnce.next, new Leave({}))
      const resumedTwice = yield* Machine.plan(machine, thirdLeave.next, new ResumeDeep({}))
      assert.deepStrictEqual((resumedTwice.next as any).state, (resumedOnce.next as any).state)
    }))

  it.effect("shallow history retains parent and direct-child values and freshly initializes descendants", () =>
    Effect.gen(function*() {
      let initialized = 0
      const original = checkoutPaymentVerifying("order-1", 3, "challenge-7")
      const machine = makeCheckoutMachine(original, () => initialized++)

      const left = yield* Machine.plan(machine, original, new Leave({}))
      const resumed = yield* Machine.plan(machine, left.next, new ResumeShallow({}))

      assert.strictEqual(resumed.microsteps[0]?.transitions[0]?.target, "checkout.recent")
      assert.strictEqual(resumed.microsteps[0]?.transitions[0]?.resolvedTarget, "checkout")
      assert.strictEqual(initialized, 1)
      assert.deepStrictEqual(resumed.next.value, new Checkout({ orderId: "order-1" }))
      assert.deepStrictEqual((resumed.next as any).state.value, new Payment({ attempt: 3 }))
      assert.deepStrictEqual((resumed.next as any).state.state, {
        path: "checkout.payment.cardEntry" as const,
        value: new CardEntry({ cardNumber: "fresh-3" })
      })

      const leftAgain = yield* Machine.plan(machine, resumed.next, new Leave({}))
      const resumedAgain = yield* Machine.plan(machine, leftAgain.next, new ResumeShallow({}))
      assert.strictEqual(initialized, 2)
      assert.deepStrictEqual((resumedAgain.next as any).state.state.value, new CardEntry({ cardNumber: "fresh-3" }))
    }))

  it.effect("round-trips history and rejects corrupted remembered paths and values", () =>
    Effect.gen(function*() {
      const original = checkoutPaymentVerifying("order-1", 2, "challenge-7")
      const machine = makeCheckoutMachine(original)
      const left = yield* Machine.plan(machine, original, new Leave({}))

      const encoded = yield* Machine.encodeSnapshot(machine, left.next)
      const decoded = yield* Machine.decodeSnapshot(machine, JSON.parse(JSON.stringify(encoded)))
      assert.deepStrictEqual(decoded, left.next)
      assert.instanceOf(decoded.history?.["checkout.exact"]?.values["checkout"], Checkout)
      assert.instanceOf(decoded.history?.["checkout.exact"]?.values["checkout.payment.verifying"], Verifying)

      const invalidPath = structuredClone(encoded) as any
      invalidPath.history["checkout.exact"].active.push("checkout.missing")
      invalidPath.history["checkout.exact"].values["checkout.missing"] = { _tag: "Verifying", challengeId: "x" }
      const pathError = yield* Machine.decodeSnapshot(machine, invalidPath).pipe(Effect.flip)
      assert.instanceOf(pathError, Machine.MachineSchemaDecodeError)
      assert.strictEqual(pathError.boundary, "history")

      const invalidValue = structuredClone(encoded) as any
      invalidValue.history["checkout.exact"].values["checkout.payment.verifying"].challengeId = 123
      const valueError = yield* Machine.decodeSnapshot(machine, invalidValue).pipe(Effect.flip)
      assert.instanceOf(valueError, Machine.MachineSchemaDecodeError)
      assert.strictEqual(valueError.boundary, "history")
      assert.strictEqual(valueError.state, "checkout.payment.verifying")
    }))

  it.effect("preserves recorded history across encode, decode, and runtime resume", () =>
    Effect.gen(function*() {
      const original = checkoutPaymentVerifying("order-1", 2, "challenge-7")
      const machine = makeCheckoutMachine(original)
      const left = yield* Machine.plan(machine, original, new Leave({}))
      const expected = yield* Machine.plan(machine, left.next, new ResumeDeep({}))
      const encoded = yield* Machine.encodeSnapshot(machine, left.next)
      const decoded = yield* Machine.decodeSnapshot(machine, JSON.parse(JSON.stringify(encoded)))
      const ref = yield* Machine.resume(machine, decoded)

      assert.deepStrictEqual((yield* ref.state).history, left.next.history)
      yield* sendAndWaitForPath(ref, new ResumeDeep({}), "checkout")
      assert.deepStrictEqual(yield* ref.state, expected.next)
      yield* ref.stop
    }))

  it.effect("captures the current subtree before resolving a reentering transition to its own history", () =>
    Effect.gen(function*() {
      let defaults = 0
      const original = checkoutPaymentVerifying("order-1", 2, "challenge-7")
      const machine = makeCheckoutMachine(original, undefined, undefined, () => defaults++)

      const reentered = yield* Machine.plan(machine, original, new ReenterHistory({}))

      assert.strictEqual(reentered.microsteps[0]?.transitions[0]?.target, "checkout.exact")
      assert.strictEqual(reentered.microsteps[0]?.transitions[0]?.resolvedTarget, "checkout")
      assert.strictEqual(defaults, 0)
      assert.strictEqual(reentered.next.path, "checkout")
      assert.deepStrictEqual(reentered.next.value, original.value)
      assert.deepStrictEqual((reentered.next as any).state, (original as any).state)
      assert.deepStrictEqual(reentered.next.history?.["checkout.exact"]?.active, [
        "checkout",
        "checkout.payment",
        "checkout.payment.verifying"
      ])
    }))

  it.effect("restores every parallel region deeply and initializes each region for shallow history", () =>
    Effect.gen(function*() {
      const initialized: Array<string> = []
      const machine = makeWorkspaceMachine(initialized)
      const left = yield* Machine.plan(machine, activeWorkspace, new LeaveWorkspace({}))

      assert.deepStrictEqual(left.next.history?.["workspace.recent"]?.active, [
        "workspace",
        "workspace.editor",
        "workspace.sidebar"
      ])
      assert.deepStrictEqual(left.next.history?.["workspace.exact"]?.active, [
        "workspace",
        "workspace.editor",
        "workspace.editor.preview",
        "workspace.sidebar",
        "workspace.sidebar.search"
      ])

      const deep = yield* Machine.plan(machine, left.next, new ResumeWorkspaceDeep({}))
      assert.deepStrictEqual((deep.next as any).states, (activeWorkspace as any).states)
      assert.deepStrictEqual(initialized, [])

      const leftAgain = yield* Machine.plan(machine, deep.next, new LeaveWorkspace({}))
      const shallow = yield* Machine.plan(machine, leftAgain.next, new ResumeWorkspaceShallow({}))
      assert.deepStrictEqual(initialized, ["editor", "sidebar"])
      assert.deepStrictEqual((shallow.next as any).states.editor, {
        path: "workspace.editor" as const,
        value: new Editor({ documentId: "document-1" }),
        state: {
          path: "workspace.editor.writing" as const,
          value: new Writing({ draft: "fresh:document-1" })
        }
      })
      assert.deepStrictEqual((shallow.next as any).states.sidebar, {
        path: "workspace.sidebar" as const,
        value: new Sidebar({ width: 320 }),
        state: {
          path: "workspace.sidebar.files" as const,
          value: new Files({ directory: "/fresh/320" })
        }
      })
    }))

  it.effect("restores nested history without replacing an unaffected parallel sibling", () =>
    Effect.gen(function*() {
      const restored = yield* Machine.plan(
        nestedHistoryMachine,
        nestedParallelSnapshot,
        new RestoreEditor({})
      )

      assert.deepStrictEqual((restored.next as any).states.editor, (nestedParallelSnapshot as any).states.editor)
      assert.deepStrictEqual((restored.next as any).states.sidebar, {
        path: "workspace.sidebar" as const,
        value: new Search({ query: "untouched" })
      })
      assert.deepStrictEqual(restored.next.history?.["workspace.editor.exact"]?.active, [
        "workspace",
        "workspace.editor",
        "workspace.editor.preview"
      ])
    }))

  it.effect("uses a nested first-use default while preserving an active parallel sibling", () =>
    Effect.gen(function*() {
      const restored = yield* Machine.plan(
        nestedHistoryMachine,
        nestedParallelSnapshot,
        new DefaultEditor({})
      )

      assert.deepStrictEqual((restored.next as any).states.editor, {
        path: "workspace.editor" as const,
        value: new Editor({ documentId: "fallback" }),
        state: {
          path: "workspace.editor.writing" as const,
          value: new Writing({ draft: "" })
        }
      })
      assert.deepStrictEqual((restored.next as any).states.sidebar, {
        path: "workspace.sidebar" as const,
        value: new Search({ query: "untouched" })
      })
      assert.strictEqual(restored.microsteps[0]?.transitions[0]?.target, "workspace.editor.exact")
      assert.strictEqual(restored.microsteps[0]?.transitions[0]?.resolvedTarget, "workspace.editor")
      assert.strictEqual(restored.next.history, undefined)
    }))

  it.effect("resumes nested first-use and recorded history snapshots after codec round-trips", () =>
    Effect.gen(function*() {
      const encodedFirstUse = yield* Machine.encodeSnapshot(nestedHistoryMachine, nestedParallelSnapshot)
      const decodedFirstUse = yield* Machine.decodeSnapshot(
        nestedHistoryMachine,
        JSON.parse(JSON.stringify(encodedFirstUse))
      )
      const firstUseRef = yield* Machine.resume(nestedHistoryMachine, decodedFirstUse)
      yield* sendAndWaitForPath(firstUseRef, new DefaultEditor({}), "workspace.editor.writing")
      const firstUseState = yield* firstUseRef.state
      assert.deepStrictEqual((firstUseState as any).states.editor.value, new Editor({ documentId: "fallback" }))
      assert.deepStrictEqual((firstUseState as any).states.sidebar, nestedParallelSnapshot.states.sidebar)
      yield* firstUseRef.stop

      const recorded = yield* Machine.plan(nestedHistoryMachine, nestedParallelSnapshot, new RestoreEditor({}))
      const current = {
        ...(yield* Machine.plan(nestedHistoryMachine, nestedParallelSnapshot, new DefaultEditor({}))).next,
        history: recorded.next.history
      } as Machine.Machine.Snapshot<typeof NestedHistoryStates.states>
      const encodedRecorded = yield* Machine.encodeSnapshot(nestedHistoryMachine, current)
      const decodedRecorded = yield* Machine.decodeSnapshot(
        nestedHistoryMachine,
        JSON.parse(JSON.stringify(encodedRecorded))
      )
      const recordedRef = yield* Machine.resume(nestedHistoryMachine, decodedRecorded)
      yield* sendAndWaitForPath(recordedRef, new DefaultEditor({}), "workspace.editor.preview")
      const restored = yield* recordedRef.state
      assert.deepStrictEqual((restored as any).states.editor, nestedParallelSnapshot.states.editor)
      assert.deepStrictEqual((restored as any).states.sidebar, nestedParallelSnapshot.states.sidebar)
      yield* recordedRef.stop
    }))

  it.effect("rejects a forged fallback that omits its declared owner with a precise diagnostic", () =>
    Effect.gen(function*() {
      const unsafe = makeCheckoutMachine(
        { path: "support" as const, value: new Support({ ticket: "new" }) },
        undefined,
        undefined,
        undefined,
        (() => ({ path: "support" as const, value: new Support({ ticket: "forged" }) })) as any
      )
      const initial = yield* Machine.planInitial(unsafe)
      const exit = yield* Effect.exit(Machine.plan(unsafe, initial.state, new ResumeDeep({})))

      assert.strictEqual(exit._tag, "Failure")
      if (exit._tag === "Failure") {
        assert(Cause.hasDies(exit.cause))
        assert.include(
          Cause.pretty(exit.cause),
          "Machine history default for \"checkout.exact\" returned a configuration that does not contain owner state \"checkout\""
        )
      }
    }))

  it.effect("exits leaf-to-root and re-enters root-to-leaf on every history restoration", () =>
    Effect.gen(function*() {
      const lifecycle: Array<string> = []
      const machine = makeCheckoutMachine(
        checkoutShipping("order-1", "Main Street"),
        undefined,
        lifecycle
      )
      const actor = yield* Machine.start(machine)
      yield* Effect.yieldNow
      yield* sendAndWaitForPath(actor, new EnterVerifying({}), "checkout.payment.verifying")
      yield* Effect.yieldNow
      lifecycle.length = 0

      yield* sendAndWaitForPath(actor, new Leave({}), "support")
      yield* Effect.yieldNow
      assert.deepStrictEqual(lifecycle, [
        "exit:verifying",
        "exit:payment",
        "exit:checkout",
        "entry:support"
      ])

      lifecycle.length = 0
      yield* sendAndWaitForPath(actor, new ResumeDeep({}), "checkout")
      yield* Effect.yieldNow
      assert.deepStrictEqual(lifecycle, [
        "exit:support",
        "entry:checkout",
        "entry:payment",
        "entry:verifying"
      ])

      lifecycle.length = 0
      yield* sendAndWaitForPath(actor, new Leave({}), "support")
      yield* sendAndWaitForPath(actor, new ResumeDeep({}), "checkout")
      yield* Effect.yieldNow
      assert.deepStrictEqual(lifecycle, [
        "exit:verifying",
        "exit:payment",
        "exit:checkout",
        "entry:support",
        "exit:support",
        "entry:checkout",
        "entry:payment",
        "entry:verifying"
      ])
    }))
})
