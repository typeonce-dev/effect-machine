---
name: effect-machine-release
description: Run the complete Effect Machine implementation and release workflow. Use only when the user explicitly invokes `$effect-machine-release` and wants a change implemented, validated, merged, included in the Changesets version pull request, and published by the release workflow. Do not use when the requested endpoint is only a feature pull request or merge to main.
---

# Effect Machine Release

Ship the requested change through its feature pull request, the bot-owned Changesets version pull request, and the resulting publish workflow. Treat invocation as authorization to merge both validated pull requests; it does not authorize bypassing protections or merging unrelated, unverified work.

## Ship the feature pull request

Before acting, read `../effect-machine-pr/SKILL.md` completely and follow its entire implementation-to-merge workflow. Review the changeset before merging the feature pull request so its level and published text will not need repair later.

## Find the release pull request

1. After the feature merge, inspect the current `.github/workflows/release.yml`; follow the repository's actual Changesets and publish workflow rather than assuming it is unchanged.
2. Fetch `main` and wait for the Changesets action to create or update its pull request. Identify it by the expected base, bot author, and `changeset-release/main` head branch, not by title alone.
3. Confirm the release pull request's head includes the feature merge. Continue waiting if an older run or head revision does not yet contain it.
4. Inspect the complete diff. Verify the consumed changeset appears in the generated package version and changelog, the migration text remains accurate, and no major version is introduced before 1.0.
5. Aggregated release entries are allowed only when they correspond to changesets already merged into the base. Do not merge arbitrary code changes or an untrusted lookalike pull request.

## Validate and merge the release

1. Monitor every required check on the current release head. If the bot updates the branch, restart the review and wait for checks on the new head.
2. Treat versioning, changelog, packaging, correctness, and performance failures as blockers. Do not edit generated release output merely to bypass the source of a failure.
3. Merge the release pull request only when its identity and contents are verified, it is current and mergeable, and all required checks are green.
4. Verify the release merge commit on `origin/main` and confirm the release pull request is closed as merged.

## Verify publication

1. Monitor the release workflow triggered by the release merge. Distinguish the Changesets/version pull request from actual package publication.
2. Confirm the Changesets action reports publication, the expected package version and tag exist, and any triggered website deployment succeeds.
3. Report the feature pull request, release pull request, merge commits, released version, and publication status.

Keep waiting through normal bot and CI latency and provide concise progress updates. Do not stop merely because the release pull request has not appeared yet. If environment approval, credentials, repository protection, malformed aggregated content, or an external outage requires new authority, report the exact blocker without weakening the workflow.
