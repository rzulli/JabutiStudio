# Tarefas: campos, resolucao, historico, busca, timestamps, forecast, review, milestones

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Tarefas: description vs prompt
- **description**: O QUE fazer, visao usuario/produto, sem referencias a codigo
- **prompt**: Analise tecnica — causas, arquivos, solucoes, checklist de implementacao
- O desfecho de uma tarefa done NAO vai mais no prompt: mora em `rootCause` +
  `resolution` (secao abaixo)

### Resolucao da tarefa (`rootCause` + `resolution`)
- Padrao desde a v1.30: toda tarefa done registra **o que foi feito**
  (`resolution`, obrigatorio) e, se for bug ou problema, **por que aconteceu**
  (`rootCause`: a causa, nao o sintoma). O usuario le isso depois para entender
  a tarefa sem abrir o codigo
- Quem grava: `complete_task` do MCP (`resolution` e required no schema;
  `summary` virou alias legado; sem resolucao a task fecha mesmo assim e a
  resposta traz `warning`), `update_task`, o curl final do "Run with AI"
  (`aiResolvePrompt.ts`), os prompts de copiar (`promptBuilder.ts`, mesmas
  frases) e o TaskEditor (bloco "Why it happened / What was done", visivel
  quando status = done ou ja ha conteudo)
- Quem le: `TaskOutcomeCard` no topo do TaskViewer, antes da descricao. Task
  done sem nada mostra o aviso tracejado com "Add" (nao esconder a lacuna).
  `getTaskOutcome` (`lib/taskOutcome.ts`) cai no formato antigo — ultima secao
  `— Summary` do prompt ou `## What was done` da descricao — marcado "from the
  task notes". O feed de atividade usa a 1a linha de `resolution`
- Fica fora do sync (Trello/ClickUp/Sheets nao leem os campos; o parse do
  pull jogaria qualquer secao nova dentro do prompt). Shipyard Cloud leva a
  task inteira. `replaceTasks` copia os dois do `existing`
- A busca (board, All Tasks, Ctrl+K e `search_tasks`) tambem procura neles

### Historico da tarefa (aba History do TaskViewer)
- `lib/taskHistory.ts` (`buildTaskHistory`) monta a linha do tempo do mais novo
  para o mais antigo a partir do que a task ja guarda: `createdAt`, volta ao
  Inbox (`inboxAt` depois da criacao), `inProgressAt`, `doneAt` (com a 1a linha
  de `resolution`), cada `— Note` do prompt (complemento do WhatsApp vira
  "Client follow-up"), anexos do inbox e comentarios do board, e "Edited"
  quando `updatedAt` passa de tudo isso. Status movido duas vezes so mostra a
  ultima vez: a task guarda um timestamp por etapa
- A aba existe em toda task. Aberta com complemento ainda nao visto
  (`needsReview` + `followUpAt`), o viewer **comeca no History**
- Depende do mesmo formato `— Note YYYY-MM-DD HH:MM` do feed de atividade

### Busca de tarefas (filtro do board)
- `lib/taskSearch.ts` e a fonte unica do filtro por texto: `parseSearchTerms`
  quebra a query em termos e `taskMatchesTerms` casa **todos** eles (AND) contra
  titulo + description + rootCause + resolution + prompt + context (mais um
  campo `extra`, usado na TasksPage para o nome do projeto). Nao escrever um
  filtro proprio por tela
- **Numero da tarefa**: `#378` casa so a tarefa 378 (nunca texto); `378` puro
  casa o numero ou o texto. Combina com outros termos (`#378 login`). O
  `search_tasks` do MCP segue a mesma regra
- O minusculo de cada task e cacheado num `WeakMap` pelo objeto: o
  structural sharing do react-query mantem a task estavel entre polls, entao
  cada versao da task e baixada uma vez so — nao trocar por `toLowerCase` por
  tecla
- `TaskSearchBox` fica colapsado num icone de lupa na toolbar do board e so
  expande ao clicar; **nunca colapsa com texto dentro** — filtro ativo tem que
  estar visivel. Esc limpa e fecha, o X limpa e mantem o foco
- Filtrar nao pode alterar dados: o reorder por drag usa `groupedAll` (lista
  **sem** filtro), porque `POST /tasks/reorder` joga pro fim tudo que nao vier
  na lista enviada — mandar so os visiveis embaralharia as tarefas ocultas
- Com filtro ativo a coluna Done ignora o corte de lidas/nao lidas: um match
  nunca pode ficar escondido atras de "Show N read"
- A busca e efemera (nao vai pro localStorage) e zera ao trocar de projeto ou
  milestone

