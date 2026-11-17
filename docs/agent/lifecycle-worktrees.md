# Lifecycle de tarefas, worktrees e multi-repo Git

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Ciclo de vida da tarefa (R2-A1: entrega, aceite, integracao)
- `taskLifecycle.ts` **deriva** `READY -> RUNNING -> REVIEW -> ACCEPTED -> INTEGRATED -> CLOSED` a cada leitura; nao ha
  estado novo na task. Quatro fatos, cada um com a sua autoridade: **execucao** (status + sessoes vivas), **entrega**
  (commits `alvo..branch` da task, no Git), **aceite** (registro humano) e **integracao** (`merge-base --is-ancestor`).
  `done` do agente e so execucao: nunca vira aceite nem integracao
- O unico dado gravado e o **aceite**, em `data/task-lifecycle/{projectId}.json` (`taskLifecycleStore.ts`), fora do
  arquivo de tasks de proposito (MCP `update_task`, pull do Trello e cloud sync nao o forjam nem apagam; nao e sincronizado).
  Preso ao sha do commit revisado: a branch andou = `lapsed`, revisar e aceitar de novo. Guarda tambem o historico
  (accepted / acceptance-revoked / integrated / integration-refused). Mesma ressalva do DK: `fromAppUi` e forjavel por
  qualquer processo local; o registro prova que alguem chamou a rota, nao que uma pessoa clicou. **Nao existe tool MCP
  de aceitar nem de integrar — nao criar**
- Rotas (`routes/taskLifecycle.ts`): `GET /api/projects/:id/tasks/:tid/lifecycle` (aberta), `POST .../lifecycle/accept`
  (`targetBranch` + `expectedHeadSha` obrigatorios: o alvo nunca e adivinhado), `DELETE .../lifecycle/accept`,
  `POST .../lifecycle/integrate` (`targetBranch`, `expectedHeadSha`, `branch`) — as tres so do navegador (403 senao)
- Integrar = `git merge --no-ff <sha aceito>` no checkout do projeto (nunca o nome da branch), com tudo relido do Git na
  hora: aceite valido para esse sha e esse alvo, branch = a da task (`wrong-branch`), worktree limpa e registrada no git
  para essa branch, checkout do projeto **na branch alvo, limpo e sem merge/rebase em andamento**, `merge-tree` sem
  conflito, sem sessao do agente trabalhando. Falhou = `merge --abort`, alvo intacto. Depois confirma por
  ancestralidade; so entao grava o historico e move a task para done (timestamps cascading intactos)
- Patch equivalente sem ancestralidade (cherry-pick, rebase, squash) e um caso proprio (`patch-equivalent`): reportado,
  nunca tratado como integrado, nao aceitavel. Branch sem commits alem do alvo = `nothing-to-integrate`
- So existe para task com worktree criada pelo Shipyard (`task.worktreeBranch`). Sem branch o estado diz `no-branch`:
  nada e verificavel. Worktrees criadas a mao (ex.: PNMG/worktrees) nao estao ligadas a task nenhuma
- UI: a aba Review do TaskViewer (`LifecycleBar.tsx` + `TaskReviewPanel`). Com branch, a revisao e exata (branch vs
  alvo) em vez da janela de datas, que olhava o checkout do projeto e nao a worktree da task
- `removeTaskWorktree` apaga a branch com `-d`, nao `-D`: branch com commits fora do checkout sobrevive. CLOSED = integrado
  e worktree removida (limpeza continua manual / varredura existente)
- **Board**: o cartao `done` nao mostra mais o check verde fixo — `lifecycleVisual` (`lib/taskVisuals.ts`, fonte unica)
  devolve icone, chip e grupo: `Review` (warning, o unico tom quente = "precisa de voce"), `Ready to merge` (primary),
  `Merged` (neutro), `Re-review`/`Conflict` (destructive), `Equivalent`, `No changes`, `Branch gone`. Tres pontinhos
  no chip = entregue/aceito/integrado, o mesmo vocabulario da `LifecycleBar`. A coluna Done agrupa em **Needs review ·
  Ready to merge · Other** e esconde os integrados atras de "Show N merged" (filtro ativo mostra tudo: match nunca some).
  Tarefa **sem `worktreeBranch` fica fora** (nada verificavel; cai no unread/read antigo, sem chip)
