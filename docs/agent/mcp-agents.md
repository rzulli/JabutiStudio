# MCP, agentes de codigo e AI backend

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### MCP (servidor de ferramentas para agentes)
- `mcpServer.ts` expoe 34 tools (inclui `list_systems`, `get_system`, `propose_system`). Cobertura: projetos, milestones (CRUD),
  tarefas (incl. `create_tasks`/`bulk_update_tasks`/`bulk_delete_tasks`/`reorder_tasks`),
  git (status/log/diff) e sync (`list_sync_integrations`/`sync_push`/`sync_pull`)
- `get_task` devolve tambem os comentarios e os metadados de anexo
  (`next_task` e `start_task` tambem levam os metadados);
  `get_task_attachment` abre **qualquer** anexo, de qualquer origem: grava o
  arquivo em `data/task-attachments/{projeto}/{task}/` (`taskAttachments.ts`) e
  devolve `path`. Imagem PNG/JPEG/GIF/WebP de ate 3,7 MB vem tambem inline
  (bloco `image`); outro tipo nesse bloco derrubaria a requisicao seguinte do
  agente, entao HEIC/BMP/SVG ficam so no caminho. Audio e video trazem `hint`:
  a transcricao e a descricao ja estao em `context`, sob `[id=...]`
- `data/task-attachments/` e cache: o original continua no Trello ou no inbox.
  Arquivo sai depois de 7 dias (varredura a cada download novo) e volta quando
  pedirem. Baixa em `.part` e renomeia, para download cortado nao passar por
  arquivo. Fora do Shipyard Cloud (`WATCHED`) e do `workspace-export`
- **Toda mutacao de task no MCP DEVE chamar `afterTaskMutation(projectId)`**
  (= `triggerAutoSync`). Sem isso o agente altera tarefas e o Trello/ClickUp
  fica desatualizado ate o usuario mexer na UI
- `complete_task` grava `resolution` (+ `rootCause` em bug) — ver "Resolucao
  da tarefa". Nao volta a anexar `— Summary` ao prompt
- `create_task`/`create_tasks`/`update_task`/`bulk_update_tasks` aceitam `effort`
  Fibonacci (1/2/3/5/8). Agentes DEVEM sempre atribuir/revisar effort pelo tamanho
  tecnico, nunca inferi-lo da prioridade
- `update_task`/`bulk_update_tasks` aceitam `milestoneId` (`'default'` = General)
- Tools read-only levam `annotations.readOnlyHint`; destrutivas, `destructiveHint`
- Ao adicionar tool: registrar em `MCP_TOOLS` **e** no `handleToolCall`, e atualizar
  a lista de permissoes da tela de consentimento OAuth em `routes/mcp.ts`

### AI Backend (multi-provider, CLI-first)
- `aiBackend.ts` e o UNICO ponto de entrada para features de IA server-side
  (chat, commit message, analyze-task, bulk-organize, manage-tasks)
- Tres provedores: **claude**, **openai**, **gemini**. O usuario escolhe o
  preferido em Settings > AI (`preferredProvider`); a cadeia e
  `[preferido, ...demais na ordem de AI_PROVIDERS]`. Se o preferido nao tem
  backend usavel (ou falha), o proximo assume — features nunca dependem de um so
- Dentro de cada provedor a ordem e sempre **CLI primeiro** (roda na assinatura,
  custo zero por token), API key como fallback pago:
  - claude: token OAuth (`~/.claude/.credentials.json`, `Authorization: Bearer` +
    `anthropic-beta: oauth-2025-04-20`, NUNCA `x-api-key`) → `claude -p` → key
  - openai: `codex exec --json` → key (`api.openai.com/v1/chat/completions`)
  - gemini: `gemini -p` → key (`generativelanguage.googleapis.com`, header
    `x-goog-api-key` — nunca a key na URL)
- 429 nao aborta a cadeia: fica guardado e so e relancado se **nenhum** provedor
  responder. `options.provider` forca um provedor e desliga o fallback
