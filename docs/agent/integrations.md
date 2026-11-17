# Integracoes: Cloud, Sync, WhatsApp inbox, Railway, migracao, updates

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Atualizacao automatica (app desktop)
- `electron-updater` com provider GitHub (`publish` em electron-builder.yml).
  O build escreve `latest*.yml` + `.blockmap`; o workflow de release sobe os
  dois junto dos instaladores. Sem eles o app instalado nao ve versao nova
- Lancar versao = subir `version` no package.json, commit, push e tag `v*`.
  O workflow publica a release direto (sem draft — o updater ignora draft) e
  os apps instalados atualizam em ate 4h ou no proximo boot
- Confere no boot e a cada 4h, baixa em segundo plano. O Shipyard vive na
  bandeja e quase nunca fecha, entao "instalar ao sair" nao basta: o renderer
  mostra um toast persistente (`useAppUpdate`) e a bandeja ganha
  "Restart to update"
- A bandeja tem "Check for updates" para nao depender do ciclo de 4h. O item
  mostra o andamento no proprio menu (`Checking…`, `Downloading vX — N%`) e,
  so quando o clique foi manual, avisa "up to date" ou o erro num dialogo — o
  ciclo automatico continua silencioso. O menu e trocado com
  `refreshTrayMenu()`; recriar o `Tray` faria o icone piscar
- macOS atualiza pelo `.zip` (Squirrel.Mac), nao pelo dmg, e exige app
  assinado. Linux so pelo AppImage; o `.deb` nao se atualiza sozinho
- So vale no app empacotado (`app.isPackaged`). Quem roda do codigo-fonte
  atualiza com `git pull`

### Shipyard Cloud (sync entre maquinas — servico pago)
- Servico hospedado em repositorio **privado** (`C:\Code\shipyard-cloud`,
  Railway: workspace Amachains, projeto Personal Projects, servico
  `shipyard-cloud` + `Postgres-bqxs`). Aqui fica so o cliente, desligado ate o
  usuario entrar em Settings > Cloud sync. `DEFAULT_CLOUD_URL` aponta para o
  servico; `SHIPYARD_CLOUD_URL` e o campo "Server" trocam
- **Criptografia ponta a ponta**: a senha nunca sai da maquina. scrypt → HKDF
  gera `authKey` (o servidor so confere isso) e `kek`, que embrulha uma chave
  de dados aleatoria. O servidor guarda a chave embrulhada e blobs AES-GCM
  (com a chave do registro como AAD). Sem reset de senha: perdeu, perdeu a
  copia na nuvem — as maquinas continuam com os dados
- Modelo: cada coisa e um registro com chave (`task/{p}/{id}`,
  `milestone/{p}/{id}`, `project/{id}`, `settings`, `ai`, `deploy`,
  `integration/{provider}`, `integration/{provider}/{p}/{milestone}`). O
  servidor numera cada escrita (`rev` por conta) e a maquina puxa "o que mudou
  depois do rev N"
- **Os stores nao avisam o que mudou**: `cloudSync.ts` observa a data dir
  (chokidar), le tudo por `collectLocal()` e compara hash com o ultimo estado
  combinado com o servidor (`synced`). Hash diferente vira `pending` com a hora
  em que foi notado; chave que sumiu vira tombstone. Por isso delete fisico no
  taskStore continua valendo
- Conflito: vence a mudanca mais recente, por registro. O servidor responde
  `stale` com o registro vencedor e a maquina aplica na hora
- **Varredura antes do pull, sempre**: edicao local que o watcher ainda nao
  notou nao tem relogio, e um registro puxado nessa janela a sobrescreveria sem
  disputa (bug medido no teste de duas maquinas)
- **Dado sincronizado tem que ser igual em toda maquina**. Caminho, worktree,
  `lastSync*` e `updatedAt` da integracao ficam fora — se entrassem, cada
  maquina veria o valor da outra como mudanca e devolveria para sempre. Pelo
  mesmo motivo o hash gravado apos um pull e o do que ficou no disco, nao o do
  que veio pela rede (os stores normalizam na entrada)
