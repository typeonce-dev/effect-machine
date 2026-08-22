# Effect Atom and React patterns

This guide records the folder organization and three integration patterns
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

## 2. A machine with startup input selected through a family

Use the family key as machine identity. The same value can also be startup
input:

```ts
import { machineAtoms } from "@/lib/atom-runtime"
import { AtomMachine } from "@typeonce/effect-machine/reactivity"
import { Atom } from "effect/unstable/reactivity"
import { processMachine } from "./machine"

export const processFamily = Atom.family((query: string) => {
  const machine = machineAtoms.make(processMachine, { query })

  return {
    detailsAtom: AtomMachine.select(machine, "process"),
    resultAtom: AtomMachine.select(machine, "process.Ready"),
    sendAtom: machine.send
  }
})
```

A consumer calls `processFamily(query)` and uses the returned focused atoms. If
several nested components need the same scope, an optional Context can expose
`ReturnType<typeof processFamily>`. The provider resolves the query once instead
of drilling it through every component.

Changing `query` selects another family member and therefore another machine.
If a changing value should update the current workflow, model it as an event.

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

Choose one of the following ownership forms.

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

### Stable keyed instances shared across scattered components

Use one private family to create the scope for an ID. Public selector families
reach that same scope:

```ts
import { Atom } from "effect/unstable/reactivity"

const dialogScopeFamily = Atom.family((dialogId: string) => {
  const scope = makeDialogScope()

  return {
    isOpenAtom: scope.isOpenAtom.pipe(
      Atom.withLabel(`dialog:${dialogId}:isOpen-source`)
    ),
    openStateAtom: scope.openStateAtom.pipe(
      Atom.withLabel(`dialog:${dialogId}:openState-source`)
    ),
    sendAtom: scope.sendAtom.pipe(
      Atom.withLabel(`dialog:${dialogId}:send-source`)
    )
  }
})

export const dialogIsOpenFamily = Atom.family((dialogId: string) => {
  const scope = dialogScopeFamily(dialogId)

  return Atom.transform(
    scope.sendAtom,
    (get) => get(scope.isOpenAtom)
  ).pipe(Atom.withLabel(`dialog:${dialogId}:isOpen`))
})

export const dialogOpenStateFamily = Atom.family((dialogId: string) => {
  const scope = dialogScopeFamily(dialogId)

  return Atom.transform(
    scope.sendAtom,
    (get) => get(scope.openStateAtom)
  ).pipe(Atom.withLabel(`dialog:${dialogId}:openState`))
})
```

Components using the same `dialogId` share one machine. Different IDs create
independent machines. The two public projections let consumers subscribe
independently. Both remain writable through `Atom.transform`, so either can send
the inferred dialog events.

Use `dialogId` in atom labels for diagnostics. Do not pass it into
`dialogMachine` as unused fake input.

## 4. Selecting process-owned child machines

Bind a machine definition once when a parent owns a runtime-sized set of child
machines:

```ts
const Plant = Machine.childFamily(plantMachine)

export const centralMachineAtom = machineAtoms.make(centralMachine)

export const plantScopeFamily = Atom.family((plantId: string) => {
  const plant = centralMachineAtom.child(Plant(plantId))

  return {
    stateAtom: plant.state,
    isBrokenAtom: AtomMachine.matchesChild(plant, "Broken"),
    sendAtom: plant.send,
    stopAtom: plant.stop
  }
})
```

`Plant(plantId)` may be reconstructed wherever the id is available. Child
lookup and bridge reuse match by machine identity and id, not descriptor object
identity. Before the parent spawns that child, selectors contain `Option.none`
and `matchesChild` is `false`. They follow the child after startup and return to
the inactive values after it stops.
