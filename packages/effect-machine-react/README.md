# @typeonce/effect-machine-react

React ownership hooks for machine atoms created by
[`@typeonce/effect-machine`](../effect-machine/README.md).

```tsx
import { useMachineAtom } from "@typeonce/effect-machine-react"

function AuthProvider({ input, children }: Props) {
  const machine = useMachineAtom(() => MachineAtoms.make(AuthMachine, input))

  return (
    <AuthContext.Provider value={machine}>
      {children}
    </AuthContext.Provider>
  )
}
```

`useMachineAtom` strongly owns one machine atom, mounts it after commit, and
does not subscribe the owner to machine state. Descendants subscribe to the
specific state paths they render with `AtomMachine.select`,
`AtomMachine.selectSnapshot`, or `AtomMachine.matches`.

Machine input is startup-only. Send an event to update a running workflow, or
change the provider's React `key` to replace it with a new machine.
