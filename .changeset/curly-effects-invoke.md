---
"@typeonce/effect-machine": minor
---

Require every `Machine.invoke` `effect` source to be a factory evaluated when its owning state is entered. This gives lifecycle callbacks immediate output and failure inference while making Effect construction timing explicit.

Wrap previously direct Effects in a zero-argument function:

```ts
Machine.invoke({
  id: "load",
  effect: () => load,
  onDone: ({ output, target }) => target.none()
})
```