- Primeira conexao de uma maquina que ja tem dados (`joined: false`): puxa
  tudo antes, a nuvem vence, exceto task/milestone com `updatedAt` local mais
  novo. So depois sobe o que a nuvem nao tinha
- Projeto que chega de outra maquina e procurado pelo nome da pasta ao lado dos
  projetos que esta maquina ja tem (e um nivel dentro dos pais). Nao achou:
  entra em `missingProjects`, as tasks ficam gravadas e aparecem quando a pasta
  for adicionada
- Gatilhos: watcher (debounce 1,5s), eventos SSE do servidor (outra maquina
  escreveu) e poll de 60s. Tudo passa pela mesma fila (`run`)
- Plano: `free` (padrao; `TRIAL_DAYS` no servidor da teste), `trial`, `pro`.
  Plano inativo recusa push com 402 e o pull continua — nada fica refem.
  Cobranca ainda e manual: `POST /v1/admin/plan` com o `ADMIN_TOKEN` do servico

### Sync — milestone-scoped (Google Sheets, Trello, ClickUp)
Toda integracao de tasks e por **(projectId, providerId, milestoneId)**. Cada milestone tem
sua propria sheet/board/list. O milestone "General" usa o id literal `'default'`.

**Google Sheets** (cliente-only via Apps Script proxy):
- Config em localStorage por milestone: `shipyard:sync:m:{projectId}:{milestoneId}`
- URL validada: so permite `https://script.google.com/macros/s/...`
- Auto-push: debounce 2s; auto-pull: polling 30s com merge bidirecional
- Anti-loop: `lastPushAt` guard impede pull nos 10s apos push

**Trello / ClickUp** (server-side, schema v3 em `data/sync-config.json`):
- **Toda espera por um provedor tem teto** (incidente de 2026-10-09: a janela
  parou de carregar tasks, projetos e Settings). O auto-pull e uma rota que o
  renderer espera, e o Chromium so abre 6 conexoes por origem: 6 merges
  pendurados e mais nada carrega. Regras em `trelloRequest`: timeout de 20s
  por chamada, `Retry-After` limitado a 5s entre tentativas e, se o 429
  persistir, o **token** fica pausado (2 a 10 min, `pausedUntil`) e as chamadas
  seguintes falham na hora — o limite do Trello e por token, nao por board.
  ClickUp tem o mesmo timeout. No client, `useIntegrationAutoPull` roda **um
  ciclo por vez** (`ticking`) e `mergeIntegration` tem timeout de 120s. Nao
  voltar a esperar um `Retry-After` inteiro nem a empilhar ciclos
- Creds globais em `providers[providerId]` (apiKey/token), config em `projects[id][provider][milestoneId]`
- Push: server-side debounce 2.5s em mutations de task — empurra TODOS os milestones
  habilitados do projeto, cada um para sua propria board/list

**Ordenacao dos cards no Trello** (`computePositions` em trelloSync.ts):
- O Trello so ordena lista por data de criacao ou alfabeticamente, e o agente MCP
  cria as tarefas todas no mesmo segundo — logo a ordem de criacao nao diz nada.
  Por isso o Shipyard controla o `pos` de cada card e o reescreve a cada push:
  - **Done** → concluidas mais recentes no topo (`doneAt` desc)
  - **In Progress** → iniciadas mais recentes no topo (`inProgressAt` desc)
  - **To Do / Backlog** → ordem do kanban (prioridade, depois `order`)
- Cards `done` recebem `due = doneAt` + `dueComplete: true` → badge de data visivel
  no card (e permite ordenar por data no proprio Trello)
- Push envia **so os campos que mudaram** (diff contra snapshot do board). Se nada
  mudou, zero requests. Requisicoes em paralelo (limite 6) com retry/backoff em 429
- Edicao feita no Trello nao e sobrescrita (comparamos `dateLastActivity` vs
  `updatedAt`) — a unica excecao e `pos`, que e derivado do estado do Shipyard
