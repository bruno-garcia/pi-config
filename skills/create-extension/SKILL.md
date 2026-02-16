---
name: create-extension
description: Create a new extension in this pi-config repo. Use when asked to "create an extension", "add an extension", or "new extension". Ensures the extension is tracked in git and available immediately.
---

# Create Extension

## Architecture

Extensions in this setup live in **two places**:

1. **Repo** (`~/git/pi-config/extensions/<name>.ts` or `~/git/pi-config/extensions/<name>/index.ts`) — the source of truth, tracked in git
2. **Pi-managed clone** (`~/.pi/agent/git/github.com/bruno-garcia/pi-config/extensions/<name>*`) — synced from GitHub

Pi auto-discovers extensions from installed packages (the managed clone), so **no symlink is needed** — unlike skills, which require symlinks in `~/.pi/agent/skills/`.

```
repo → git push → GitHub → pi sync → managed clone → pi auto-discovery
```

## Steps

### 1. Create the extension in the repo

**Single file:**
```bash
# Write to ~/git/pi-config/extensions/<name>.ts
```

**Directory (multi-file or with dependencies):**
```bash
mkdir -p ~/git/pi-config/extensions/<name>
# Write ~/git/pi-config/extensions/<name>/index.ts (entry point)
```

The extension must export a default function that receives `ExtensionAPI`. Read the extension docs if unsure about the API.

### 2. Copy to the pi-managed clone

The managed clone won't have the new extension until the next `pi sync` from GitHub. Copy it manually so it's available immediately:

**Single file:**
```bash
cp ~/git/pi-config/extensions/<name>.ts ~/.pi/agent/git/github.com/bruno-garcia/pi-config/extensions/<name>.ts
```

**Directory:**
```bash
cp -r ~/git/pi-config/extensions/<name> ~/.pi/agent/git/github.com/bruno-garcia/pi-config/extensions/<name>
```

### 3. Verify

```bash
# File exists in managed clone
cat ~/.pi/agent/git/github.com/bruno-garcia/pi-config/extensions/<name>.ts > /dev/null && echo "OK"
```

### 4. Commit

Use the `commit` skill to commit the new extension to the repo.

### 5. Reload

Tell the user to run `/reload` or restart pi so the new extension is loaded.

## Common Mistake

**Do NOT create a symlink** in `~/.pi/agent/extensions/` pointing to the managed clone. The `pi install` package already auto-discovers extensions from the managed clone. A symlink would cause the extension to load twice, resulting in command conflicts.

**Do NOT create an extension directly in `~/.pi/agent/extensions/`** as a regular file. It won't be tracked in git and won't sync across machines.
