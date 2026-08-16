---
"@typeonce/effect-machine": minor
---

Add typed declared-initial entry to compound and parallel transition targets.

Use `target.full.opened.initial()`, `initial(value)`, or `initial.from(input)` to enter the initial configuration declared by `Machine.defineStates`; the same operation is available through compatible `local` and `branch` target scopes. Schema-valued implicit children are constructed by `initialize: ({ builder }) => ...`, including fluent completion of every valued parallel region. Missing initializers are reported at `handle(...)`, and `.from` validation remains a typed `MachineSchemaDecodeError` during planning.

State handler `initial` and its `StateInitial*` utility types have been replaced by `initialize` and `StateInitialize*`. Migrate compound initializers from `initial: () => new Child(...)` to `initialize: ({ builder }) => builder(new Child(...))`, and parallel initializers from returned value records to chained region builders.
