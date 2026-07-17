---
name: commit-autonomously
description: "Standing permission (2026-07-17): commit completed, verified work without asking — stage files explicitly, never `git add -A` when other sessions share the tree"
metadata:
  type: feedback
---

The user rescinded the don't-commit-unless-asked rule (2026-07-17, given in Scope and ported here with the memory system): commit completed, verified work without waiting for an explicit request.

**Why:** Multiple agent sessions often share a working tree; leaving finished work uncommitted invites another session's `commit -a` to sweep it up half-attributed, and blocks other agents from building on it.

**How to apply:**
- Commit when a unit of work is done and verified (tests run, behaviour checked) — don't batch a day's work into one commit and don't commit known-broken states.
- **Stage files explicitly by path.** Avoid `git add -A` / `commit -a` whenever other sessions may have in-flight edits. Verify each staged file's diff contains only your changes first.
- Pushing is still separate — the standing permission covers local commits; push when asked or when the user's workflow clearly expects it.
- End commit messages with the Co-Authored-By line your harness specifies.
