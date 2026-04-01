# pi-diff-review

> Forked from [badlogic/pi-diff-review](https://github.com/badlogic/pi-diff-review).
> This code is purely AI slop. I don't know JavaScript.

Native diff review window for pi with vim keybindings, powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco.

```
pi install git:https://github.com/nrupatunga/pi-diff-review
```

## Usage

### Review uncommitted changes (default)

```
/diff-review
```

Opens a diff review window comparing the working tree against HEAD — same as the upstream behavior.

### Review a different directory

```
/diff-review ~/other-repo
```

### Compare two branches directly

```
/diff-review main feature-branch
/diff-review origin/main origin/feat/wake-word
```

Compares any two git refs (branches, tags, commits). The first ref is the base (old), the second is the compare (new).

### Interactive branch picker

```
/diff-review-branches
```

Fetches all local and remote branches (sorted by most recent commit) and shows a fuzzy-searchable picker:

1. Type to filter branches — shows top 10 matches
2. `↑↓` to navigate, `Enter` to select, `Esc` to cancel
3. Pick the base branch, then the compare branch
4. Diff review window opens automatically

### Repeat the last branch comparison

```
/diff-review-last
```

Re-runs the most recent branch-to-branch review from this session, so you don't need to type refs or re-pick branches.

Press `?` inside the review window for all shortcuts.

**Tip:** Add large/binary files to `.gitignore` before running — the UI loads the full diff payload into memory, so big files will slow it down or crash.

## Vim keybindings

| Key | Action |
|-----|--------|
| `j / k` | Move cursor down / up |
| `Ctrl-d / Ctrl-u` | Half-page down / up |
| `gg / G` | Beginning / end of file |
| `n / p` | Next / previous change hunk |
| `v` | Start visual line selection |
| `s` | Select whole hunk (from visual mode) |
| `a` | Add comment |
| `y` | Yank (copy) to clipboard |
| `dd / x` | Delete comment at cursor |
| `Ctrl-h / Ctrl-l` | Focus original / modified pane |
| `Tab` | Toggle pane |
| `J / K` | Next / previous file |
| `r` | Mark reviewed |
| `o` | Overall note |
| `b` | Toggle sidebar |
| `Enter` | Submit review |
| `q` | Cancel |
| `?` | Help |
| `Esc` | Cancel selection / delete draft |

## What changed from upstream

- **Branch-to-branch diff review** — `/diff-review <branch1> <branch2>` to compare any two refs
- **Interactive branch picker** — `/diff-review-branches` with fuzzy search, scrolling, keyboard navigation
- Linux stability fixes (env sanitization, missing Glimpse backend, large payload protection)
- Vim-style keyboard navigation and commenting
- Block cursor, Typestar OCR font, responsive sizing
- C/C++ syntax highlighting
- Sidebar toggle, yank with flash, line range comments
