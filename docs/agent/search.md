# Busca global (Ctrl+K) e no conteudo (Ctrl+Shift+F)

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Busca global (Ctrl+K) e no conteudo (Ctrl+Shift+F)
- **Contexto primeiro**: projeto aberto (aba ativa, `useTabs().activeTabId`),
  depois os outros projetos do **mesmo cliente** (`category` = pasta-pai = pasta
  do cliente) e por fim o resto. `lib/searchRanking.ts` (`makeContextRank`,
  `rankTasks`, `rankProjects`) e a fonte unica no cliente — a paleta e a busca
  do painel lateral (`SearchView`) usam as mesmas funcoes. No server,
  `projectRanks` em `services/fileSearch.ts` faz o mesmo com `prefer`
- Tarefas na paleta: sem query, so abertas do contexto, mais recentes; com
  query, **todos os status** (done incluso, abaixo das abertas), por relevancia
  (`scoreTask`: numero > titulo > descricao/resolucao > projeto > prompt) +
  contexto + status. `#N` esconde projetos e arquivos
- Enter numa tarefa abre a aba do projeto **e** a tarefa: evento
  `shipyard:open-task` → `TaskViewerHost` (montado no Layout, como o
  `AiResolveHost`, porque a paleta desmonta ao fechar; Viewer e Editor sao
  `lazy()`)
- Nomes de arquivo: indice em memoria por projeto (`fileSearch.ts`, profundidade
  6, teto 40 mil entradas), TTL 60s com stale-while-revalidate — so a primeira
  busca de um projeto espera o walk. Rotas de arquivo que criam/renomeiam/
  copiam/apagam chamam `invalidateFileIndex`. Score: nome exato > stem > prefixo
  > inicio de palavra/camelCase > contem > caminho; varios termos casam no
  caminho
- **`SEARCH_EXCLUDED_DIRS`** (`fileSearch.ts`) e a lista unica de pastas que
  busca nenhuma abre: `node_modules`, `dist`, `build`, `out`, `release`,
  `target`, `.next`, `vendor`, `.venv` etc. Vale para o indice do Ctrl+K, para
  o nome solto clicado no terminal e para o Ctrl+Shift+F (no `git grep` vira
  pathspec `:(exclude,glob)**/<pasta>/**`, que pega tambem o `node_modules`
  que um repo esqueceu de ignorar). A arvore de arquivos tem a sua, mais curta
  (`IGNORE_NAMES` em routes/files.ts)
- Conteudo (`searchContent`): cada projeto vira **raizes** — a pasta do projeto
  e cada `subRepos` — e cada raiz e um `git grep -F|-P -I --untracked
  --max-count 20 -z`. Raiz sem git (a pasta do cliente) e varrida **so fora
  dos sub-repos**, listando em paralelo e lendo 16 arquivos por vez; pasta com
  `.git` achada no caminho (repo dois niveis abaixo, que a descoberta nao
  lista) vai para o `git grep` em vez de ser lida arquivo a arquivo. Antes
  disso uma pasta de cliente era lida inteira e em serie: 4,2 s no xifix sem
  nenhum resultado, contra 0,8 s agora
- As raizes rodam 8 por vez na ordem de contexto; quando as primeiras ja
  enchem a pagina (50 arquivos ou 500 linhas) o resto e cancelado (`AbortSignal`
  mata o git). Requisicao abandonada pelo cliente tambem mata (`reply.raw`
  `close`). Teto de tempo: 10 s, 20 s com `includeIgnored`; estourou, responde
  o que tem com `timedOut`. Sem resultado, os 43 repos levam ~2 s: e o custo
  de abrir processo no Windows, nao muda com mais paralelismo (medido de 4 a
  16) nem com `grep.threads`
- `includeIgnored` (botao de pacote / `Alt+I`): `--no-exclude-standard` e sem
  a lista acima. O store do pnpm (`node_modules/.pnpm`) fica fora sempre: o
  git segue os links dele no Windows e uma busca levou 266 s
- Opcoes no padrao do VS Code: `Aa` (Alt+C), palavra inteira (Alt+W, `-w`),
  regex (Alt+R, `-P`), so o projeto aberto (Alt+P), incluir ignorados (Alt+I).
  Ficam em `shipyard:content-search-options`. `buildMatcher` monta a mesma
  regex no server (coluna e trecho) e no client (destaque); PCRE recusando um
  padrao que o JS aceita cai na varredura
- **Duas fases**: com todos os projetos no escopo, o client pede antes so o
  projeto aberto (~0,2 s) e mostra; a resposta completa substitui. Reabrir a
  paleta mantem a ultima busca selecionada
- **Abrir um resultado leva a linha**: `openFileForProject(..., { reveal })` →
  `EditorTab.reveal` (`line`, `column`, `length`, `nonce`) → o
  `CodeMirrorEditor` seleciona o trecho e centraliza. A view nasce no efeito
  da propria lib, por isso o `onCreateEditor` guarda a view em estado. Antes o
  `line` era gravado e ignorado
- **Moldura unica** (`SearchPalette.tsx`): `PaletteShell`, `PaletteInput`,
  `OptionToggle`, `PaletteFooter`, `Highlight`, `Kbd`. As duas paletas usam
  essas pecas; nao desenhar header, rodape ou linha de resultado de novo
- `usePaletteToggle`: o atalho e lido por `event.code` (Caps Lock e teclado
  nao americano nao atrapalham) e **na fase de captura** — sem isso o
  CodeMirror via o Ctrl+Shift+F primeiro e abria a propria barra de busca.
  Abrir uma paleta fecha a outra. `openContentSearch(query)` abre o
  Ctrl+Shift+F ja com o texto: e a ultima linha do Ctrl+K ("Search ... in
  file contents")
- Ctrl+K: sem texto e um lancador (comandos, projetos, tarefas abertas); com
  texto, respostas primeiro e comandos filtrados pelo nome no fim. Prioridade
  e status vem de `taskVisuals`. Chave de linha leva a posicao: ha tarefas com
  o mesmo id e a chave repetida confundia a selecao
- Ctrl+Shift+F busca **todos** os projetos, ranqueados; o botao de pasta /
  `Alt+P` restringe ao projeto aberto
- Os dois palettes cancelam a requisicao anterior (`AbortController`) — uma
  resposta lenta nunca sobrescreve uma nova. Debounce 120ms (nomes) e 200ms
  (conteudo). Resultado que chega depois para a mesma busca mantem a linha
  selecionada; busca nova volta ao topo. Passar o mouse seleciona
