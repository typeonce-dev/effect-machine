---
"@typeonce/effect-machine": minor
"@typeonce/effect-machine-devtools": minor
---

Add planner-backed simulation sessions to the web visualizer. Machine and event inputs are rendered as fields from their Effect schemas, while each isolated step uses the real Effect Machine planner and shows selected branches, concrete topology changes, raised and emitted events, planned commands, completion, and output as a structured trace.

Expose `Machine.inputEventSchemas` so inspection tools can describe or construct valid public events without reaching into the opaque event protocol. Planning evaluates synchronous statechart callbacks but does not commit commands or start runtime activities. Schema and planning failures remain visible beside the machine topology.
