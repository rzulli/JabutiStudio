# JabutiStudio — Architecture

JabutiStudio is the human management, visualization and editing layer for the
Estúdio Jabuti. It is a fork of [Shipyard](https://github.com/defremont/Shipyard)
(Apache-2.0) and keeps Shipyard's stack: Fastify server, React client, Electron
shell, JSON files under `data/`.

## Boundaries

| Component | Owns | Does not own |
|---|---|---|
| **JabutiStudio** (this repo) | tasks, agents and their sessions, Git and worktree *inspection*, human decisions, views, generic tools | gameplay, economy, perks, Godot, saves, design content |
| **Adapters** (future, per source) | translation of an external system's files or API into JabutiStudio records | storage of truth; they read and write through the app |
| **PNMG** (`C:\dev\GAMEDEV_V2\PNMG\repo`) | game code, design data, `.tres`, saves, content | anything in JabutiStudio's data dir |
| **GODOT_AGENT_HARNESS** | Godot execution and test runs | task state or Git management |

Rules that follow from this:

- JabutiStudio never becomes a second source of truth for a fact another
  system already owns. A task that describes a PNMG change points at the PNMG
  repo; it does not copy the design.
- No new canonical graph or database. Persistence stays in JSON under `data/`
  (or the Electron data dir), written through the atomic helpers already in
  `server/src/services/`.
- JabutiStudio does not run Godot and does not write to a project checkout
  unless the user asks it to through an existing Git action.

## Runtime layout

```
client/   React 18 + Vite + Tailwind (UI, polls the API)
server/   Fastify 5 on 127.0.0.1:5420 (dev) — routes/, services/
electron/ desktop shell; starts the server as a child process (prod port 5430)
data/     JSON state (projects, tasks, settings, AI/cloud/deploy credentials)
```

Dev: `pnpm dev` starts server (5420) and client (5421, proxies `/api`).

## Data location

| Mode | Data dir |
|---|---|
| `pnpm dev` | `C:\dev\JabutiStudio\data` (inside the checkout, gitignored) |
| Electron (installed) | `%APPDATA%\JabutiStudio\data` (from `productName`) |
| Override | `SHIPYARD_DATA_DIR` env var (kept name, see below) |

The upstream Shipyard installer uses `%APPDATA%\Shipyard\data`. The two never
share files.

## Identity that is deliberately *not* renamed

These carry Shipyard's name for compatibility with existing data, agents or
third-party services. Renaming them would break something without benefit.

- `SHIPYARD_*` environment variables and `shipyard:*` localStorage / CustomEvent keys.
- MCP server key `shipyard` and the `mcp__shipyard__*` tool names that agents
  have in their configs.
- Trello/ClickUp board and list names `Shipyard · <project>` (renaming would
  create duplicate boards for the same project).
- The Google Sheets Apps Script template ("Shipyard Sync v2").
- "Shipyard Cloud" — the sync service the owner runs; it is not a JabutiStudio service.
- Internal workspace package names `shipyard-client` / `shipyard-server` (pnpm filters depend on them).
- Agent prompts (`aiResolvePrompt.ts`, `aiManagePrompt.ts`, `promptBuilder.ts`):
  agents already know the "Shipyard API" wording.

## Safety defaults added by the fork

- **Auto-update off** (`UPDATES_ENABLED` in `electron/main.ts`, no `publish`
  block in `electron-builder.yml`). Nothing fetches upstream builds.
- **Automatic `git fetch` off** (`JABUTI_AUTO_FETCH=1` to re-enable). Upstream
  fetches on every status poll, which contacts the remote and writes
  remote-tracking refs. Inspecting a live checkout must not do that.
- **Read-only worktree listing** (`GET /api/projects/:id/git/worktrees`, shown as
  a badge in the Git panel). It lists `git worktree list`; it never creates,
  removes, prunes or repairs worktrees. `gitService.pruneWorktrees` exists
  upstream but has no caller and must stay that way.
- Upstream `release.yml` removed: it publishes releases to the upstream repo.

## Adapters and the PNMG pilot

PNMG is registered as a normal project (`/api/projects/add`). Everything the
UI shows for it comes from read-only Git commands and directory listing. The
read-only status is a convention in this release, not an enforced permission:
the existing mutating actions (commit, stage, push, pull, checkout, discard)
are still available on any registered project. A per-project read-only mode is
on the roadmap (step 1).