- Dados do board: `GET /api/projects/:id/lifecycle/summary` (`summarizeProject`): uma chamada para o projeto todo, so
  tarefas com branch, sem dirty scan nem diff (rev-parse, is-ancestor, rev-list --count; cherry e merge-tree so para
  `done`/aceita), 4 branches por vez, cache de 5 s por projeto derrubado por qualquer escrita de aceite/integracao. Usa
  o mesmo `deriveStage` do `resolveLifecycle`, entao nao pode discordar da aba Review. Cliente: `useLifecycleSummary`
  (10 s, so com o board montado) e `LifecycleMapContext` no `TaskBoard`
- Testes: `server/test/taskLifecycle.test.ts` (repos Git reais, worktree pelo mecanismo oficial, rotas com os headers do renderer)

### Worktrees: inventario, vinculo manual e encerramento seguro (R2-A2)
- **Inventario** (`worktreeInventory.ts`, `GET /api/projects/:id/worktrees/inventory`): le `git worktree list` (inclui as criadas a mao),
  cruza com tasks/lifecycle e devolve **flags que coexistem** (`taskLinked`, `unlinked`, `integrated`, `unmerged`, `dirty`, `busy`, `unknown`)
  mais `cleanup.blockers` (por que nao pode remover). `unlinked` nao e "orfa"; limpa nao e "segura". Cache 8 s, derrubado por escritas de lifecycle/link
- **Vinculo manual** (`worktreeLinks.ts`, `data/worktree-links/{projectId}.json`; `POST/DELETE .../worktrees/link`, so UI): grava SO o vinculo —
  nunca toca worktree, task, aceite ou branch. Nunca por nome. Recusa colisao (pasta ou branch ja reivindicada, task ja com outra worktree), checkout principal e HEAD solto.
  `withLink(task)` faz o lifecycle enxergar a task como dona; o arquivo de tasks nao e escrito
- **Alteracoes** (`worktreeChanges.ts`, `GET .../worktrees/changes|diff`): rastreadas/staged/untracked/deleted/renamed/ignoradas e analise de `.tres`
  (`apparent-reserialization` | `material` | `unknown`; `ext_resource` perdido = sempre material). So informativo: **nunca autoriza descarte**; nao ha limpeza especial de `.tres`
- **Encerramento** (`worktreeClose.ts`; `GET .../lifecycle/close-preview`, `POST .../lifecycle/close`, so UI): exige INTEGRATED provado por ancestralidade no alvo aceito,
  aceite = sha integrado, worktree da task, sem mudanca/untracked, sem sessao, sem operacao git, sem lock, caminho dentro do registro do git, nunca o checkout principal.
  Ignorados exigem `acknowledgeIgnored`. A previa devolve um `token` do estado revisado; o POST reler tudo e recusa (`state-changed`) se algo mudou.
  Sem `--force`, sem `branch -D`: pasta via `git worktree remove` simples; branch so se `refs/heads/x` ainda e o sha provado e esse sha e ancestral do alvo.
  Cada metade e registrada (`closure` no ledger): falha parcial mantem INTEGRATED com blocker (`closure-incomplete`); so pasta+branch sumidos = CLOSED
- UI: `LifecycleBar` (botao "Close worktree…" + `CloseWorktreePanel`) e `WorktreeManager` (dialogo aberto pelo badge "N worktrees" do Source Control)
- Em dev (Vite 5421) as escritas de UI levam 403 por Origin diferente do Host; o encerramento so e testavel pelo app servido pelo server
- Testes: `server/test/worktreeClose.test.ts` (T1-T16 do R2-A2, repos descartaveis)

### Multi-repo Git (sub-repositorios)
- Projeto pode conter sub-pastas com `.git` proprio (ex: `client/` e `server/` dentro de `Sistema01/`)
- `detectSubRepos()` em projectDiscovery.ts escaneia 1 nivel de profundidade
- `subRepos` armazena caminhos relativos dos sub-repos encontrados
- Todas rotas git aceitam parametro opcional `subrepo` (query para GET, body para POST)
- O seletor de repo no Source Control e um **dropdown com filtro**
  (`RepoSelector` em GitPanel.tsx) — uma fila de tabs era ilegivel num painel de
  280px com 12 sub-repos. A escolha e lembrada por projeto em
  `shipyard:git-repo:{projectId}` e restaurada ao voltar pro projeto