- Pull: cliente faz merge a cada 30s via `useIntegrationAutoPull` (key inclui milestoneId)
- Tasks novas vindas do remoto recebem `milestoneId` automaticamente no merge
- Board/list e nomeada `Shipyard · {project} · {milestone}` (ou so `Shipyard · {project}`
  para General)

**Anexos e comentarios do Trello** (pull-only — o cliente escreve no card, o
Shipyard so le):
- `pullCards` pede `attachments=true` na propria chamada de cards (zero requests
  extras) e busca os comentarios em UMA chamada de board
  (`/boards/{id}/actions?filter=commentCard`, teto de 1000). Se essa chamada
  falhar, o pull segue sem comentarios em vez de quebrar
- Teto por card: 20 anexos, 50 comentarios (os mais recentes, reordenados do mais
  antigo para o mais novo)
- **Nunca** renderize esses campos no `desc` do card (`renderDesc`): o parser do
  pull faz round-trip do desc e qualquer assimetria vira diff fantasma que
  re-envia todos os cards a cada push
- `fieldsChanged` (syncMerge) compara por ids ordenados — dado identico nao pode
  contar como mudanca, senao o par pull/push entra em loop a cada 30s
- `replaceTasks` reconstroi a task a partir de uma lista fixa de campos e e o
  caminho de escrita de **todo** pull. Campo novo que nao for copiado do
  `existing` la e apagado a cada ciclo (era assim que `subtasks` e `needsReview`
  se perdiam)
- Ver imagem: proxy `GET /api/projects/:id/tasks/:tid/attachment/:aid`
  (`fetchAttachmentBytes` em trelloSync.ts monta o header
  `Authorization: OAuth ...`). A URL crua do Trello devolve 401
- O merge so substitui os anexos do proprio board: `source: 'inbox'` nunca
  esteve no card e nao pode ser lido como apagado a cada pull

**Migracao v2 → v3**: integracoes Trello/ClickUp pre-existentes sao descartadas (creds
globais sao mantidas) — usuarios reconectam cada milestone manualmente.

### WhatsApp inbox (demandas de clientes → tarefas)
- Servico proprio em `C:\Code\dcoder\whatsapp-inbox` (Railway, projeto Personal Projects,
  servico `whatsapp-inbox` + `Postgres-hBRV` + volume `/data`), ao lado do
  `Evolution API`. Ele recebe o webhook do WhatsApp, grava so as conversas
  vigiadas, transcreve/descreve midia com Gemini, agrupa em demandas e segura
  **tudo** para revisao numa area web com senha. Tem `CLAUDE.md` proprio
- O Shipyard roda local e nao recebe webhook, entao **ele pergunta**:
  `inboxService.ts` faz `POST {url}/api/shipyard/sync` a cada 60s mandando a
  lista de projetos (+ milestones ativos) e o status das tasks que ja criou, e
  recebe as demandas aprovadas. Depois cria as tasks e manda `/api/shipyard/ack`
- **Canal ao vivo**: alem do ciclo de 60s, fica aberto `GET
  {url}/api/shipyard/events` (SSE, mesmo Bearer). Evento `approved` = sincroniza
  agora, entao a demanda aprovada chega em segundos. Silencio de 70s (o inbox
  pinga a cada 25s) derruba e reconecta com espera ate 60s; `configure` e
  `disconnect` reabrem. Aviso que chega no meio de um sync marca `rerun`
- Complemento entregue como nota volta no ack com `asNote: true`; o inbox
  mostra "nota na tarefa #N" em vez de "tarefa #N"
- **Aviso de chegada**: cada entrega fica numa lista em memoria
  (`getDeliveries`, as 30 ultimas: tarefa, numero, titulo, cliente lido do
  `Cliente:` do context, nota ou tarefa nova). `useInboxArrivals` (no Layout)
  le `GET /api/inbox/deliveries` a cada 10s e mostra um toast "Follow-up on #97
  · Canoe" com **Open**, que abre a aba do projeto e a tarefa. O que ja estava
  na lista quando a janela abriu nao vira toast. Antes, achar onde a demanda
  entrou exigia voltar a area web, abrir "Enviadas" e procurar o numero
