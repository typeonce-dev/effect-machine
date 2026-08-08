# Runtime performance

Run the local runtime benchmark suite against the compiled package and the
pinned XState comparison versions:

```sh
pnpm perf:runtime
```

The command reports:

- pure `Machine.plan` counter-transition throughput;
- end-to-end useful-increment throughput for a burst sent to one running machine;
- the same running burst while a consumer drains every published snapshot;
- repeated child lookup and delivery to one running child;
- machine start-and-stop throughput;
- parent-with-child start-and-stop throughput;
- heap and resident-memory growth at 100, 500, and 1,000 live units, including
  a raw managed process, an idle statechart, two independent statecharts, a
  parent with one child, and that relationship with child observation active;
- lower-bound memory profiles for Effect itself: a suspended fiber, a queue
  with a waiting fiber, and a minimal mailbox/state/completion actor shell.

The comparison dependencies use package aliases, so XState 5 and 6 can be
loaded by the same process:

- `xstate-v5`: `xstate@5.32.5`, the stable v5 baseline;
- `xstate-v6`: `xstate@6.0.0-alpha.27`, the latest published v6 alpha available
  when the harness was added.

All implementations use the same flat counter topology, immutable events, and
terminal fence. The XState adapter uses `assign` in v5 and the v6 transition
function API because `assign` is not exported by that alpha.

The burst benchmark reports useful counter increments per second. It enqueues
one final fence event after all counter events and awaits the machine's terminal
output, so the measured duration also amortizes that fence and terminal
cleanup. This measures complete queue drainage, not only the enqueue time
returned by `MachineRef.send`.

Results are informational. Compare runs on the same machine while it is idle,
using the same Node.js and dependency versions. Tinybench warms each scenario
before collecting samples, and the memory measurements force garbage
collection before every observation. Each implementation's memory curve runs
in a fresh child process so garbage from one library cannot distort another
library's baseline.

These scenarios compare observable work, not identical internals. Effect
Machine plans transitions synchronously and validates schema-backed state and
events, while its running machine provisions Effect queues, fibers,
synchronization, change publication, and child/invoke lifecycle machinery.
XState's counter is a smaller synchronous actor. Treat the comparison as an
application-level cost baseline, not a claim that the libraries provide the
same runtime guarantees.

The fitted heap slope is the primary idle-capacity metric. Compare adjacent
profiles to attribute retained memory: raw process to idle statechart isolates
statechart machinery, two independent machines to parent-with-child isolates
relationship bookkeeping, and unobserved to observed parent-child isolates
observation. The Effect profiles are primitive lower bounds, not feature-equivalent
competitors. Resident memory is reported as a raw diagnostic because V8 and the
operating-system allocator can reuse already committed pages. The
capacity-per-GiB value is a linear estimate that excludes shared process
overhead; it is not a run-until-OOM limit.

Use a shorter smoke run while changing the harness:

```sh
pnpm perf:runtime -- --quick
```

Display the complete versioned report as JSON, or write a machine-readable JSON
file alongside the terminal report:

```sh
pnpm perf:runtime -- --json
pnpm perf:runtime -- --output runtime-performance.json
```

Prefer `--output` for scripts: pnpm and the preceding build may add their own
lines to standard output before `--json` is printed.

Pull requests run the pull request's benchmark harness five times against both
the base and pull request library revisions on the same GitHub-hosted runner.
Using one harness revision means a newly added scenario can compare both
implementations immediately. The runs are interleaved to reduce time-dependent
machine drift. The workflow publishes the process-level median and its median
absolute deviation to the job summary and a sticky pull request comment. The
benchmark workflow has read-only repository access; a separate trusted
`workflow_run` workflow validates the uploaded JSON before receiving permission
to update the comment.

The implementation lives in `scripts/runtime-performance.mjs`; the Effect
Machine fixture is in `perf/runtime/counter.mjs`, and the comparison adapter is
in `perf/runtime/xstate.mjs`. Add new scenarios only when every implementation
performs equivalent observable work and the result is consumed and checked so
the JavaScript engine cannot discard it.