- Cada linha do seletor mostra o que o repo ainda segura (`RepoPending`:
  arquivos sem commit e commits sem push, em `warning`; repo limpo nao mostra
  nada). So monta com o dropdown aberto e usa a chave do `useGitStatus` — o
  seletor fechado nao faz poll de 12 repos
- Query keys incluem `subrepo`: `['git-status', projectId, subrepo]`
- **Git fala em caminho relativo ao repo; editor e rotas de arquivo, relativo
  ao projeto.** `lib/repoPath.ts` (`toProjectPath` / `toRepoPath`) converte, e
  o `SingleRepoPanel` e quem traduz na saida para o editor. A aba do editor
  guarda o caminho **do projeto**; o `DiffTabContent` volta ao do repo para
  pedir o ref ao git. Sem isso, arquivo de sub-repo abria vazio: a leitura
  falhava e aba de diff engole o erro como "sem conteudo"

### Worktree por tarefa (agentes em paralelo)
- Desligado por padrao. Settings > AI & Integrations > Task worktrees liga
  (`worktreePerTask`) e escolhe a pasta base (`worktreeBasePath`, default
  `data/worktrees`); ambos vivem no `settings.json`
- `worktreeService.ts` e o unico dono do assunto: `ensureTaskWorktree` (cria ou
  reusa), `removeTaskWorktree`, `listWorktrees`, `cleanupWorktrees`. Ele grava
  `task.worktreePath` / `task.worktreeBranch`; `replaceTasks` copia os dois do
  `existing`, senao todo pull de sync os apaga
- Branch e pasta: `shipyard/task-{numero}-{slug}` e
  `{projectId}-task-{numero}-{slug}`. **A unicidade vem do numero da task** — o
  git recusa checar a mesma branch em duas worktrees, entao o slug e so leitura
- Tres portas de entrada, todas passando por `ensureTaskWorktree` (idempotente):
  `start_task` do MCP (devolve `cwd` na resposta), `POST /:id/tasks/:tid/ai-resolve`
  (o prompt ja cita a worktree) e `POST /api/terminal/sessions` com `taskId`
  (a sessao roda la dentro, via o parametro `cwd` do `createSession`)
- Falhar criando a worktree **nunca** bloqueia o lancamento: `ensureTaskWorktree`
  loga e devolve `project.path` com o motivo
- **Nao ha remocao fora do encerramento seguro (R2-A3).** O unico caminho que apaga
  pasta ou branch de worktree e `worktreeClose.closeTask` (previa + token + `git
  worktree remove` sem `--force` + `update-ref -d` com sha esperado). **Excluir task** (HTTP single/bulk e MCP `delete_task`/`bulk_delete_tasks`)
  passa antes por `worktreeService.canDeleteTask`: task sem worktree/branch (ou com nada mais
  no disco/Git) apaga normal; com worktree que a previa permite fechar, roda o encerramento
  seguro e so entao apaga; com worktree que nao pode fechar (nao integrada, mudancas locais,
  sessao viva...) **a task fica** (409 `worktree-pending` com o motivo; no bulk, `blocked[]`).
  A task e o unico registro de por que a worktree existe: nunca se apaga uma sem a outra, e
  nada e forcado nem removido para permitir a exclusao. `cleanupWorktrees` e a varredura de 6h (`startWorktreeCleanup`) so rodam `git worktree
  prune` (esquece registro de pasta que ja sumiu); a varredura por idade, a limpeza
  `all: true` e o `rm -rf` de pastas orfas foram removidos, e `gitService.removeWorktree`
  / `deleteBranch` (force, `-D`) deixaram de existir. O cartao "Task worktrees" em Settings
  nao tem mais botao de limpar: aponta para a aba Review / o badge de worktrees
- `DELETE /api/projects/:id/files` recusa (409) pasta que e ou contem uma worktree
  linkada do projeto
- Fora do escopo desta regra (acao explicita do usuario sobre o checkout do projeto):
  `git/discard` e `git/discard-all` do Source Control e o terminal integrado
- Teste: `server/test/worktreeLegacy.test.ts` (L1-L7)
- Deletar task (HTTP e MCP, individual e bulk) le a task antes de apagar: sem
  isso ninguem mais aponta para a worktree
