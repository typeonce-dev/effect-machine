---
"@typeonce/effect-machine-devtools": patch
---

Make statecharts denser by flowing states from top to bottom, replacing full initial-entry lanes with compact top-entry markers, and sizing state cards from their visible names and invocations.

State values now appear as compact JSON-shaped type previews in the state inspector instead of occupying the topology. Transition labels sit directly on clear route segments when space permits, hierarchy-crossing routes avoid compound-state headers, and routes attach to their actual source and target before turning. Horizontally scrolling machine tabs also keep their position when selecting or live-reloading a machine.

Charts remain available when every deterministic layout has only cosmetic label-to-route crossings. Structural failures such as detached edges, node crossings, and overlapping routes still prevent rendering.
