# Referencia: estrutura, modelos de dados e rotas da API

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Estrutura (resumo)

```
client/src/
  components/   # ui/ (shadcn), layout/, projects/, tasks/, git/, claude/, ai/,
                # terminals/, editor/, files/, sync/, mcp/, onboarding/
  hooks/        # useProjects, useTasks, useGit, useClaude, useAi, useTerminal,
                # useMilestones, useSheetSync, useFiles, useEditorTabs, useLogs, useMcp
  pages/        # Dashboard, Workspace, TasksPage, Settings, Help, LogsPage
  lib/          # api.ts (fetch wrapper), sync/ (provider pattern)

server/src/
  routes/       # projects, tasks, git, terminals, terminalWs, claude, ai, mcp,
                # files, logs, sync, settings
  services/     # projectDiscovery, gitService, taskStore, terminalLauncher,
                # terminalService, aiBackend, aiConfigStore, aiJson,
                # claudeService, claudeCliService, openaiService, geminiService,
                # cliDetect, cliRunner, sseStream, claudeContextBuilder,
                # aiResolvePrompt, aiManagePrompt, fileSearch,
                # mcpServer, mcpAuth, logService, settingsStore, dataDir

data/           # Persistencia (auto-criado)
  projects.json, settings.json, ai-config.json, .claude-key,   # claude.json = legado, migrado
  mcp-config.json, mcp-auth.json, server.log,
  design-approvals/{projectId}.json,  # ledger de aprovacoes humanas do Design Knowledge
  graphify/{src,venv,projects/{id}/tree},  # motor do Project Explorer (pnpm graphify:setup)
  claude-hooks/{sessionId}.json,   # settings de hooks por sessao Claude (efemero)
  sync-config.json,                # v3: providers (creds globais) + projects[id][provider][milestoneId]
  deploy-config.json,              # token Railway (cifrado) + link por projeto
  cloud-sync.json,                 # Shipyard Cloud: sessao cifrada + cursor/hashes do sync
  inbox-config.json,               # WhatsApp inbox: URL + token (cifrado) + demandas ja entregues
  claude-conversations.json,       # conversas do Claude que estavam numa aba (para o resume)
  tasks/{projectId}.json  # { milestones?: Milestone[], tasks: Task[] }

electron/       # main.ts, preload.ts (desktop wrapper)
```

### Modelos de Dados

```typescript
interface Task {
  id: string;               // nanoid(10)
  projectId: string;
  milestoneId?: string;     // undefined/'default' = milestone "General" (virtual)
  title: string;
  description: string;      // O QUE fazer (visao usuario/produto)
  prompt?: string;          // HOW/WHY tecnico (causas, arquivos, solucoes)
  context?: string;         // privado: nunca sai para Trello/ClickUp/Sheets (ver "Contexto privado")
  rootCause?: string;       // task done de bug/problema: por que aconteceu (ver "Resolucao da tarefa")
  resolution?: string;      // task done: o que foi feito
  agent?: string;           // qual CLI roda a task (id do agentRegistry; vazio = default)
  worktreePath?: string;    // worktree isolada onde o agente roda (worktree-per-task)
  worktreeBranch?: string;  // branch checada nessa worktree
  priority: 'urgent' | 'high' | 'medium' | 'low';
  effort?: 1 | 2 | 3 | 5 | 8;      // tamanho de implementacao (opcional, por compatibilidade)
  effortSource?: 'claude' | 'manual' | 'backfill';
  effortConfidence?: 'low' | 'medium' | 'high';
  status: 'backlog' | 'todo' | 'in_progress' | 'done';
  order: number;
  createdAt: string;
  updatedAt: string;
  inboxAt?: string;         // quando entrou em backlog/todo
  inProgressAt?: string;    // quando moveu para in_progress
  doneAt?: string;          // quando foi concluida
  needsReview?: boolean;    // marca "nao vista": IA terminou ou chegou complemento do cliente
  followUpAt?: string;      // ultimo complemento do cliente (WhatsApp inbox) anexado a task
  attachments?: TaskAttachment[];  // card do Trello (pull-only) + midia do WhatsApp inbox
  comments?: TaskComment[];        // vem do card do Trello (pull-only)
}

interface TaskAttachment {
  id: string;  name: string;  url: string;
  mimeType?: string;  bytes?: number;  isImage?: boolean;  date?: string;
  source: 'trello' | 'inbox';
}

interface TaskComment {
  id: string;  author?: string;  text: string;  date: string;  source: 'trello';
}

interface Milestone {
  id: string;  projectId: string;  name: string;
  description?: string;  status: 'active' | 'closed';
  createdAt: string;  updatedAt: string;  order: number;
}

interface Project {
  id: string;  name: string;  path: string;  category: string;
  isGitRepo: boolean;  techStack: string[];  favorite: boolean;
  gitBranch?: string;  gitAhead?: number;  gitBehind?: number;
  gitStaged?: number;  gitUnstaged?: number;  gitUntracked?: number;
  externalLink?: string;  lastOpenedAt?: string;
  subRepos?: string[];   // Relative paths to sub-directories with their own .git
}
```

### Rotas da API (padrao: `/api/projects/:id/...`)

