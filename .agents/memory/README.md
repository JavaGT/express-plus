# Agent memory

Shared persistent memory for **all** agents working in this repo (Claude Code, opencode, Codex, …). Claude's per-project memory dir (`~/.claude/projects/-Users-server-Code-workbench/memory`) is a symlink to this directory, so Claude's auto-recall and other agents read and write the same files. Same system as Scope's `.agents/memory/` (set up 2026-07-17).

## How to use it

- **`MEMORY.md` is the index** — one line per memory. Read it first; open individual files only when the hook is relevant to your task.
- Each memory is one file holding one durable fact, with frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary — used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines.>
```

- Types: `user` — who the user is; `feedback` — guidance the user gave on how to work (include the why); `project` — ongoing work, goals, incidents, constraints not derivable from code or git history; `reference` — pointers to external resources.
- Link related memories with `[[their-name]]` (the other file's `name:` slug).
- After writing a file, add a one-line pointer in `MEMORY.md`: `- [Title](file.md) — hook`. Never put memory content in the index itself.
- Before saving, check for an existing file that covers it — **update it** rather than duplicating; delete memories that turn out to be wrong (and their index line).
- Don't save what the repo already records (code structure, git history, AGENTS.md, DECISIONLOG.md) or what only matters to your current conversation.
- Memories record what was true when written — verify a named file/flag/command still exists before acting on it.
