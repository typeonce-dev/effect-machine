# Platformer statechart example

A small, standalone SVG and Vite demo in which `@typeonce/effect-machine` owns
a platformer character's legal behavior. One compact adapter provides keyboard
input, gravity, a floor, and visible SVG transforms.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Run the production verification with:

```sh
pnpm check
```

## Controls

- **A/D** or **arrow keys** — move
- **W**, **up**, or **Space** — jump; press again once in the air for a double jump
- Touch either wall and jump — turn and kick away; repeat after returning to a wall
- **S** or **down** — duck while grounded; dive while airborne
- **P** — pause and resume the exact playable configuration through deep history
- **R** — reset

## Statechart

`Character` is parallel: `locomotion`, `facing`, and `contact` update
independently. The locomotion region switches between `Playing` and `Paused`.
Inside `Playing`, `Grounded` and `Airborne` are mutually exclusive. Each branch
is compound again:

```text
Character (parallel)
├─ locomotion
│  ├─ Playing
│  │  ├─ Grounded: Standing | Running | Ducking | Landing
│  │  ├─ Airborne (parallel)
│  │  │  ├─ motion: Jumping | Falling | Diving
│  │  │  └─ airJump: GroundLock | WallLock | Ready | Spent
│  │  └─ resume (deep history)
│  └─ Paused
├─ facing: Left | Right
└─ contact: NoWall | LeftWall | RightWall
```

`Pause` exits `Playing`, which records its current deep configuration. Physics
stops while `Paused`. `Resume` targets `Playing.resume`, restoring both the
active descendants and their typed values: for example, an airborne wall jump
returns with its `originY`, `startedAt`, `push`, jump kind, and air-jump lock.
This is one saved configuration, not an undo stack; pausing again replaces the
previous history. The history implementation also supplies a typed default
`Playing` snapshot for the case where the history node is targeted before the
region has ever been exited.

State-scoped invocations follow normal statechart entry/exit semantics. Pausing
cancels an active landing or air-jump timer, and restoring that state starts its
invocation again. History restores state configuration and values, not elapsed
wall-clock time or the adapter's past events.

State payloads live only where they are valid: `Landing` owns impact and resume
direction, while `Airborne` owns only the jump origin. Air-jump availability is
modeled entirely as state: lock states own cancellable readiness timers,
`Ready` is the only state that authorizes a double jump, and `Spent` makes a
second one unrepresentable. Entering `Airborne` exercises a complete nested
parallel target by selecting both `motion` and `airJump` regions.

Wall contact is an independent top-level region, so the live chart can show
`Grounded + LeftWall` at a floor corner without confusing that combination with
an airborne wall jump. The `Grounded` handler always produces an ordinary jump;
only `Airborne` interprets the wall sample as a wall jump. It turns and pushes
away, refreshes the air jump through `WallLock`, and the same wall may be used
again after physically returning to it. Movement phases own their timestamps,
and both landing and capability locks demonstrate state-scoped
inline `invoke: (from) => from.timer(...)` chains.

Keyboard commands and physics facts share a typed `Schema.TaggedUnion`
protocol. The adapter executes velocity and floor collision, then reports
`ApexReached`, `Landed`, and `WallContact`. `JumpPressed` includes the current
wall sample, but the active `Grounded` or `Airborne` branch decides its meaning.
Typed internal events coordinate orthogonal regions: `TryAirJump` is accepted
only by `Ready`, while `DoubleJump` and `WallJump` update motion, capability,
and facing without shared flags. The SVG box only reflects the active snapshot;
it never decides behavior.

## Visuals

The character is a few inline SVG shapes. Each state maps to one typed transform
and body color in `src/game.ts`; after the double jump is spent, a purple accent
persists across falling and diving. This keeps the example focused on the
machine rather than an art or rendering pipeline.