- Do outro lado a demanda levada fica `claimed` e so vira `sent` com o ack (sem
  ack, volta a `approved` em 10 min). Aqui `imported` (demandId → task) e
  gravado **antes** do ack: um ack perdido reenvia a demanda, e ela so e
  re-confirmada, nunca criada duas vezes
- Complemento de demanda ja entregue (`parentTaskId`) vira `— Note` na task
  existente (formato do feed de atividade) e reabre a task se estava done
- **Complemento tem que aparecer como atualizacao**: `deliver` grava
  `followUpAt` e `needsReview: true` junto com a nota (o `updateTask` ja renova
  `updatedAt`, que poe a task no topo de "Recently updated" e manda o push ao
  Trello). O cartao, a linha da lista e a TaskRail mostram "updated ha X" em
  `primary` e o ponto de "nao vista" ate a task ser aberta; o TaskViewer
  mostra "Client follow-up ha X". `latestFollowUp` (`lib/taskFollowUp.ts`)
  so troca a data da coluna pela do complemento quando ele e o fato mais novo
- Abrir a task limpa `needsReview` **sem** renovar `updatedAt` (no server, em
  `updateTask`, e na atualizacao otimista do `useUpdateTask`): ler nao e
  editar, e antes cada abertura jogava a task para o topo da ordenacao
- `replaceTasks` copia `followUpAt` do `existing` (senao todo pull apaga)
- **Midia vira anexo da task** (`source: 'inbox'`): audio, foto, video e arquivo
  vem na demanda como `attachments` e os bytes sao pedidos a
  `GET {url}/api/shipyard/media/:id` (Bearer, com Range) por `openMedia`. O link
  do registro exige o login da area web, que o agente nao tem. O id do anexo e
  o id da mensagem, o mesmo do `[id=...]` em `context`. Complemento soma os
  anexos na task-mae (`taskStore.addAttachments`, que preserva `updatedAt`: a
  comparacao com o card usa esse campo). Task importada antes disso recebe os
  seus uma vez (`backfillAttachments`, marca `attachmentsBackfilledAt`), dentro
  do sync: se o inbox ainda nao tem a rota, tenta de novo no ciclo seguinte
- Task criada entra em `todo`, com `effortSource: 'manual'` (passou por revisao
  humana) e `effortConfidence: 'low'` (a triagem nao ve o codigo), e chama
  `triggerAutoSync`
- **Catalogo**: o inbox nao ve codigo; o Shipyard manda cada projeto com
  `techStack`, `notes` e as tasks abertas ou concluidas ha ate 30 dias (ate 120
  por projeto). Montado no maximo a cada 5 min (le todos os arquivos de tasks)
  e enviado via `POST /api/shipyard/catalog` so quando o hash difere do
  `catalogHash` que o sync devolve. E com ele que a IA do inbox liga um pedido a
  task #N que ja existe (vira nota nela) em vez de duplicar
- **Revisao dentro do Shipyard** (`/inbox`, `pages/InboxReviewPage.tsx`,
  botao de caixa na barra do topo com a contagem, so com o inbox conectado):
  cada demanda em revisao com o que o cliente disse, projeto, prioridade,
  esforco, codigo/administrativo e destino ("a new task" ou "a note on #N",
  pelas tasks do projeto daqui), aviso de repetida e duvidas abertas (essas
  se respondem na area web, link no cartao). Send/Discard. O server repassa
  (`review` em inboxService; `GET/PATCH /api/inbox/review[/:id]`,
  `POST .../approve|discard`) para `/api/shipyard/review` e
  `/api/shipyard/demands/:id` do inbox, que usam os mesmos handlers da area
  web. O PATCH so deixa passar os campos da revisao. Contagem a cada 60 s,
  lista a cada 30 s com a pagina aberta