- NUNCA ler API key de env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`) — pertencem a outras ferramentas
- `generateText()` para one-shot, `streamText()` para chat SSE. Novas features de
  IA DEVEM usar aiBackend, nunca chamar um provedor direto
- Modelos: `FAST_MODELS` (one-shot) e `CHAT_MODELS` (chat / default ao salvar
  key) em `aiConfigStore.ts`. O modelo salvo so vale para o caminho da API key —
  CLI usa o modelo da conta
- OpenAI: modelos `gpt-5*`/`o*` exigem `max_completion_tokens`; os demais,
  `max_tokens`. `isReasoningModel()` decide

### Credenciais de IA (`ai-config.json`)
- `aiConfigStore.ts` guarda `{ preferredProvider, providers[p] = { apiKey, model,
  maxTokens } }` cifrado com AES-256-GCM (`data/.claude-key`), cache em memoria +
  escrita serializada e atomica (tmp + rename), como os outros stores JSON
- Migracao automatica do `claude.json` antigo na primeira leitura (mesma chave de
  cifra, entao o ciphertext e reaproveitado). O arquivo legado so e apagado
  quando o usuario remove a key do Claude — senao ela ressuscitaria no proximo
  boot frio
- `claudeService.ts` virou so o cliente Anthropic; as credenciais vivem no store

### Deteccao de CLIs (`cliDetect.ts` / `cliRunner.ts`)
- `detectCli(bin)` resolve **como** lancar o CLI e cacheia por 6h (60s se nao achou), devolvendo
  `{ command, prefixArgs }`
- **Windows**: npm instala CLI como shim `.cmd` e o Node se recusa a spawnar
  `.cmd` sem shell; passar pelo shell estragaria prompt multilinha. Entao o shim
  e lido e o entry JS que ele aponta e chamado direto (`node <entry>`), o que
  mantem os argumentos verbatim. Sem isso, `codex` e `gemini` ficam invisiveis
- `runCli`/`streamCli` centralizam spawn, timeout por inatividade, hard timeout,
  stdin e cwd. `claudeCliService` tambem passa por eles
- Prompt do codex vai por **stdin** (`codex exec ... -`); `--skip-git-repo-check`
  cai fora automaticamente se a versao instalada nao conhecer a flag

### Parsing de resposta estruturada (`aiJson.ts`)
- `parseJsonResponse()` e compartilhado por todas as rotas de IA. Cada provedor
  erra diferente: Claude poe prosa antes, OpenAI cerca em ```json, Gemini as
  vezes abre com `<thinking>`. A funcao vai do estrito ao tolerante (parse direto
  → tira fences → tira bloco de raciocinio → extracao por profundidade de chaves
  → conserta virgula sobrando e chave sem aspas)
- Rota de IA nova DEVE usar essa funcao, nao um `JSON.parse` proprio

### Medidor de uso da assinatura
- `claudeUsage.ts` le `GET https://api.anthropic.com/api/oauth/usage` com o token
  OAuth do CLI (mesmo endpoint que o `/usage` do proprio CLI usa)
- **Endpoint nao documentado**: pode mudar de forma ou sumir. Toda falha degrada
  para `{ available: false }` e o widget some — nunca quebra a UI
- So expoe **percentual** de utilizacao (`limit_dollars`/`used_dollars` vem `null`
  em planos de assinatura). Nao ha contagem de tokens nem de dolares
- Ler o array generico `limits[]` (kinds: `session`, `weekly_all`, `weekly_scoped`),
  nao os campos nomeados de topo — junto deles vem codinomes internos (`tangelo`,
  `iguana_necktie`…) que chegam `null` e nao tem significado estavel
- 429 nesse endpoint = throttle do medidor, **nao** limite do plano estourado.
  Nesse caso serve a ultima leitura boa (`stale: true`) por ate 10min
- Cache de 60s no server + `refetchInterval` de 60s no client. A janela de 5h
  anda devagar; nao vale poll mais agressivo
- `ClaudeUsageBadge` na barra do topo: anel = janela de 5h (a que trava a
  sessao de trabalho); popover abre o detalhe. Cor por severidade: <75% neutro,
  75-89% `warning`, >=90% `destructive`