**Projetos**: GET /api/projects, PATCH /:id, POST scan/add/remove/refresh
**Milestones**: GET/POST /:id/milestones, PUT/DELETE /:id/milestones/:mid
**Tarefas**: GET /api/tasks/all, GET/POST /:id/tasks, PUT/DELETE /:id/tasks/:tid, POST /:id/tasks/reorder, POST /:id/tasks/replace, POST /:id/tasks/:tid/note, GET /:id/tasks/forecast, POST /:id/tasks/effort/apply
**Git**: GET /:id/git/pending (todos os repos do projeto), GET /:id/git/status|diff|log|branches|commit-diff|main-commit|task-review, POST /:id/git/stage|stage-all|unstage|commit|push|pull|discard|discard-all (all accept optional `subrepo` param for multi-repo projects)
**Files**: GET /:id/files/tree|content, PUT /:id/files/content, DELETE /:id/files, POST /:id/files/open-folder
**Terminais**: POST /api/terminals/launch|folder (nativos), POST /api/terminal/sessions/:id/open-path (caminho clicado no terminal), GET /api/terminal/previews (ultimas linhas de cada sessao), GET/POST/PATCH/DELETE /api/terminal/sessions (integrado; PATCH renomeia a aba; POST aceita `resume` + `resumeTitle`), GET /api/terminal/conversations?projectId= (conversas do Claude para retomar), POST /api/terminal/sessions/:id/clipboard-image, WS /ws/terminal/:id, GET /api/terminal/events (SSE: estado de todas as sessoes), POST /api/terminal/hook/:id (hooks do Claude Code)
**Claude AI**: GET /api/claude/status|usage, POST config|config/test|chat(SSE)|analyze-task|classify-task-effort|summarize, DELETE config
**AI (multi-provedor)**: GET /api/ai/status, POST /api/ai/preferred, POST/DELETE /api/ai/config/:provider, POST /api/ai/config/:provider/test
**MCP**: POST /mcp (JSON-RPC), GET /mcp (SSE), OAuth em /register, /authorize, /token
**Sync**:
  POST /api/sync/proxy|test (proxy stateless para Google Apps Script)
  GET/POST/DELETE /api/sync/providers/:providerId (creds globais Trello/ClickUp)
  GET /api/projects/:id/sync (lista integracoes desse projeto, uma por milestone)
  POST/DELETE /api/projects/:id/sync/:providerId (body/query: milestoneId — default 'default'/General)
  POST /api/projects/:id/sync/:providerId/push|pull|merge (body: { milestoneId? })
  POST /api/projects/:id/sync/{trello,clickup}/link (body: { milestoneId?, ... })
  GET /api/projects/:id/tasks/:tid/attachment/:aid?milestoneId=&preview=1
    (proxy autenticado — a URL do anexo no Trello exige header OAuth, um `<img>`
     apontando direto para ela recebe 401; anexo `inbox` vem do WhatsApp inbox,
     com Range para o player avancar)
**Deploys (Railway)**:
  GET /api/deploy/providers, POST/DELETE /api/deploy/providers/railway (token da conta;
    o POST ja devolve o que foi vinculado sozinho)
  GET /api/deploy/railway/projects (projetos/ambientes/servicos da conta)
  GET /api/deploy/railway/matches, POST /api/deploy/railway/autolink (`{ only?, relink? }`)
  GET /api/deploy/status (todos os deploys linkados, numa chamada)
  GET/PUT/DELETE /api/projects/:id/deploy (`?subrepo=` filtra por checkout;
    no DELETE, `?link=` remove um deploy, `?subrepo=` os daquele checkout e
    nenhum dos dois remove o projeto inteiro)
**Design Knowledge**: GET /api/projects/:id/design (`?file=` ou `?q=`, `&worktree=`), GET .../design/validate|checkouts, POST .../design/approve (so de requisicao do navegador)
**Systems**: GET /api/projects/:id/systems (`?worktree=`), POST .../systems/discover, POST .../systems (proposta), GET .../systems/:sid (`?worktree=`), GET .../systems/:sid/brief (`?goal=`), PATCH .../systems/:sid (revisao: so do navegador), POST .../systems/:sid/merge|split (so do navegador)
**Logs**: GET /api/logs|logs/stats, DELETE /api/logs
**Busca**: GET /api/search/files|content (`q`, `projectId?` restringe, `prefer?` = projeto aberto, ranqueia primeiro; content aceita `caseSensitive`, `wholeWord`, `regex`, `includeIgnored` e devolve `truncated`, `timedOut`, `elapsedMs`; regex invalida = 400)
**WhatsApp inbox**: GET/PUT/DELETE /api/inbox (`{ url, token }`; o PUT ja testa com um sync), POST /api/inbox/sync, GET /api/inbox/deliveries (`?since=`), GET /api/inbox/review (`?summary=1` = so a contagem), PATCH /api/inbox/review/:id, POST /api/inbox/review/:id/approve|discard
**Shipyard Cloud**: GET /api/cloud/status, POST /api/cloud/signup|login|logout|sync
**Agentes**: GET /api/agents (builtins + customizados + `available` por PATH), PUT /api/agents (`{ agents?, defaultAgent? }`)
**Worktrees**: GET /api/worktrees (config + lista), PUT /api/worktrees (`{ enabled?, basePath? }`),
  POST /api/worktrees/clean (so faz `git worktree prune`; nao remove nada — ver R2-A3). O DELETE .../tasks/:tid/worktree foi removido
**Sistema**: GET/PATCH /api/settings (PATCH so aceita `terminalAiTitles`), POST /api/browse
