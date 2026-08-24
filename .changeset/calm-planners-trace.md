---
"@typeonce/effect-machine-devtools": minor
---

Add planner-backed simulation sessions to the web visualizer. Machine input and event payloads can be entered as JSON, while each isolated step uses the real Effect Machine planner and shows selected branches, topology changes, raised and emitted events, planned commands, completion, and output as a structured trace.

Planning evaluates synchronous statechart callbacks but does not commit commands or start runtime activities. Schema and planning failures remain visible beside the machine topology.
