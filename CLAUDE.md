# Shipyard (JabutiStudio) - Local Development Dashboard

Dashboard web local para projetos, tarefas, git, terminais e AI. Complementa o VS Code.
Este arquivo e o **contrato operacional curto**. O detalhe por dominio fica em `docs/agent/*.md`
e **so e lido quando voce for mexer naquele dominio** (veja "Mapa de docs").

## Comandos

```bash
pnpm dev                          # client (5421) + server (5420)
pnpm --filter shipyard-server test   # testes do server (repos Git reais, fixtures)
npx tsc --noEmit                  # typecheck (client e server separados)
pnpm dist:win|mac|linux           # Electron (opcional)
```

Portas: backend **5420** (dev) / **5430** (Electron prod); Vite **5421** (proxy /api -> 5420).

## Stack e estrutura

React 18 + Vite + TS + Tailwind + shadcn/ui (client) · Fastify 5 + TS via tsx (server) · dados em
JSON em `data/` (sem banco; nao introduzir sem discutir) · pnpm workspaces (client + server) · Electron opcional.

`client/src/{components,hooks,pages,lib}` · `server/src/{routes,services}` · `electron/` · `data/` (auto-criado, local).
Modelos (Task, Milestone, Project), lista de rotas e mapa de services: `docs/agent/reference.md`.

## Mapa de docs (leia ANTES de mexer no dominio)

| Dominio | Arquivo |
|---|---|
| Estrutura, modelos, rotas da API | `docs/agent/reference.md` |
| Campos da task, resolucao, historico, busca, timestamps, forecast, milestones, contexto privado | `docs/agent/tasks.md` |
| Lifecycle (entrega/aceite/integracao), worktrees, close seguro, multi-repo Git | `docs/agent/lifecycle-worktrees.md` |
| Design Knowledge nativo, System Explorer | `docs/agent/knowledge-systems.md` |
| Project Explorer / Graphify (Godot) | `docs/agent/explorer-graphify.md` |
| MCP, agentes de codigo, AI backend, CLIs | `docs/agent/mcp-agents.md` |
| Terminais, estado de sessao Claude, hooks | `docs/agent/terminals.md` |
| Execucao Godot (Editor/Review, Harness, contexto de execucao, Play Game) | `docs/agent/godot-execution.md` |
| Busca Ctrl+K / Ctrl+Shift+F | `docs/agent/search.md` |
| Design system, layout, editor, atalhos, relatorios | `docs/agent/client-ux.md` |
| Cache, performance, stores JSON, acesso local, Electron | `docs/agent/server-core.md` |
| Cloud, Sync Trello/ClickUp/Sheets, WhatsApp inbox, Railway, migracao de maquina | `docs/agent/integrations.md` |

Mudou arquitetura, rota, modelo ou convencao? Atualize o `docs/agent/` do dominio (e este arquivo so se
a regra critica abaixo mudar). Nao devolva historico/detalhe para este arquivo.

## Regras criticas (valem sempre)

### Seguranca e acesso local
- A API le arquivos e abre terminal: alcancar o server = rodar codigo na maquina. A fronteira e a
  maquina: server so sobe em loopback (`SHIPYARD_HOST` 127.0.0.1); `localAccess.ts` valida Host/Origin/
  Sec-Fetch-Site. **Nao reabrir CORS, nao introduzir auth sem discutir.**
- Rotas de aceite/aprovacao/integracao/confirmacao (`fromAppUi`) so do navegador (403 senao).
  `attested_local` **nao prova que uma pessoa clicou**. **Nao existe nem pode existir tool MCP de aceitar,
  aprovar, integrar ou confirmar sistema** — agente so **propoe**.
- Nunca ler API key de env var (`ANTHROPIC_API_KEY` etc.). IA server-side passa por `aiBackend.ts`.
- Credenciais cifradas com `data/.claude-key`; nunca voltam ao client.

### Git, worktrees e lifecycle de tarefas
- `taskLifecycle.ts` **deriva** READY->RUNNING->REVIEW->ACCEPTED->INTEGRATED->CLOSED; `done` do agente e
  so execucao, nunca aceite nem integracao. Aceite e humano, preso ao sha revisado, gravado fora do arquivo
  de tasks (`data/task-lifecycle/`).
- Integrar = `git merge --no-ff <sha aceito>` com tudo relido do Git; falhou = `merge --abort`.
- **A unica remocao de worktree/branch e o encerramento seguro** (`worktreeClose.closeTask`: previa + token,
  `git worktree remove` sem `--force`, branch so com sha provado ancestral). Sem `-D`, sem `rm -rf`,
  sem `--force`. Excluir task com worktree pendente e recusado (409 `worktree-pending`).
- Worktree por tarefa: branch `shipyard/task-{n}-{slug}`; so via `ensureTaskWorktree`.
- Nao fazer commit/push/merge/`git add -A` sem pedido; nunca push sem ordem explicita. Nao tocar projetos
  externos (PNMG etc.) a partir daqui; o checkout principal so muda por acao explicita do usuario.
- Nunca mexer em `git/discard*`, terminal integrado ou arquivos do usuario como efeito colateral.

### Tarefas
- **Timestamps cascading** (`buildCascadingTimestamps` em taskStore.ts): nunca remover timestamp existente;
  `done` => inboxAt+inProgressAt+doneAt.
- Task done registra `resolution` (obrigatorio) e `rootCause` (bug). `description` = O QUE (produto);
  `prompt` = COMO/POR QUE tecnico. `context` e privado: nunca sai para Trello/ClickUp/Sheets/exports.
- `replaceTasks` reconstroi a task de lista fixa: **campo novo de Task tem que ser copiado do `existing` la**.
- Toda mutacao de task no MCP chama `afterTaskMutation(projectId)`; toda mutation do client invalida
  `['tasks', projectId]` **e** `['tasks','all']`.
- Effort Fibonacci (1/2/3/5/8) pelo tamanho tecnico, nunca pela prioridade.

### Knowledge (Design Knowledge / Systems)
- Fonte unica: `designCore.ts` + `jabutistudio.decisions.json` / `jabutistudio.systems.json` do projeto.
  **Sem Python, sem dk.py.** Agentes usam MCP `get_design_context` / `propose_design_decision` / `propose_system`;
  proposta nunca vira aprovacao; doc historico nao e aprovacao.
- Nao hardcodar nomes/ids/caminhos de um jogo na logica geral — so em fixtures.

### Persistencia e concorrencia
- Stores JSON: mutex + `writeJsonAtomic` (tmp+rename); leitura nao escreve; nunca read-modify-write sem lock.
- Novos services importam o data path de `dataDir.ts`. Aviso repetitivo usa `log.warnThrottled`.

### UI
- Paleta neutra de proposito; so tokens de cor (`--success/--warning/--destructive`), nunca classes literais
  de paleta para status/prioridade. Visuais de task em `lib/taskVisuals.ts`. Cromo minimo nas toolbars.
- Terminal: **colar sempre via `term.paste()`**; no Windows `cmd.exe`/PowerShell, nunca bash.
- Componentes novos: shadcn/ui; hooks seguem `useTasks.ts` (react-query + `api.ts`).

## Contribuicao
1. Dados em JSON; sem banco sem discutir.
2. Rode os testes do dominio alterado (`server/test/*`) antes de entregar.
3. Detalhe novo vai para `docs/agent/<dominio>.md`, nao para este arquivo.
