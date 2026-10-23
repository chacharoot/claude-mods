# claude-mods

**English** | [繁體中文](README.zh-TW.md)

Three Claude Code mods (hooks-module plugins), each a pane that stays open beside the conversation. They work on macOS and Windows.

| Mod | In one line | Command |
| --- | --- | --- |
| **agent-zoo** | Every sub-agent and fork is a little 3D pixel robot; open one to see what it is doing right now | `/agent-zoo` |
| **todo-history** | The whole history of the todo list: undo one task alone, go back to any step, and the list follows a rewind | `/todos` |
| **session-manager** | Every Claude Code session on this machine: search, resume, open a background session, and see your remaining usage | `/sessions` |

```
/plugin install agent-zoo --marketplace chacharoot/claude-mods
/plugin install todo-history --marketplace chacharoot/claude-mods
/plugin install session-manager --marketplace chacharoot/claude-mods
```

## Preview

**agent-zoo**: a running agent hops, a finished one smiles. Press "▸ 看進度" (progress) to see what it said and which tools it used.

<img src="docs/agent-zoo.png" alt="agent-zoo: two finished agents, each a pixel robot" width="480">

**todo-history**: the current-list page shows progress and lets you undo one item; the history page shows every step, lets you go back to any of them, and lists agents and forks too.

<img src="docs/todo-current.png" alt="todo-history current list: 1 of 3 done" width="480"> <img src="docs/todo-history.png" alt="todo-history history: restores, a rewind, agents and forks" width="480">

**session-manager**: sessions grouped by folder, with the 5-hour and 7-day usage left at the top.

<img src="docs/sessions.png" alt="session-manager: usage left and the session list" width="480">

The panes' labels are in Traditional Chinese.

## session-manager

Lists every Claude Code session on this machine, grouped by folder, clickable.

- Search: type to filter by title, folder or prompt; Enter searches the content of every conversation
- Press a session to expand its details:
  - Open in a terminal → **Jump** (Terminal and iTerm switch to its tab; Warp only brings the app forward)
  - A background session (started by `/fork` or `--bg`, with no window of its own) → **Open**: runs `claude attach` in a new tab to enter it; press ← on an empty prompt to leave, and it keeps running in the background
  - Closed → **Resume** in a new window (Warp, iTerm or Terminal; `a` switches)
  - **Rename** (writes the same record as `/rename`), **Copy command**, **Delete** (to the trash, recoverable)
- **+ New**: start a session in a folder you pick
- Under the header: the usage left in the 5-hour and 7-day windows, and when each resets
- Command: `/sessions`

Needs Python 3 (to read transcripts over 4 MB; it tries `python3`, `python`, `py -3` in turn). On Windows without Python it runs the same features in the built-in PowerShell, with nothing to install.

| | macOS | Windows |
| --- | --- | --- |
| List, search, rename | ✓ | ✓ |
| Resume / new | Warp, iTerm, Terminal | A new Windows Terminal tab (a cmd window without `wt`) |
| Jump to an open session | Terminal and iTerm switch tabs; Warp only brings the app forward | Says where it is (Windows Terminal cannot be told to select a tab) |
| Open a background session | `claude attach` in a new window | `claude attach` in a new Windows Terminal tab |
| Delete | To the Trash | To the Recycle Bin |
| Copy command | Shell syntax | PowerShell syntax |

## agent-zoo

Every sub-agent is a shaded 3D robot (half-block pixels in the terminal; Windows Terminal, Warp and iTerm all draw it), colored by type: it hops and looks around while running, closes its eyes while waiting, smiles when done, and shows a cross when it fails. Beside it: its type, how long it has run, how many tools it used and what it is doing now; one quiet for over 60 seconds is flagged as possibly stuck.

**Press "▸ 看進度"** (or a whole row in list mode) to open that agent's live progress: the task it was given, what it said, the tools it called and their results, refreshed while it runs. **Open the whole conversation** switches the main view to its full transcript. Press `l` for **list mode**: one line per agent, nested under the agent that spawned it, with agent-team teammates grouped by team, so many agents fit. A teammate that finishes a turn shows as waiting (for its next message), not done.

Robots are 10×5 cells by default; `/agent-zoo big` brings back the original 18×9 ones (`/agent-zoo small` switches back; the choice is remembered).

Commands: `/agent-zoo` opens the pane, `/agent-zoo compact` toggles list mode, `/agent-zoo big` / `small` sets the robot size, `/agent-zoo clear` drops finished agents.

## todo-history

Records a step every time Claude's todo list (`TodoWrite`) or tasks (`TaskCreate` / `TaskUpdate`) change; where Claude Code offers no such tool, todo-history serves its own `todo` tool to Claude. The main conversation, each sub-agent and the shared task list are kept apart. Steps read `▶ started`, `✓ done`, `+ added`, `− removed`.

Three ways back, each with its own reach:

| You want | How | What changes |
| --- | --- | --- |
| **Undo one task**, keep the other tasks' work | On the current list, press the item → **Undo this task** | Only the files it edited go back to how they were before it started. A file that later work also edited is not overwritten: the task's own diff goes to Claude, asking it to take out that part alone. The task goes back to ☐ |
| **Drop everything after a step**, keep the conversation | In the history, press the step → **Back to this step** | The list goes back to that step, and every file edited since with Edit / Write is restored (files created since are deleted) |
| **Drop everything after a step**, conversation included | Claude Code's rewind (Esc twice) | The rewind handles the conversation and code; todo-history notices within seconds and brings the list back to that point (a `↶ rewind` step) |

The first two record a "📌 state before …" step first, with a copy of every file they touch, so a wrong press can be undone from there; afterwards your next message tells Claude what happened. The history also shows sub-agents and forks starting and finishing (🤖 / ⑂).

Files changed by Bash or PowerShell are not recorded. A rewind is recognized by comparing the conversation (shorter, with exactly the same messages before the cut; `/compact` is never mistaken for one). The history and file copies live in `~/.claude/todo-history/<session id>/`.

The pane has two pages: **current list** (`1`) and **history** (`2`). While work is left, a line above the prompt shows the task in progress (`▶ … ✓ 1/3`). The history follows the session: a new session starts empty, and `claude -c` / `--resume` brings the list and history back.

Commands: `/todos` opens the pane, `/todos clear` forgets this session's history.

## Install

This is a private repo: you need an invitation to it, and git on your machine must be able to read github.com (an SSH key, or `gh auth login` then `gh auth setup-git`); installing asks for no password.

In Claude Code's prompt:

```
/plugin install session-manager --marketplace chacharoot/claude-mods
/plugin install agent-zoo --marketplace chacharoot/claude-mods
/plugin install todo-history --marketplace chacharoot/claude-mods
```

The first one asks `Add marketplace?`: press `y`, then Enter for the user scope. It works in that session at once, and in every new session after.

From a shell:

```
claude plugin install session-manager --marketplace chacharoot/claude-mods
claude plugin install agent-zoo --marketplace chacharoot/claude-mods
claude plugin install todo-history --marketplace chacharoot/claude-mods
```

In the desktop app, where `/plugin` is not available: press **+** beside the prompt → **Plugins** → **Add marketplace**, enter `chacharoot/claude-mods` → **Add plugin**.

## Update

```
claude plugin update session-manager@claude-mods
claude plugin update agent-zoo@claude-mods
claude plugin update todo-history@claude-mods
```

Then run `/reload-plugins` in Claude Code. What changed: [CHANGELOG.md](CHANGELOG.md) (in Traditional Chinese).