### Timestamps de Status (cascading)
Os timestamps sao cascading — etapas posteriores preenchem as anteriores automaticamente:
- `todo`/`backlog` → define `inboxAt`
- `in_progress` → define `inboxAt` + `inProgressAt`
- `done` → define `inboxAt` + `inProgressAt` + `doneAt`

**NUNCA remova timestamps existentes** ao editar tarefas. Ao mover entre colunas, adicione o novo sem apagar anteriores. Formato: ISO 8601 (`new Date().toISOString()`). Implementado via `buildCascadingTimestamps()` em taskStore.ts.

### Previsao de tarefas
- `taskForecast.ts` calcula sob demanda usando timestamps; estimativas nao sao persistidas nas tasks.
- Duracao de desenvolvimento = `inProgressAt` -> `doneAt`; espera = `inboxAt`/`createdAt` -> `inProgressAt`.
- Usa mediana e quartis (P25-P75), preferindo mesmo projeto + mesmo `effort`; depois usa effort global e fallbacks por projeto/prioridade/historico global (cache de 60s).
- Duracoes instantaneas/invalidas e acima de 180 dias sao ignoradas; tarefas em andamento usam duracao residual condicional.
- Tasks antigas sem effort continuam validas. `POST /api/claude/classify-task-effort` gera sugestoes sem receber status/timestamps/duracao; o usuario revisa e `POST /api/projects/:id/tasks/effort/apply` grava somente as selecionadas com `effortSource: backfill`.
- Endpoint: `GET /api/projects/:id/tasks/forecast?milestone=...`; mutations invalidam `['task-forecast', projectId]`.
- A resposta do forecast inclui `breakdown` para `inbox` (`todo`), `backlog`,
  `inboxAndBacklog` e `inProgress`; cada recorte soma estimativa restante e faixa
  P25-P75. O kanban exibe esses totais nos cabecalhos e no popover geral.

### Aba Review da tarefa (o que a IA fez)
- `GET /:id/git/task-review?since=&until=` responde numa chamada tudo que a
  revisao precisa: branch atual, commits da janela (cada um com os arquivos que
  tocou, via um unico `git log --numstat`), o agregado por arquivo e a contagem
  do que ficou sem commit na working tree
- A janela vai de `inProgressAt` ate `doneAt` + 15min (a folga cobre o agente que
  faz commit logo depois de marcar done). Tarefa sem `inProgressAt` nao mostra a
  aba — nao ha janela para revisar
- O diff de um commit so e buscado quando o usuario expande (`useCommitDiff`, que
  ja cacheia por hash). Nunca carregar todos os diffs de uma vez
- Se o repo nao existir ou o git falhar, a rota devolve `available: false` e a aba
  mostra um aviso — nunca 500
- `DiffView.tsx` (`DiffBlock`, `parseDiffByFile`, `DiffFileEntry`) e a fonte unica
  de renderizacao de diff, compartilhada com o `CommitDetailDialog`
- "Needs changes" chama `POST /:id/tasks/:tid/note` — anexa uma secao datada ao
  prompt (mesmo formato do `log_task_progress` do MCP, via
  `taskStore.appendPromptSection`) e move a task de volta para in_progress

### Contexto privado da tarefa (`task.context`)
- O quadro do Trello/ClickUp e lido pelo cliente, e `prompt` vai inteiro para o
  card. O que o cliente nao deve ler mora em `context`: duvidas, origem, link do
  inbox e a transcricao das mensagens. **Nenhum provider de sync, relatorio ou
  export le esse campo** — nao adicionar a `renderDesc`, ao Sheets nem aos
  exports
- Quem le: TaskViewer ("Private context"), `get_task`/`next_task`/`start_task`
  do MCP, o prompt do "Run with AI" e do "Copy" (`promptBuilder`), e a busca
- O sync do inbox manda `accepts: ['context']`; so entao o inbox separa as duas
  partes. Shipyard antigo nao manda e recebe tudo junto no `prompt`, como antes
- Complemento (`parentTaskId`): o resumo vira `— Note` no `prompt` e a parte
  privada vira `— Follow-up` no `context`
- `replaceTasks` copia `context` do `existing` (senao todo pull apaga)
- Migracao unica no boot (`splitExistingContext`, marca `contextSplitAt` em
  `inbox-config.json`): tarefas antigas tem o `prompt` cortado a partir de
  `## Duvidas...`/`## Origem: WhatsApp`, secao por secao, e o push seguinte
  limpa os cards

### Milestones
- "General" e virtual (nao armazenado) — tasks sem milestoneId pertencem a ele
- Deletar milestone move tasks para "General"
- Milestone ativo em localStorage: `shipyard:milestone:{projectId}`