### AI Task Management (Claude CLI)
- `claudeCliService.ts`: detecta e executa Claude CLI (`claude`) como subprocess
- `aiResolvePrompt.ts`: monta prompt para Claude resolver UMA tarefa (inclui contexto do projeto + task + MCP tools disponiveis)
- `aiManagePrompt.ts`: monta prompt para Claude gerenciar MULTIPLAS tarefas a partir de texto livre
- Auto-close: TerminalPanel detecta quando sessao AI termina e marca task como done se Claude nao o fez
- Prompt reforça que Claude DEVE atualizar status da task via MCP ao concluir
- **"Run" roda direto** (desde a v1.34: na gravacao de 2026-11-03 o usuario
  disse que quase nunca usa contexto extra). **Shift+clique** abre o
  `AiResolveDialog`, onde se escreve uma decisao ou contexto so para aquela
  execucao e se escolhe o agente. O texto vai no corpo de
  `POST /:id/tasks/:tid/ai-resolve` e vira a secao `## User decision feedback`
  do prompt, declarada como instrucao que prevalece sobre a descricao. Vale no
  board, na TaskRail e na paleta
- `useAiResolve` e o unico caminho que monta o prompt e dispara
  `shipyard:open-terminal`. A paleta (Ctrl+K) desmonta ao fechar, entao manda
  evento para o `AiResolveHost` (montado no Layout): `shipyard:run-task` roda,
  `shipyard:run-task-with-agent` abre o dialogo
- No cartao do board o **Run fica embaixo a esquerda**, ao lado do numero, e
  aparece no hover para tarefas `todo` e `in_progress`. Nao volta para a barra
  de icones do canto (copiar/duplicar/editar/apagar): rodar move a tarefa e abre
  um agente, e nao pode estar a um clique errado de "copiar"

### Agentes de codigo (qual CLI roda a task)
- `agentRegistry.ts` e a fonte unica: 6 builtins (Claude Code, Codex, Aider,
  Gemini CLI, OpenCode, Cursor CLI) + os que o usuario cadastra em Settings
  (guardados em `settings.json` como `customAgents`, com `defaultAgent`)
- `task.agent` guarda o id escolhido; vazio = `defaultAgent` = `claude`.
  `replaceTasks` copia o campo do `existing` — sem isso todo pull de sync apaga
- `buildAgentLaunch()` monta a linha de comando. O template de args aceita
  `{cwd}`, `{taskFile}` (arquivo com o prompt inteiro, em `data/agent-prompts/`,
  limpo apos 24h) e `{task}` (prompt em uma linha, entre aspas do shell)
- **Claude Code recebe o prompt como argumento** (`claude [opcoes] -- <prompt>`,
  `promptAsArgument`): o proprio CLI envia quando sobe, a sessao continua
  interativa e nao ha o que adivinhar pela tela. O prompt vai para um arquivo em
  `data/agent-prompts/` e o shell o le de volta como um argumento so
  (`(Get-Content -Raw ...)` no PowerShell, `"$(cat ...)"` no resto). Antes ele
  era colado no CLI ja aberto, e um palpite errado sobre "pronto" deixava a
  tarefa colada sem enviar, ou nem colada
- No Windows o arquivo ja vai escapado (`escapeForPowerShellArg`): o PowerShell
  5.1 nao escapa aspas ao chamar um .exe e so poe aspas em volta quando acha
  espaco fora de um par de `"` — dai o espaco na frente. Testado com aspas,
  barra antes de aspas, barra no fim e prompt que comeca com hifen (o `--`
  existe por isso). **Nao trocar o shell do terminal sem refazer esse teste**
- Esse caminho exige o `claude.exe` nativo e prompt de ate 20 mil caracteres
  (o Windows limita a linha de comando a 32.767). CLI instalado por npm (shim
  `.cmd`, que passa pelo cmd.exe e corta o argumento na primeira quebra de
  linha) ou prompt maior caem na injecao
