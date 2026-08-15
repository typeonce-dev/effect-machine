---
name: effect-machine-pr
description: Run the complete Effect Machine implementation-to-merge workflow. Use only when the user explicitly invokes `$effect-machine-pr` and wants a repository change implemented from the latest base branch through local validation, a pull request, CI and performance checks, and merge. Do not use for design, review, diagnosis, or implementation that should stop before publication.
---

# Effect Machine PR

Ship the requested change through a green, merged pull request. Treat invocation as authorization for the in-scope branch, commits, push, pull request, CI fixes, and final merge; it does not authorize unrelated changes, bypassing protections, or destructive recovery.

## Establish the baseline

1. Read `AGENTS.md` and every instruction it routes to before changing files.
2. Inspect the worktree and preserve all user-owned changes. Never discard or overwrite unrelated work.
3. Use the base branch named by the user, or `main` by default.
4. Fetch the latest remote base. In its primary worktree, switch to the base and run a fast-forward-only pull. If the base is checked out in another worktree, branch directly from the freshly fetched `origin/<base>` commit instead.
5. Create a focused `codex/` branch unless the user specifies another name.

## Implement the complete change

1. Inspect the relevant public API, internals, tests, documentation, examples, and analogous Effect implementation before editing.
2. Implement the long-term design, including generic and optimized semantics where applicable. Follow the Cluster ownership boundary in `AGENTS.md`.
3. Add observable runtime tests, typetests, differential tests, JSDocs, README or guide updates, and example changes required to make the feature complete.
4. Add a changeset when required. Use minor for a public addition or breaking change and patch for a compatible fix or implementation improvement. Never use major before 1.0.
5. Keep the changeset user-facing: explain the resulting API and direct migration, not implementation history or external inspiration.

## Validate locally

1. Run `pnpm check`.
2. Run `pnpm check` in every affected package directly below `examples/`.
3. Run `pnpm perf:types` for changes that affect the public TypeScript API or inference.
4. Always run `pnpm perf:runtime` before publishing this full-lifecycle workflow. Treat the local run as a functional smoke test; the CI base-versus-PR comparison is authoritative.
5. Fix every failure and repeat all affected checks. Treat correctness, type safety, runtime performance, and memory regressions as blockers.
6. Audit the final diff, formatting, generated files, public terminology, changeset level, and working-tree scope.

## Publish and merge

1. Stage only the intended files, commit with a concise outcome-oriented message, and confirm the worktree is clean.
2. Fetch the remote base again before pushing. If it advanced materially, integrate it safely and repeat affected validation.
3. Push the branch and open a ready pull request using the repository template. Record the changeset decision and validation without copying noisy local benchmark tables.
4. Monitor every required check, example job, and type/runtime performance workflow. Inspect the base-versus-PR reports, not only the aggregate green status.
5. Diagnose failures from their logs, implement in-scope fixes, rerun relevant local checks, push, and continue monitoring. Never weaken semantics, inference, tests, or thresholds to make CI pass.
6. Merge only when the pull request is current, mergeable, and every required check is green. Use the repository's normal squash-and-branch-cleanup convention unless instructed otherwise.
7. Verify the pull request's remote state even if the merge command reports a local worktree checkout error. Confirm the merge commit is present on `origin/<base>` and the remote feature branch was removed.

Keep the user informed during long checks. Do not stop at an open pull request or merely enable auto-merge. If repository protection, an approval, credentials, or an external outage prevents completion, exhaust safe checks and report the precise blocker.
