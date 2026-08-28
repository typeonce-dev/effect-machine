# Effect Atom and React patterns

This guide records the folder organization and four integration patterns
validated in the process app. Use the API reference for individual AtomMachine
operations. Read the [Effect Machine agent guide](./agent-guide.md) for
statechart modeling, transitions, services, and testing.

## Recommended folder structure

```text
src/
├── context/                 # Optional React Context adapters
│   ├── dialog-context.tsx
│   └── process-context.tsx
├── lib/
│   ├── atom-runtime.ts      # Shared bound AtomMachine runtime
│   └── services/            # Generic Effect business services
│       └── query-processor.ts
└── machines/
    ├── counter/
    │   ├── machine.ts       # Machine implementation
    │   └── atom.ts          # Focused atoms for React
    ├── process/
    │   ├── machine.ts
    │   └── atom.ts
    └── dialog/
        ├── machine.ts
        └── atom.ts
```

Keep these responsibilities separate:

- `machine.ts` defines states, events, transitions, statechart behavior, and
  Effect service requirements. It has no React dependency.
- `atom.ts` adapts that machine to the shared bound AtomMachine runtime and
  exports the focused atoms React needs.
- `lib/services/` contains reusable business services used by machines.
- `context/` is optional. It only distributes an already-created machine scope
  through a React subtree.
- `lib/atom-runtime.ts` binds AtomMachine once to the application's Effect
  service layer:

```ts
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Atom } from "effect/unstable/reactivity"
import { QueryProcessor } from "./services/query-processor"

const atomRuntime = Atom.runtime(QueryProcessor.layer)

export const machineAtoms = AtomMachine.bind(atomRuntime)
```

Each `machineAtoms.make` call still creates an independent machine bridge.

## 1. One global actor with no input

Use a module-level bridge when a no-input machine intentionally has one
application-wide instance:

```ts
import { machineAtoms } from "@/lib/atom-runtime"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { counterMachine } from "./machine"

export const counterMachineAtom = machineAtoms.make(counterMachine)

export const counterStateAtom = AtomMachine.select(
  counterMachineAtom,
  "counter"
)
```

"Global" means every import reaches this bridge under the same atom registry.
Consumers read `counterStateAtom` and use `counterMachineAtom.send` directly.
Do not add a redundant `counterSendAtom` alias.

## 2. A keyed machine with startup input

`AtomMachine.family` uses the machine input as both startup input and family
key. It returns one direct atom family for each entry in `atoms`:

```ts
import { machineAtoms } from "@/lib/atom-runtime"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { processMachine } from "./machine"

export const processAtoms = machineAtoms.family(processMachine, {
  atoms: {
    details: AtomMachine.select("process"),
    result: AtomMachine.select("process.Ready"),
    send: (machine) => machine.send
  },
  label: (input, name) => `process:${input.query}:${name}`
})
```

React consumes each projected family directly:

```tsx
const input = { query }
const details = useAtomValue(processAtoms.details(input))
const send = useAtomSet(processAtoms.send(input))
```

Each public atom retains its private machine bridge. Keeping only `details` or
only `send` is safe. The bridge still starts lazily in the registry and stops
when that registry releases or disposes it. A writable source remains writable,
and a projection keeps the source atom's equality function.

The family uses Effect `Equal` and `Hash` semantics. Equal records such as
`{ query: "effect" }` select the same family value even when reconstructed.
Keep inputs immutable because mutating a hashed key makes later lookup
unreliable. Different input values select independent machines. If a changing
value should update one running workflow, model the change as an event instead
of putting it in the machine input.

Service-free machines use the module function directly:

```ts
export const processAtoms = AtomMachine.family(processMachine, {
  atoms: {
    details: AtomMachine.select("process"),
    send: (machine) => machine.send
  }
})
```

## 3. Reusing one machine definition for multiple instances

Define the dialog adapter once:

```ts
import { machineAtoms } from "@/lib/atom-runtime"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { dialogMachine } from "./machine"

export function makeDialogScope() {
  const machine = machineAtoms.make(dialogMachine)

  return {
    isOpenAtom: AtomMachine.matches(machine, "Open"),
    isClosedAtom: AtomMachine.matches(machine, "Closed"),
    openStateAtom: AtomMachine.select(machine, "Open"),
    sendAtom: machine.send
  }
}

export type DialogScope = ReturnType<typeof makeDialogScope>
```

### React-tree-owned instance

```tsx
const DialogContext = createContext<DialogScope | null>(null)

export function DialogProvider({ children }: { children: ReactNode }) {
  const [scope] = useState(makeDialogScope)

  return (
    <DialogContext.Provider value={scope}>
      {children}
    </DialogContext.Provider>
  )
}
```

Each provider owns one independent dialog. Descendants use a small
`useDialog()` hook and subscribe to the focused atom they need. Pass
`DialogScope` through props when Context is unnecessary. Do not add a wrapper
component whose only job is forwarding the scope.

For a no-input machine, use one module-level bridge or an explicitly owned
React scope. Do not add a family key that the machine does not consume. When an
ID is part of startup semantics, declare it in the machine input and use
`AtomMachine.family`.

## 4. Selecting process-owned child machines

Bind a machine definition once when a parent owns a runtime-sized set of child
machines:

```ts
const Plant = Machine.childFamily(plantMachine)

export const centralMachineAtom = machineAtoms.make(centralMachine)

export const plantAtoms = AtomMachine.familyChild(centralMachineAtom, {
  child: (plantId: string) => Plant(plantId),
  atoms: {
    state: (plant) => plant.state,
    isBroken: AtomMachine.matchesChild("Broken"),
    send: (plant) => plant.send,
    stop: (plant) => plant.stop
  }
})

const broken = useAtomValue(plantAtoms.isBroken(plantId))
const send = useAtomSet(plantAtoms.send(plantId))
```

`familyChild` keeps child lookup separate from root machine startup. Each
projected atom retains the child bridge returned for its key.

`Plant(plantId)` may be reconstructed wherever the id is available. Child
lookup and bridge reuse match by machine identity and id, not descriptor object
identity. Before the parent spawns that child, selectors contain `Option.none`
and `matchesChild` is `false`. They follow the child after startup and return to
the inactive values after it stops.
