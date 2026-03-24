# pi-diff-review

> Forked from [badlogic/pi-diff-review](https://github.com/badlogic/pi-diff-review) with stability fixes, vim keybindings, and UI improvements.

Native diff review window for pi, powered by [Glimpse](https://github.com/hazat/glimpse) and Monaco.

```
pi install git:https://github.com/nrupatunga/pi-diff-review
```

## What it does

Adds a `/diff-review` command to pi.

The command:

1. collects the current git diff against `HEAD`
2. opens a native review window
3. shows changed files in a Monaco diff editor with vim-style navigation
4. lets you draft comments on the original side, modified side, or whole file
5. inserts the resulting feedback prompt into the pi editor when you submit

## Changes from upstream

### Stability & Linux fixes
- **Auto-restore missing `chromium-backend.mjs`** — postinstall script fetches it if the npm package omits it
- **Sanitize Linux env** before opening Glimpse — strips Anaconda `LD_LIBRARY_PATH` and bad `DBUS_SYSTEM_BUS_ADDRESS` to prevent noisy Chromium errors
- **Large diff payload protection** — per-file truncation (250K chars), total payload cap (2M chars), binary file detection and skip
- **Skip `.pi/`, `node_modules/`, `.git/`** directories from diff, cap at 200 files
- **Pin `glimpseui` to git source** (`github:hazat/glimpse`) to ensure `chromium-backend.mjs` is always included

### Vim keybindings
Full keyboard-driven review flow — press `?` inside the review window to see all shortcuts.

| Key | Action |
|-----|--------|
| `j / k` | Move cursor down / up |
| `Ctrl-d / Ctrl-u` | Half-page down / up |
| `gg` | Go to beginning of file |
| `G` | Go to end of file |
| `n / Ctrl-n / ]c` | Next change hunk |
| `p / Ctrl-p / [c` | Previous change hunk |
| `v` | Start visual line selection |
| `a` | Add comment on current line or selection |
| `y` | Yank (copy) selection to clipboard |
| `dd / x` | Delete comment at cursor |
| `Esc` | Cancel selection / delete empty draft |
| `h / l` | Focus original (left) / modified (right) pane |
| `Tab` | Toggle focused pane |
| `J / K` | Next / previous file (follows sidebar order) |
| `r` | Mark file reviewed |
| `o` | Overall note |
| `b` | Toggle sidebar |
| `Enter` | Submit review (in editor) / confirm (in comment) |
| `Ctrl-Enter` | Submit review |
| `q` | Cancel review |
| `?` | Toggle help overlay |
| `Ctrl+Shift+D` | Toggle key debug overlay |

### UI improvements
- **Block cursor** with yellow highlight (vim-style)
- **Typestar OCR** font for editor and UI (with monospace fallbacks)
- **Reduced font sizes** — 11px sidebar, 11–13px responsive editor
- **C/C++ syntax highlighting** (`.c`, `.h`, `.cc`, `.cpp`, `.hpp`, etc.)
- **Line range selection** — select lines 10–15, click gutter or press `a` to comment on the range
- **Yank flash** — yellow highlight animation on copied lines
- **Sidebar toggle** — press `b` to hide/show file tree (CSS-driven, no layout hacks)
- **Cursor line sync** — switching panes with `h/l/Tab` carries cursor position
- **Auto-focus left pane** on startup
- **Responsive window size** (1440×900)

## Requirements

- macOS, Linux, or Windows
- Node.js 20+
- `pi` installed
- internet access for the Monaco CDN used by the review window

### Windows notes

Glimpse now supports Windows. To build the native host during install you need:

- .NET 8 SDK
- Microsoft Edge WebView2 Runtime
