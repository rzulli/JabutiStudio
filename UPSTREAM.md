# Upstream sync — Shipyard

| | |
|---|---|
| Upstream | https://github.com/defremont/Shipyard (Apache-2.0) |
| Fork | https://github.com/rzulli/JabutiStudio |
| `origin` | the fork — push here |
| `upstream` | `https://github.com/defremont/Shipyard.git` — fetch only |
| Baseline | `245d3cf13f8776c2c8385158f516e55f136a777d` (Shipyard `v1.38.0`) |

**Never push to `upstream`.** Never point the updater or any release tooling at
`defremont/Shipyard`.

## Sync procedure

```bash
git fetch upstream
git log --oneline 245d3cf..upstream/main        # what is new since the baseline
git merge upstream/main                         # or rebase on a branch, reviewed
pnpm install --frozen-lockfile && pnpm build
```

Record the new upstream SHA here after each merge that is kept.

## Where conflicts are likely

Ranked by expected pain. The first three change nearly every release.

1. `electron/main.ts` — app identity (`APP_ID`, `class`, title strings) and the
   updater gate (`UPDATES_ENABLED`). Keep both fork changes when merging.
2. `electron-builder.yml` — `appId`, `productName`, shortcut names, deleted
   `publish` block. Upstream edits to the NSIS comments merge cleanly; edits
   to the `publish` section must not be re-added.
3. `client/src/pages/Help.tsx` — a long file of Shipyard-branded prose; most
   upstream copy edits will need the word swapped back to JabutiStudio.
4. `server/src/routes/git.ts` — the `AUTO_FETCH_ENABLED` gate and the
   `/git/worktrees` route. An upstream change to the status route is the most
   likely source of a silent regression (the gate could be lost).
5. `client/src/components/git/GitPanel.tsx` — worktree badge in the branch row.
6. `client/src/lib/api.ts`, `client/src/hooks/useGit.ts` — one added method and hook each.
7. `client/index.html`, `client/public/manifest.json`, `package.json`
   (`name`, `productName`, `desktopName`, `description`).
8. `scripts/workspace-export.mjs`, `scripts/workspace-import.mjs` — data dir path strings only.

Deleted upstream file: `.github/workflows/release.yml`. If upstream changes it,
keep it deleted; it would publish to the upstream repo.

## Deliberately left as Shipyard (do not "fix" on merge)

See the list in `ARCHITECTURE.md` under "Identity that is deliberately not
renamed". In short: `SHIPYARD_*` env vars, `shipyard:*` storage keys, the MCP
server key, sync board names, the Apps Script template, "Shipyard Cloud", and
agent prompts.

## Checks after each merge

- `pnpm build` passes.
- `git grep -n "defremont/Shipyard" -- ':!UPSTREAM.md' ':!ARCHITECTURE.md'` shows
  only the upstream links that are intentionally kept (AppTitleBar and the
  Electron menu now point to the fork, so this should be empty).
- `grep -n publish electron-builder.yml` finds nothing.
- `grep -n UPDATES_ENABLED electron/main.ts` shows `false`.
- `grep -n AUTO_FETCH_ENABLED server/src/routes/git.ts` is present.
