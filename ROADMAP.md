# JabutiStudio — Roadmap

Ordered. Each step is a separate QP. Nothing here migrates FILA.md, ACTIVE.md
or the existing QPs unless a step says so.

1. **Safe worktree management and diagnosis.** Per-project read-only mode
   (refuses mutating Git and worktree actions), `git worktree list` with
   diagnostics (missing directory, prunable record, dirty, branch checked out
   twice), and explicit, confirmed cleanup. Starts from the read-only listing
   that exists now.
2. **Import and reconcile existing QPs.** Read PNMG's QP files and FILA/ACTIVE
   as data, map them onto tasks, report divergences. Import is one-way until
   reconciliation is trusted.
3. **Human decision records with provenance.** Decisions linked to the task,
   the commit or document they came from, who recorded them and when.
4. **Graph Explorer.** Read-only visualization of relations already present in
   the other sources (tasks, commits, worktrees, decisions). No new canonical graph.
5. **Godot adapter and receipt viewer.** Show GODOT_AGENT_HARNESS receipts
   next to the task that produced them. The adapter reads receipts; it does not run Godot.
6. **Economy and perk editors.** Editing belongs to PNMG's own data files;
   JabutiStudio provides the form, validation through PNMG's tooling, and Git
   diff. Not started until 1–5 are in use.

## Pending in the fork itself (not blocking the list above)

- Visual identity (icon, colours, splash) — separate QP.
- Windows installer signing; unsigned builds show SmartScreen warnings.
- Per-project read-only mode (step 1) — until then the PNMG checkout is read
  with convention only.