- **Os outros builtins sobem vazios e o prompt e digitado neles**
  (`injectPromptWhenReady`), que preserva quebras de linha. Com
  `{task}`/`{taskFile}` a sessao e one-shot e nao ha injecao
- Sessao que sobe com o prompt no argumento comeca em `watchHold`; o hook
  `UserPromptSubmit` solta, e um timer de 10s (`LAUNCH_HOLD_MS`) cobre o CLI que
  nao chega la — o dialogo "trust this folder?" aparece antes do prompt e vira
  `awaiting-input`
- Aspas por shell (PowerShell no Windows, sh no resto). Comando com espaco no
  caminho vira `& 'caminho'` no PowerShell
- Escolha do agente: `AgentSelect` no TaskViewer (grava na task) e no
  `AiResolveDialog` (so aquela execucao). O id viaja no evento
  `shipyard:open-terminal` → `POST /api/terminal/sessions` → `createSession`
- A aba do terminal leva o nome do agente quando nao e o default
- Nao criar um segundo lugar que decida comando de agente: passe pelo registry

## Modelo e effort por execucao

- `agentRegistry.AGENT_CAPABILITIES` diz, por harness, a flag de modelo e de effort (claude: `--model`/`--effort`; codex: `-m`/`-c model_reasoning_effort=`; gemini/aider/opencode/cursor so modelo). Harness fora da lista (custom) nao recebe flag.
- `runOptionArgs` valida (effort na lista do harness; modelo por regex, ja que vai para a linha do shell) e `createSession` injeta no `extraArgs`. `POST /api/terminal/sessions` aceita `model` e `effort`; `GET /api/agents` devolve `models`/`efforts` por agente.
- Client: `RunConfigSelect` (popover) / `RunConfigFields` (inline) = seletor unico de harness + modelo + effort. Use-o em todo lugar que dispara um agente (Run with AI, Ask agent, novo sistema). Evento `shipyard:open-terminal` carrega `agent`, `model`, `effort`.

## Knowledge para agentes lancados (readiness)

- Claude recebe `--mcp-config` (arquivo com o endpoint); Codex recebe `-c mcp_servers.shipyard.url=<endpoint>` (nada vai para `~/.codex/config.toml`). Nenhum segredo na linha de comando nem no brief.
- `agentMcp.knowledgeDiagnosis(agent)` → `{state, reason, fix}`. `ready` so quando a auth esta desligada **ou** um cliente do proprio agente (nome `Codex`/`Claude…`) tem refresh token vivo (`mcpAuth.listAuthorizedClients`). Registro (DCR) acontece antes do consent e **nao** conta; cliente aprovado de um agente nao autoriza o outro.
- `ready` nao prova descoberta de ferramentas: so uma sessao que chama a tool prova. O brief diz isso. `probeKnowledgeEndpoint()` checa o endpoint anunciado (401 esperado com auth; `tools/list` completo sem auth) e aparece em `/api/mcp/status` e no brief quando falha.
- Login do Codex: `codex -c mcp_servers.shipyard.url=<endpoint> mcp login shipyard`. O `codex mcp login shipyard` sem o `-c` falha ("No MCP server named 'shipyard'"), porque o servidor so existe como override de lancamento.
- `mcpAuth.recordClientUse` guarda em memoria o ultimo uso (tools/list, tools/call) de cada cliente autenticado; o diagnostico o mostra como "ultimo uso registrado por este cliente (nao prova para uma sessao nova)". E evidencia do cliente, nunca do acesso da sessao atual; zera ao reiniciar.
- **Risco nao resolvido (consentimento OAuth):** `POST /authorize` com `approved=true` passa por `localAccess` sem `Origin`/`Sec-Fetch-*` (curl, scripts e agentes locais nao os enviam), e nao ha prova de clique humano. Em dois logins reais de Codex em instancia isolada o consentimento foi aprovado ~2 s depois de abrir a pagina, sem interacao do agente; a origem (pessoa, navegador embutido/extensao ou processo local) nao pode ser provada por falta de cabecalhos nos logs. Nao ha codigo de auto-aprovacao no servidor. Politica nao alterada; decisao de exigir atestacao humana fica com o dono.
