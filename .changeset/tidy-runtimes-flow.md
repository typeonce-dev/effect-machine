---
"@typeonce/effect-machine": minor
---

Add explicitly named causal and enqueue-oriented runtime command runners. Causal command tests now retain an exact probe step for every processed send, support probe-bound asynchronous waits, attribute processing failures to the submitted command, and format replayable causal transcripts. Deprecate the ambiguous `runRuntimeCommands` and `formatRuntimeTranscript` names in favor of their explicit enqueue-oriented replacements.
