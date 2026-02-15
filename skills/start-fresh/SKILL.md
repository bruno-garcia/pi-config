---
name: start-fresh
description: Reset the workspace for a new task. Checks out main, pulls latest, cleans up stale branches, reviews open todos, and compacts context. Use when starting a new session or switching to a different task.
---

# Start Fresh

Run these steps in order. Stop and warn the user if any step has issues.

## 1. Check for uncommitted changes

```bash
git status --porcelain
```

If there are uncommitted changes, **stop and ask the user** what to do:
- Stash them (`git stash push -m "start-fresh auto-stash"`)
- Discard them
- Abort the fresh start

Do NOT silently discard work.

## 2. Switch to main and pull latest

```bash
git checkout main
git pull --ff-only origin main
```

If `--ff-only` fails, inform the user — their local main has diverged.

## 3. Clean up merged branches

List local branches that have been merged into main and delete them:

```bash
git branch --merged main | grep -v '^\*\|main$' | xargs -r git branch -d
```

Report which branches were deleted. If none, say so.

## 4. Check open todos

Use the `todo` tool to list open todos:

```
todo({ action: "list" })
```

Briefly summarize any open items so the user knows what's pending.

## 5. Compact context

Run `/compact` to reset the conversation context for a clean start.
