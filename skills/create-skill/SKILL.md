---
name: create-skill
description: Create a new skill in this pi-config repo. Use when asked to "create a skill", "add a skill", or "new skill". Ensures the skill is tracked in git and properly symlinked.
---

# Create Skill

## Architecture

Skills in this setup live in **three places** that must stay in sync:

1. **Repo** (`~/git/pi-config/skills/<name>/SKILL.md`) — the source of truth, tracked in git
2. **Pi-managed clone** (`~/.pi/agent/git/github.com/bruno-garcia/pi-config/skills/<name>/`) — synced from GitHub
3. **Symlink** (`~/.pi/agent/skills/<name>`) → points to the pi-managed clone (2)

Pi discovers skills from `~/.pi/agent/skills/`. The symlinks there point to the pi-managed clone, which syncs from GitHub. So the flow is:

```
repo → git push → GitHub → pi sync → managed clone ← symlink ← pi discovery
```

## Steps

### 1. Create the skill in the repo

```bash
mkdir -p ~/git/pi-config/skills/<name>
```

Write `~/git/pi-config/skills/<name>/SKILL.md` with valid frontmatter:

```markdown
---
name: <name>
description: <what it does and when to use it>
---

<instructions>
```

**Name rules:** lowercase, a-z, 0-9, hyphens only. Must match the directory name.

### 2. Copy to the pi-managed clone

The managed clone won't have the new skill until the next `pi sync` from GitHub. Copy it manually so the symlink works immediately:

```bash
cp -r ~/git/pi-config/skills/<name> ~/.pi/agent/git/github.com/bruno-garcia/pi-config/skills/<name>
```

### 3. Create the symlink

```bash
ln -s ~/.pi/agent/git/github.com/bruno-garcia/pi-config/skills/<name>/ ~/.pi/agent/skills/<name>
```

### 4. Verify

```bash
# Symlink resolves
cat ~/.pi/agent/skills/<name>/SKILL.md > /dev/null && echo "OK"

# All skills are symlinks (no regular directories)
ls -la ~/.pi/agent/skills/
```

### 5. Commit

Use the `commit` skill to commit the new skill to the repo.

### 6. Reload

Tell the user to run `/reload` or restart pi so the new skill appears in the system prompt.

## Common Mistake

**Never** create a skill directly in `~/.pi/agent/skills/<name>/` as a regular directory. It won't be tracked in git, won't sync across machines, and will silently diverge from the repo. Every entry in `~/.pi/agent/skills/` must be a symlink.
