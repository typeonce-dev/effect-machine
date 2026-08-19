# Effect Machine playground

Five complete React examples, ordered from a two-state machine to browser
transport integration.

## Run

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Validate tests, types, and the production bundle with:

```sh
pnpm check
```

## Examples

| Route            | Machine concept                                                   | Integration concept                                                     |
| ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `/turnstile`     | Atomic states, typed commands, ignored events                     | Service-free `AtomMachine`                                              |
| `/traffic-light` | Internal events, cancellable state-scoped timers, re-entry        | Reactive timer-driven rendering                                         |
| `/microwave`     | Compound hierarchy and unrepresentable invalid states             | Safety-oriented controls                                                |
| `/media-player`  | Resource-owned compound states and an independent settings region | Shared Atom runtime, DOM audio, Web Audio service                       |
| `/worker-tabs`   | A machine hosted outside the UI thread                            | Schema-validated worker messages and `BroadcastChannel` synchronization |

Each route keeps its machine, adapter, and supporting protocol beside the page.
The machines own legal behavior; components project snapshots and send typed
public commands.

## Notable boundaries

- The traffic light exposes `Reset` publicly while timer deliveries stay in
  `internalEvents`.
- The microwave stores elapsed time only on `Cooking`, where it is valid.
  `Cooking` is nested below `Closed`, so opening the door exits and interrupts
  cooking and `Cooking + Open` cannot be represented.
- The media player keeps browser APIs behind an Effect service. Its invoked
  transport is nested below the registered audio session that it requires,
  while sound settings remain an independent parallel region. Invoked work
  returns typed internal events to the deterministic transition core.
- The worker validates unknown incoming messages with Effect Schema before
  forwarding public events. Tabs replicate commands and exchange a typed
  synchronization state when a tab joins.

`src/examples/examples.test.ts` covers the smaller machines, including virtual
clock advancement for inline invocation timers. The media player keeps focused model and
property coverage in its own directory.
