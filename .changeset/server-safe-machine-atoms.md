---
"@typeonce/effect-machine": minor
---

Reading an `AtomMachine` bridge on the server no longer starts the machine. Every bridge atom now has an Effect Atom server value, so `Atom.getServerValue` and the server render of `@effect/atom-react` hooks return the machine's planned startup state without running startup commands, invocations, or services.

`result` serves `Success(state)` and `snapshot` serves `Success({ status: "active", state })`, both waiting, where `state` is the state `Machine.planInitial` settles into with the bridge's input. `select`, `selectSnapshot`, `matches`, `can`, and `family` projections serve the same projection of that state. `child(Child)` serves the planned child state when the planned parent state invokes `Child`, and `Option.none()` otherwise. `ref`, `send`, and `stop` serve `Initial`, as does every atom of a bridge whose startup state cannot be planned synchronously. Resumed bridges serve their resumed snapshot.
