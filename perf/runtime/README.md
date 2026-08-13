# Runtime performance

Run the local runtime benchmark suite against the compiled package:

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
- generic and compiled raw-process lifecycle throughput;
- heap and resident-memory growth at 100, 500, and 1,000 live units, including
  a raw generic process, a raw compiled process, an idle statechart, two
  independent statecharts, a parent with one child, that relationship with
  child-registry observation active, and an invoked child whose active snapshots
  are observed.

The burst benchmark reports useful counter increments per second. It enqueues
one final fence event after all counter events and awaits the machine's terminal
output, so the measured duration also amortizes that fence and terminal
cleanup. This measures complete queue drainage, not only the enqueue time
returned by `MachineRef.send`.

Compare runs on the same machine while it is idle, using the same Node.js and
dependency versions. Tinybench warms each scenario before collecting samples,
and the memory measurements force garbage collection before every observation.
Each memory profile runs in a fresh child process so garbage from one profile
cannot distort another profile's baseline.

The fitted heap slope is the primary idle-capacity metric. Compare adjacent
profiles to attribute retained memory: raw process to idle statechart isolates
statechart machinery, two independent machines to parent-with-child isolates
relationship bookkeeping, while the two observed parent-child profiles isolate
registry and invoked-snapshot observation. Invoked snapshot mapping uses a
direct, state-scoped delivery path; its profile measures the retained callback
and mapping state rather than a general `changes` stream subscription.

Resident memory is reported as a raw diagnostic because V8 and the
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

The required pull request check rejects throughput decreases above both 15%
and three times the observed process-level median absolute deviation. Heap per
unit uses the same variability rule with a 20% floor. RSS remains informational
because hosted-runner and allocator behavior makes it substantially noisier.

The implementation lives in `scripts/runtime-performance.mjs`, and the Effect
Machine fixture is in `perf/runtime/counter.mjs`. Every scenario consumes and
checks its result so the JavaScript engine cannot discard the measured work.
