---
name: commit
description: "Read this skill before making git commits, rebases, merges, cherry-picks, or any git operation"
license: From mitsuhiko/agent-stuff
---

## CRITICAL — Never open an interactive editor

**This applies to ALL git operations, not just commits.**

Any git command that opens an editor will hang the agent forever. Always prevent this:

| Command | Safe version |
|---------|-------------|
| `git commit` | `git commit -m "message"` |
| `git rebase --continue` | `GIT_EDITOR=true git rebase --continue` |
| `git merge --continue` | `GIT_EDITOR=true git merge --continue` |
| `git cherry-pick --continue` | `GIT_EDITOR=true git cherry-pick --continue` |
| `git revert --continue` | `GIT_EDITOR=true git revert --continue` |
| `git rebase -i` | **Never use** — use non-interactive rebase only |
| Any `--continue` after conflict resolution | Always prefix with `GIT_EDITOR=true` |

**Rule: Every `--continue` gets `GIT_EDITOR=true`. No exceptions.**

---

## Commit format

Create commits using Conventional Commits: `<type>(<scope>): <summary>`

- `type` REQUIRED. Use `feat` for new features, `fix` for bug fixes. Other common types: `docs`, `refactor`, `chore`, `test`, `perf`.
- `scope` OPTIONAL. Short noun in parentheses for the affected area (e.g., `api`, `parser`, `ui`).
- `summary` REQUIRED. Short, imperative, <= 72 chars, no trailing period.

## Notes

- Body is **strongly encouraged** — always include one unless the change is trivially obvious (e.g., fixing a typo). The body should explain **what** changed, **why** it changed, the approach taken, and any notable decisions. A reader of `git log` should understand the change without looking at the diff.
- Do NOT include breaking-change markers or footers.
- Do NOT add sign-offs (no `Signed-off-by`).
- Only commit; do NOT push.
- If it is unclear whether a file should be included, ask the user which files to commit.
- Treat any caller-provided arguments as additional commit guidance. Common patterns:
  - Freeform instructions should influence scope, summary, and body.
  - File paths or globs should limit which files to commit. If files are specified, only stage/commit those unless the user explicitly asks otherwise.
  - If arguments combine files and instructions, honor both.

## Steps

1. Infer from the prompt if the user provided specific file paths/globs and/or additional instructions.
2. Review `git status` and `git diff` to understand the current changes (limit to argument-specified files if provided).
3. (Optional) Run `git log -n 50 --pretty=format:%s` to see commonly used scopes.
4. If there are ambiguous extra files, ask the user for clarification before committing.
5. Stage only the intended files (all changes if no files specified).
6. Run `git commit -m "<subject>"` (and `-m "<body>"` if needed).
