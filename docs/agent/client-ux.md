# Cliente e UX: design system, layout, editor, atalhos, relatorios

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Design system (UI)
- Fonte: **Inter Variable** (`@fontsource-variable/inter`, importada em `main.tsx`;
  `fontFamily.sans` no tailwind config)
- Tokens de cor em `client/src/index.css` (CSS vars) mapeados no tailwind config.
  Alem dos padroes shadcn: `--success`, `--warning`, `--sidebar`.
  **A paleta e neutra de proposito** (decisao de 2026-10-02: poucas cores, sem
  cara de "design de IA"): cinzas frios, `--primary` e claro sobre escuro
  (botao principal branco-acinzentado, nao azul), `--success` e um neutro claro
  (nao verde), `--warning` e o unico tom quente (ambar apagado — "precisa de
  voce" e in progress) e `--destructive` fica para erro e delete. Nao
  reintroduzir matiz de marca nem verde/azul saturados
- Movimento: classes `anim-rise`/`anim-slide`/`anim-grow`/`anim-fade` em
  `index.css` (0,16–0,24s, sem bounce nem glow; respeitam
  `prefers-reduced-motion`). Usar essas, nao inventar keyframes por componente
- Semantica de cor: inbox/todo = `primary` · in_progress = `warning` ·
  done = `success` · urgent/erro/delete = `destructive`. **NUNCA** usar classes
  literais de paleta (`text-purple-500`, `bg-yellow-500`...) para semantica de
  status/prioridade — use os tokens. Excecoes: cores de marca de terceiros
  (Trello/ClickUp em SyncMenu) e cores por tipo de arquivo (FileIcon)
- Aparencia de prioridade/status de tasks vem de `client/src/lib/taskVisuals.ts`
  (`PRIORITY_CONFIG`, `STATUS_CONFIG`, `priorityVisual()`, `statusVisual()`) —
  nao redefinir configs locais por componente. So urgent (vermelho) e high
  (ambar) tem cor; medium/low sao neutros
- Tasks done: **sem** `line-through` e **sem** `opacity` no card — titulo em
  `text-muted-foreground` + check verde. Legibilidade > decoracao
- **Cromo minimo**: toolbars mostram so as acoes do fluxo principal (Claude,
  New Task, milestone, toggle Tasks/Editor). Acoes secundarias (sort, view mode,
  import/export, report, dev server, shell, links, settings) vivem em menus "⋯"
  (`ui/dropdown-menu.tsx`) ou aparecem apenas no hover (acoes de coluna do kanban:
  `group/col` + `opacity-0 group-hover/col:opacity-100`). Nao adicionar botoes
  sempre-visiveis a toolbars sem justificativa de fluxo
- Abas de projetos compartilham toda a largura disponivel (`basis-0 flex-1 min-w-0`),
  permanecem todas visiveis e truncam os nomes; nao reintroduzir scroll horizontal
  nem menu de abas excedentes
- Painel lateral fecha automaticamente em rotas full-page (`/settings`, `/logs`,
  `/help`) e restaura a preferencia ao voltar — ver `FULL_PAGE_ROUTES` em
  `useActivity.tsx`

### Layout A: duas barras, tarefas a esquerda, agentes no centro
Decidido em 2026-10-02 a partir de uma gravacao de uso (68% do tempo num
terminal, 5 trocas Tasks <-> Terminal em 2 min, 160px de barras empilhadas e o
nome do cliente repetido 3 vezes). O que ja esta implementado:
- **Duas barras, nao quatro.** No app desktop a barra de titulo carrega as abas
  de projeto (`AppTitleBar` renderiza `<TabBar embedded />`; os menus File/Edit/
  View/Help viram submenus do logo e a busca vira um icone). No navegador a
  `TabBar` continua com barra propria. A segunda barra e a toolbar do Workspace
- **A toolbar do Workspace hospeda as abas de sessao**: ela publica um slot
  (`layoutStore.setTabSlot`) e o `TerminalPanel` desenha a fila la dentro com
  `createPortal` (so em layout focus, dentro de um projeto). Fora disso
  (Dashboard, split) o painel continua com a barra propria. O nome do projeto
  **nao** aparece na toolbar — a aba do projeto ja diz
- **Abas de sessao sao do projeto aberto** (`scoped` no TerminalPanel): dentro
  de `/project/` a fila lista so as sessoes daquele projeto, sem prefixo. Os
  terminais dos outros continuam montados e rodando, so nao aparecem. O pane
  nunca mostra terminal de outro projeto; "Close all"/"Kill" agem so na fila
  visivel. Fora de um projeto a fila e global e o prefixo volta
- **A aba do projeto mostra o que os agentes dele fazem**: `useTerminalTabs`
  (store externo publicado pelo TerminalPanel) + `worstStatus` — pergunta >
  terminou > rodando > parado — e a contagem quando ha mais de uma sessao
- **Um icone por estado, em todo lugar**: `SessionStatusIcon` (aba de sessao,
  aba de projeto, linha da task). Nao desenhar estado de sessao de outro jeito
- **`TaskRail`** (300px, `layoutStore.taskRail`, `shipyard:task-rail`, default
  ligado): lista In Progress / Inbox / Backlog / Done ao lado do terminal cheio
  (montada pelo Layout). Nao aparece ao lado do board (seria a mesma lista duas
  vezes) nem do editor (la a coluna esquerda e a arvore de arquivos). Task com sessao viva mostra o
  estado do agente e o clique leva ao terminal dela (`shipyard:focus-terminal`);
  sem sessao, abre o TaskViewer. "Run" usa o mesmo `AiResolveHost` da paleta.
  A ordem de In Progress / Inbox / Backlog vem do menu de ordenacao do
  cabecalho (`shipyard:task-rail-sort`: `updated` — default, ultima atualizada
  primeiro —, `priority` ou `board`, a ordem manual do kanban); Done e sempre
  a mais recente primeiro. Mover de coluna: no hover, a seta (→ In Progress,
  sem abrir agente) e o check (Done); o resto no botao direito ("Move to").
  Usa `useUpdateTask`, o mesmo caminho do board
- A TaskRail tem **busca** (`TaskSearchBox`, mesma regra do board: `#97` casa
  so o numero). Com filtro, toda secao com resultado abre e o Done nao corta
- **Rodape de git da TaskRail** (`RailGitStatus`): responde "o agente fez
  commit e push?". Uma linha quando tudo esta limpo; senao uma linha por repo
  com arquivos sem commit, commits sem push ou branch sem upstream. Le
  `GET /:id/git/pending` (raiz + `subRepos` numa chamada, so o cache de
  `gitService.getStatus`, nunca fetch) a cada 20s e de novo quando um agente
  do projeto para. Clicar abre o Source Control naquele repo
  (`shipyard:select-git-repo`)
- **Abrir uma sessao para uma task move a task para In Progress**, no server
  (`POST /api/terminal/sessions` com `taskId`), seja qual for o botao que
  iniciou. Nao depender do agente chamar `start_task`
- O "+" da fila e um menu: abre Claude (YOLO ou nao), shell e dev, e guarda as
  acoes do painel (split, nativo, limpar, matar) que antes eram seis botoes
- **Nao existe mais ActivityBar.** A barra do topo (`AppTitleBar`, agora
  tambem no navegador) leva busca, lista de projetos, chat, medidor de uso e o
  menu de settings/logs/help. O `SidePanel` virou **gaveta sobreposta**
  (absoluta, com fundo escurecido; fecha com Esc, clique fora ou no X) e
  **sempre comeca fechada** — nao e mais coluna fixa nem volta sozinha depois
  de um reload
- **Git e uma etiqueta na toolbar** (branch + `N changed`/`clean`, a partir dos
  campos `git*` do projeto, sem poll proprio) que abre a gaveta de Source
  Control. Projeto multi-repo sem git na raiz mostra `N repos`
- Vistas do centro: **Agents** (terminal cheio + TaskRail), **Board** (kanban)
  e **Editor** (com a arvore de arquivos — `ExplorerView` — como coluna
  esquerda propria). "Agents" emite `shipyard:show-terminal`; sem sessao no
  projeto o painel mostra o estado vazio com "Open Claude YOLO"
- **Grade de agentes** (`/agents`, `pages/AgentsPage.tsx`, botao de grade na
  barra do topo com a contagem de quem espera resposta): um cartao por sessao
  de **todos** os projetos, YOLO e shell incluidos, agrupados em Waiting for
  you / Finished / Working / Idle. Cada cartao: estado, rotulo da aba
  (`label` no `terminalTabsStore`, montado por `describeTab`), as ultimas
  linhas e o git do projeto (`['git-pending', id]`, mesma chave do rodape da
  TaskRail). Clique abre o terminal (`shipyard:focus-terminal`); sessao em
  `question` tem campo de resposta (texto, Enter 150 ms depois — junto, o Enter
  podia ser lido como paste)
- As linhas vem de `GET /api/terminal/previews`: o output watcher guarda as
  ultimas 5 linhas do texto que ele **ja limpou** a cada pausa
  (`setPreview`, sem a caixa de input, reguas e rodape do Claude Code). A rota
  so le um Map; a pagina consulta a cada 3 s e so enquanto esta aberta
- **Resume** na toolbar do projeto (`ResumePicker`, ao lado do Claude): as 25
  ultimas conversas do Claude Code do projeto (`?limit=` na rota de
  conversas), com titulo, ultimo pedido, YOLO e idade, filtro por texto
  (Enter retoma a primeira). Substitui abrir o Claude e digitar `/resume`. As
  conversas sao achadas pela pasta onde o Claude abriu — a pasta do cliente,
  que e o projeto
- **Alt+A** (`jumpToNextWaitingAgent` em `useGlobalShortcuts`): vai para o
  proximo agente que espera resposta, de qualquer projeto; sem nenhum, para o
  proximo que terminou. Apertar de novo passa para o seguinte. O terminal
  repassa a tecla (`attachCustomKeyEventHandler`) e o menu View tem o item.
  Usa `event.code` (no macOS Option+A digita "å"). O simulado de referencia
  esta em `~/Desktop/shipyard-novo-layout.html`

### Layout de paineis (foco vs split)
- `hooks/useLayoutMode.ts` e a fonte unica: `mode` (`focus` | `split`, em
  `shipyard:layout-mode`, default `focus`), `terminalFull` e `chatFull`
- **focus**: terminal aberto dentro de um projeto ocupa toda a area de trabalho;
  o Workspace encolhe ate a toolbar (`terminalFull` esconde o conteudo com
  `hidden`, sem desmontar board/editor). Clicar em Tasks/Editor emite
  `shipyard:focus-workspace` e o TerminalPanel fecha. As abas de sessao
  continuam listadas com o painel fechado — clicar numa abre o terminal cheio
- **split**: comportamento antigo — terminal embaixo, altura em
  `shipyard:terminal-height`. Arrastar a borda de um terminal cheio troca para
  split no primeiro movimento; o botao na barra do terminal alterna os modos
- Quem decide "cheio" e o TerminalPanel (`isVisible && focus && rota
  /project/`) e ele publica `terminalFull`; fora de um projeto (Dashboard,
  Settings) o terminal usa a altura do split para nao cobrir a pagina
- Em focus, trocar de projeto decide a vista: projeto com sessao viva abre em
  **Agents** (mesmo que o anterior estivesse no Board), projeto sem sessao
  fecha o painel. O efeito e um `useLayoutEffect` no TerminalPanel — roda antes
  dos efeitos do Workspace, entao pedido de Editor ainda vence: arquivo vindo
  da busca (`shipyard:pending-editor-file`) e o item "Editor" do menu de
  projeto (`PENDING_EDITOR_VIEW_KEY` no sessionStorage)
- Em focus, a recuperacao de sessoes no boot nao reabre o painel — "aberto" ali significa cobrir o workspace
- Chat: o botao no cabecalho da ClaudeView liga `chatFull` — o SidePanel vira
  `flex-1`, o `<main>` some e o ChatPanel (`expanded`) preenche a altura com
  coluna de leitura (`max-w-3xl`, `text-sm`). Nao e persistido e zera quando a
  view desmonta. Com `<main>` oculto os terminais recebem `isActive=false`:
  um fit contra caixa de tamanho zero encolheria o PTY

### Dialogo de tarefa (TaskEditor)
- Um unico componente serve New Task e Edit Task. O caminho comum e so titulo:
  titulo + descricao + a linha `Priority/Effort/Status` ficam sempre visiveis;
  **Details (prompt) e subtasks vivem atras do disclosure** "Technical details and
  subtasks" — colapsado em tarefa nova, aberto sozinho quando a tarefa ja tem
  prompt ou subtasks (contador no rotulo quando fechado)
- Prioridade e status usam os icones/cores de `taskVisuals.ts`. Nao redefinir
  labels ou cores aqui
- **Ctrl/Cmd+Enter salva de qualquer campo** (Enter sozinho salva no titulo).
  Registrado em `lib/shortcuts.ts`
- A subtask ainda digitada no input entra no save — nao dependa do Enter.
  `POST /api/projects/:id/tasks` aceita `subtasks` e descarta entradas sem titulo
  (`sanitizeSubtasks` em routes/tasks.ts)
- "Keep open for the next task" (`shipyard:quick-create` no localStorage) mantem
  o dialogo aberto apos criar e **preserva priority/status** — so os campos de
  texto, effort e subtasks sao limpos
- O milestone alvo aparece como badge no titulo quando nao e o General

### Feed de atividade no Dashboard (o que os agentes fizeram)
- `lib/activityFeed.ts` deriva a linha do tempo das ultimas 24h a partir da
  lista de tasks que o Dashboard ja busca: `inProgressAt` vira **started**,
  `doneAt` vira **completed**, e cada secao `— Note` do prompt vira uma
  entrada propria. Nao ha rota nova nem segunda cadencia sobre
  `['tasks','all']` — a query mais cara do app continua com o poll de 30s
- As notas so existem porque `appendPromptSection` grava
  `— Note YYYY-MM-DD HH:MM` (UTC) e, nas tasks antigas, `— Summary` (desde a
  v1.30 o "completed" mostra a 1a linha de `resolution`). **Mudar esse formato no
  server quebra o feed** — os dois lados tem que andar juntos. A task guarda
  um unico `updatedAt`, entao ler o prompt e a unica forma de ver uma nota
  como evento
- Task nao tocada desde o inicio da janela pula a varredura do prompt
  (`updatedAt < since`) — sem isso o build percorre o arquivo inteiro
- Ids de evento sao deduplicados: um arquivo de tasks ja veio com o mesmo id
  duas vezes e chave repetida quebra a lista do React
- `ActivityFeed.tsx` some sozinho quando o dia foi silencioso, mostra 6 linhas
  com "Show N more", e nomeia o agente **so quando nao e o default** (mesma
  regra das abas de terminal)
- Clicar numa linha abre o `TaskViewer` no proprio Dashboard. Ele e o
  `TaskEditor` entram por `lazy()`: o Dashboard e a rota inicial e nao pode
  carregar o painel de review e o diff no chunk de entrada

### Editor: preview
- `PREVIEW_KINDS` em EditorPanel: markdown (`.md`, `.mdx`, `.markdown`), HTML
  (iframe `sandbox="allow-scripts"`, sem same-origin) e SVG (como `<img>`,
  que nao roda script). Sempre a partir do texto do editor, entao mudanca nao
  salva aparece. Aba em diff nao tem preview; "Edit file" sai do diff

### Atalhos globais e comportamento das abas
- `useGlobalShortcuts` (chamado em `LayoutInner`) e a casa dos atalhos que valem
  para o app inteiro: **Ctrl+W** (fecha aba), **Ctrl+N** (nova tarefa) e **?**
  (overlay de atalhos). Atalhos de um componente continuam com o dono
  (Ctrl+K, Ctrl+Shift+F, Ctrl+`, Ctrl+S) — registrar duas vezes dispara duplo
- Ctrl+W com o terminal em foco **nao** e capturado: no shell essa tecla e
  delete-word e roubá-la quebra a edicao da linha
- Ctrl+W dispara `shipyard:close-editor-tab` como evento **cancelavel**: o
  EditorPanel cancela quando fecha um arquivo (passando pela confirmacao de
  alteracoes nao salvas); se ninguem cancelar, fecha a aba de projeto
- Ctrl+N deixa `shipyard:pending-new-task` no sessionStorage alem de emitir o
  evento — o TaskBoard so monta no modo tasks e sem a flag o evento se perde
- Fonte unica dos atalhos exibidos: `client/src/lib/shortcuts.ts` (`SHORTCUTS`)
- As tres barras de abas (projeto, editor, terminal) seguem as mesmas regras:
  botao do meio fecha, botao direito abre menu de contexto, e ao fechar a aba
  ativa a **adjacente** assume
- Ctrl+W / Ctrl+N sao reservados pelo navegador: so funcionam no app desktop.
  Itens de menu no Electron usam `registerAccelerator: false` (o renderer e quem
  trata) e no macOS o `role: 'close'` foi trocado por item proprio, senao o
  Cmd+W fecharia a janela antes de chegar no renderer

### Menus de contexto de projeto
- `ProjectContextMenu` e o menu unico de projeto, usado no card do Dashboard, na
  linha da sidebar, na aba de projeto e no botao Claude da toolbar. Ordem fixa:
  Workspace · Editor · Claude (+ variante skip permissions) · Dev · Shell ·
  Pasta · Repositorio · Cloud · Favorito · Settings
- `useProjectLaunch` e o unico caminho de launch: prefere o terminal integrado
  (evento `shipyard:open-terminal`), cai para o nativo, compartilha a preferencia
  `shipyard:skipPermissions` entre todos os pontos e padroniza os toasts.
  Nao duplicar essa logica por componente

### Relatorios: presets e cursor (localStorage)
O ReportDialog guarda tres chaves por projeto, todas lidas e escritas por
`client/src/lib/reportPresets.ts` (try/catch em tudo; JSON invalido vira vazio):
- `shipyard:report-presets:{projectId}` -> `{ [nomeDoPreset]: { title, clientName,
  usePeriod, sections, includeCommits, includeTech } }`. As datas from/to nao
  entram no preset. "Save" sobrescreve o preset selecionado, "Save as…" pede um
  nome (mesmo nome sobrescreve) e apagar pede confirmacao
- `shipyard:report-presets:{projectId}:last` -> nome do ultimo preset usado; e
  aplicado sozinho quando o dialogo abre, se o preset ainda existir
- `shipyard:report-cursor:{projectId}` -> timestamp ISO do ultimo "Mark as
  reported" (acao do toast que aparece depois de exportar PDF, HTML ou TXT).
  Com cursor, ao carregar as tasks so entram marcadas as `in_progress` e as
  `done` com `doneAt > cursor`; `todo`, `backlog`, `done` antigas e `done` sem
  `doneAt` entram desmarcadas. A pill "New since last report" filtra as `done`
  posteriores ao cursor e so aparece quando ele existe. Sem cursor, tudo entra
  marcado como antes
- Nao usar `window.prompt`/`confirm` aqui: nome e confirmacao usam `ui/dialog` e
  `ui/alert-dialog`. O toast de export leva `className: 'pointer-events-auto'`
  porque o dialogo modal desliga os cliques no `<body>`