- Token cifrado com `.claude-key`, nunca volta ao client. Card em
  Settings > AI & Integrations (`InboxSettingsCard`)

### Indicador de deploy (Railway)
- Responde uma pergunta so: **o ultimo build subiu?** `deployService.getStatus`
  dobra os estados do Railway em quatro — `success` / `failed` / `building` /
  `idle` — e a UI nunca inventa um quinto
- `railwayService.ts` **so le** (`deployments(first: 1)` e a lista de projetos).
  Nao redeploy, nao rollback — nada que mexa em producao a partir daqui
- O input do GraphQL vai inline (`input: { projectId: $projectId, ... }`) para
  nao depender do nome do tipo de input do Railway: tipo renomeado do outro lado
  derruba a query inteira
- **A unidade e o link, nao o projeto nem o checkout**: uma pasta de cliente
  guarda uma duzia de repositorios, e um mesmo repositorio sobe varias vezes —
  um servico por cidade num marketplace, por exemplo. `deploy-config.json` v3
  guarda `projects[projectId]` como **lista** de links; cada um tem `id`
  (`provider:railwayProjectId:serviceId:environmentId`, via `linkId()`) e
  `subrepo?` como rotulo do checkout. Salvar o mesmo alvo duas vezes e upsert,
  nao duplicata. As migracoes do v1 (link solto) e do v2 (mapa por scope)
  entram na lista sozinhas — ninguem reconecta
- Token da conta fica cifrado em `deploy-config.json` (mesma chave
  `.claude-key` do ai-config) e **nunca volta pro client**
- Cache por projeto no server: 60s parado, 15s enquanto ha build rodando, 30s
  depois de erro. Falha de rede vira `error` no payload — o badge diz que nao
  sabe, nunca mostra verde por engano
- Projeto sem link **nao desenha nada** (`configured: false`). O Dashboard usa
  `GET /api/deploy/status` (uma chamada para todos) — um `useDeployStatus` por
  card abriria uma dezena de requests por minuto
- Onde aparece: badge na toolbar do Workspace, que fala por **todos** os
  deploys do projeto (o pior estado vence — uma falha nao pode se esconder
  atras de quatro verdes — e o popover lista um por um), badge do repo
  selecionado no Source Control (`DeployScopeBadge`, que tambem agrega quando o
  checkout tem mais de um deploy) e um icone no card do Dashboard. Configuracao
  do token em Settings > AI & Integrations; vinculo manual em
  Project settings > Launch, onde a lista de servicos fica aberta para marcar
  varios seguidos
- Cada linha do popover diz o que o checkout ainda segura: `N uncommitted`,
  `N to push`, falta de upstream e branch local diferente da que o deploy
  constroi (`PendingGit` em DeployBadge.tsx). Usa `useGitStatus` com a mesma
  chave do Source Control e so monta com o popover aberto — nao ha poll de git
  por badge fechado
- **Vinculo automatico pelo repositorio**: os dois lados ja sabem de qual repo
  do GitHub constroem — o Shipyard pelo `git remote`, o Railway pelo
  `source.repo` do servico. `deployService.findMatches/autoLink` cruzam os dois
  e o `POST /deploy/providers/railway` ja vincula tudo no mesmo clique. So o
  caso ambiguo (um repo, varios servicos) volta como pergunta — e la a escolha
  nao e exclusiva: cada servico e um toggle, `linkedServiceIds` marca os ja
  vigiados e "Watch all" pega a linha inteira. O autolink continua vinculando
  so o caso 1:1, para nao arrastar staging junto sem ninguem pedir
- `repoKey()` normaliza `https://github.com/Owner/Repo.git` e
  `git@github.com:Owner/Repo` para `owner/repo`. Remote que nao e GitHub nao casa
- Projeto multi-repo entra tambem pelos **sub-repositorios**: `projectRepos` le o
  remote de cada sub-repo (cacheado por sessao) — sao justamente os projetos que
  nao tem remote proprio na raiz
