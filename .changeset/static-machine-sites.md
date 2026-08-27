---
"@typeonce/effect-machine-devtools": minor
---

Add `effect-machine build` for publishing the project visualizer as a static website.

The command inspects the selected machines once, validates their documents, and writes relative HTML, CSS, JavaScript, `machines.json`, and build metadata to `--out-dir`. The generated site keeps the interactive statechart and topology walkthrough without a live devtools server or project code at viewing time.
