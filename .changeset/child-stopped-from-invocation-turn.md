---
"@typeonce/effect-machine": patch
---

Fix a machine that hung when a child's invocation `onDone` sent an event to its parent and the parent's transition stopped that child.

The parent now leaves the state and stops the child, and the child's scope closes normally.