- A query com `serviceInstances { source { repo } }` tem fallback: se o Railway
  renomear esses campos, `listProjects` cai na query simples, `sourceAvailable`
  vem `false` e a UI avisa que o vinculo tera de ser manual — nunca quebra
- **Projeto chega a uma conta por dois caminhos** e `listProjects` pergunta os
  dois, unindo por id: `me.projects` (pessoal) e
  `me.workspaces[].team.projects` (workspace/time). So o primeiro deixaria de
  fora quem trabalha dentro de um time
- `me { name email }` e query de **account token**; um token de workspace nao
  tem conta pessoal atras e o Railway recusa o campo. Por isso `connect()` nao
  trata essa recusa como veredito: ele salva o token e tenta listar os projetos,
  so removendo o token se isso tambem falhar

### Migracao entre maquinas (`scripts/workspace-*.mjs`)
- O par export/import move a **configuracao**, nunca as pastas de codigo:
  repositorio com remote e clonado do lado de la, repositorio sem remote
  nenhum viaja como `git bundle` (historico inteiro num arquivo, sem
  `node_modules`). Copiar working tree seria mais pesado e brigaria com o `.git`
- O bundle leva tres coisas que o git nao leva: a data dir do Shipyard, os
  `.env` **ignorados pelo git** (`git check-ignore` decide — `.env.example` ja
  esta no repo e nao entra) e o `manifest.json` dizendo de onde clonar cada um
- **A unidade e o checkout, nao o projeto**: uma pasta de cliente sem `.git`
  na raiz guarda uma duzia de repositorios. O export varre 1 nivel atras de
  `.git` (mesmo criterio de `detectSubRepos`) e trata cada um como repo proprio
- O id do projeto e `slugify(nome da pasta)`, entao o import preserva o nome
  exatamente e re-enraiza o resto com `--root`. Caminho diferente nao quebra o
  vinculo com as tasks; nome de pasta diferente quebra
- O import **reescreve** os caminhos absolutos de `projects.json` e
  `settings.json` e move a data dir anterior para `.bak-<timestamp>` antes de
  escrever. Rodar de novo e seguro: checkout que ja existe fica como esta
- `.claude-key` viaja junto com os JSON cifrados — sem ela, Trello/ClickUp e
  Railway sobem ilegiveis do outro lado. Por isso o bundle tem segredo dentro:
  `--no-secrets` corta, e `shipyard-workspace*` esta no `.gitignore`
- O export descarta o que e local da maquina: `server.log`,
  `terminal-clipboard/`, `worktrees/`, `agent-prompts/` e os `.corrupt-*.bak`
- Zip: o `tar` do Git Bash e MSYS e nao escreve zip. No Windows o arquivo passa
  por `Compress-Archive`/`Expand-Archive`; fora dele, `tar -czf`
- `--only a,b,c` exporta so esses projetos (por nome de pasta). A data dir vai
  **inteira** mesmo assim: o arquivo de tasks de um projeto que ficou de fora
  nao custa nada e perde-lo custaria
- O export escreve `PROMPT.md` dentro do bundle: o briefing pronto para colar
  no agente da outra maquina, ja com os numeros reais, o remote do Shipyard, a
  raiz de origem e o que ficou sem push. Texto condicional — sem repo em bundle
  nao aparece aviso de bundle
- **O bundle e autossuficiente**: `workspace-import.mjs` viaja dentro dele. A
  outra maquina pode clonar um Shipyard mais velho que o script, e ai o bundle
  chegaria sem porta de entrada
- Por isso o import **nao adivinha** a data dir a partir de onde o arquivo
  esta: `--data-dir` manda, senao `SHIPYARD_DATA_DIR`, senao a `data/` do repo
  — e so quando ha um `package.json` um nivel acima. Sem nenhum dos tres ele
  recusa em vez de escrever no lugar errado
- Com `--zip` o bundle e montado em `tmpdir()` e so o arquivo pronto vai para o
  destino: o OneDrive abre cada arquivo novo do Desktop para upload e o
  `Compress-Archive` morre com "arquivo em uso"
