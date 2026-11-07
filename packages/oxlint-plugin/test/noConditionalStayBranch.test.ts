import { RuleTester } from "oxlint/plugins-dev"
import { describe, it } from "vitest"
import plugin from "../src/index.js"

RuleTester.describe = describe
RuleTester.it = it

const tester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" } }
})

const rule = plugin.rules["no-conditional-stay-branch"]

const make = (transition: string, machine = "Machine") =>
  `import { ${machine === "Machine" ? "Machine" : `Machine as ${machine}`} } from "@typeonce/effect-machine"
${machine}.make({}).handle({ states: { Editing: { on: { Submitted: ${transition} } } } })`

const review = `branches: [{ target: "Reviewing" }, { stay: true }]`

tester.run("no-conditional-stay-branch", rule, {
  valid: [
    // Targeted branches only.
    make(
      `{ branches: [{ target: "Reviewing" }, { target: "Editing" }], resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : select.target("Editing") }`
    ),
    // Unconditional stay selection.
    make(`{ branches: [{ stay: true }], resolve: ({ select }) => select.stay() }`),
    make(`{ branches: [{ stay: true }], resolve: ({ select }) => { return select.stay() } }`),
    // A list that also declines may still stay deliberately.
    make(
      `{ branches: [{ target: "Reviewing" }, { stay: true }, { decline: true }], resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : state.draft ? select.stay() : select.decline() }`
    ),
    // A list that cannot be read statically is not guessed.
    make(
      `{ branches: [...entries, { stay: true }], resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : select.stay() }`
    ),
    // A shadowed selector is not the resolver's select.
    make(
      `{ ${review}, resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : ((select) => select.stay())(other) }`
    ),
    // Invocation outcomes and eventless transitions are not events that \`Machine.can\` queries.
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Watching: { invoke: { src: "worker", onSnapshot: { branches: [{ target: "Ready" }, { stay: true }], resolve: ({ snapshot, select }) => snapshot.ready ? select.target("Ready") : select.stay() } } } } })`,
    `import { Machine } from "@typeonce/effect-machine"
Machine.make({}).handle({ states: { Editing: { always: { ${review}, resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : select.stay() } } } })`,
    // Without a Machine import nothing is a machine definition.
    `const Machine = { make: (_: unknown) => ({ handle: (_: unknown) => undefined }) }
Machine.make({}).handle({ states: { Editing: { on: { Submitted: { ${review}, resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : select.stay() } } } } })`,
    // An unrelated object outside a machine definition.
    `import { Machine } from "@typeonce/effect-machine"
const config = { ${review}, resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : select.stay() }`
  ],
  invalid: [
    {
      code: make(
        `{ ${review}, resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : select.stay() }`
      ),
      errors: [{ messageId: "conditionalStayBranch" }]
    },
    {
      code: make(
        `{ ${review}, resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : select.stay() }`,
        "StateMachine"
      ),
      errors: [{ messageId: "conditionalStayBranch" }]
    },
    {
      code: make(
        `{ ${review}, resolve: ({ state, select: { target, stay } }) => state.ok ? target("Reviewing") : stay() }`
      ),
      errors: [{ messageId: "conditionalStayBranch" }]
    },
    {
      code: make(`{ ${review}, resolve: ({ state, select }) => {
  if (state.ok) return select.target("Reviewing")
  return select.stay()
} }`),
      errors: [{ messageId: "conditionalStayBranch" }]
    },
    {
      code: make(`{ ${review}, resolve(context) {
  if (!context.state.ok) {
    return context.select.stay()
  } else {
    return context.select.target("Reviewing")
  }
} }`),
      errors: [{ messageId: "conditionalStayBranch" }]
    },
    {
      code: `import * as EM from "@typeonce/effect-machine"
const definition = EM.Machine.make({})
export const machine = definition.handle({ states: { Editing: { states: { Draft: { on: {
  Submitted: { ${review}, resolve: ({ state, select }) => state.ok ? select.target("Reviewing") : select.stay() }
} } } } } })`,
      errors: [{ messageId: "conditionalStayBranch" }]
    }
  ]
})
