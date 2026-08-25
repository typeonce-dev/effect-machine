---
"@typeonce/effect-machine-devtools": minor
---

Replace the text-tree topology pane with a statically laid-out statechart. State cards expose value fields and invocations, while routed transition edges and compound regions make the machine topology readable without a draggable canvas. Directional colors distinguish incoming from outgoing relationships, and conditional branches with the same source and target share one topology edge while retaining their full details in the inspector. Machine tabs sit above the full-viewport chart, selection remains visible independently from the on-demand floating inspector, and corner zoom and fit controls provide a whole-machine overview.

`MachineDocument.State` now retains each state's projected value and output schemas. Consumers of serialized documents must accept `schemaVersion: 3` and the new `valueSchema` and `outputSchema` fields.
