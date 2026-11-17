# Servidor: cache, performance, stores JSON, acesso local, Electron

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Cache e Invalidacao (react-query)
- `staleTime` default: 3s (`main.tsx`) — evita refetch de tudo a cada foco de janela
- refetchInterval: 5s (git status, tasks do board), 30s (`['tasks','all']`, projects)
- `['tasks','all']` le TODOS os arquivos de tasks — e a query mais cara. Componentes
  sempre montados (GlobalSearch, CommandPalette) passam `useAllTasks({ enabled: open })`
- Mutations de tarefas DEVEM invalidar `['tasks', projectId]` E `['tasks', 'all']`
- Auto-pull so invalida quando houve mudanca real (created/updated), nunca a cada tick

### Performance (regras que nao podem regredir)
- `syncStore`: leituras vem do cache em memoria (`cachedStore`); o processo e o
  unico escritor. Nunca voltar a ler o JSON do disco por chamada
- `taskStore`: caminho de leitura NAO escreve. O backfill de `number` persiste
  uma unica vez, sob lock, e retorna a lista ja autoritativa
- `projectDiscovery`: o timer de git continua em 15s, mas cada repo decide se
  esta na vez (`gitPoll` em `refreshGitStatus`). Resultado identico 4 vezes
  seguidas → 60s; 8 vezes → 120s. Volta a 15s quando o resultado muda, quando
  o repo e usado pelo app (`gitService.touch`: toda mutacao via
  `invalidateStatus`, o fim de um `fetch` e a rota `git/status`), quando
  `.git` muda no disco (mtime/tamanho de `HEAD`, `logs/HEAD` e `index`) ou
  enquanto houver terminal aberto no projeto (agente editando nao deixa rastro
  em `.git`). **O sinal de disco so acorda mais cedo, nunca prova que nada
  mudou** — o `git status` de verdade sempre roda no fim da espera. Projeto
  sem `.git` so e rechecado a cada 180s (pega `git init` posterior).
  `git log -1` so roda quando `HEAD`/`logs/HEAD` mudam (`getLastCommit`); com
  `.git` arquivo (worktree, submodule) ou sem reflog roda sempre. Usa
  `gitService` (instancia compartilhada por repo = fila serializada).
  `status.current` ja da o branch — nao chamar `git.branch()`. Remote URL e
  sub-repos sao cacheados. Rota ou mutacao de git nova tem que passar por
  `invalidateStatus`/`touch`, senao o repo fica no poll lento
- `cliDetect`: CLI encontrado fica em cache por 6h; CLI ausente, 60s (instalar
  com o app aberto aparece em um minuto). Cada sondagem sobe `where` + o
  proprio CLI — nao voltar a TTL curto para o caso encontrado
- `gitService`: **`fetch` nunca bloqueia uma rota**. Ele fala com a rede (um
  remote lento ou um prompt de credencial travava `git/status` por dezenas de
  segundos — medido em 80s num sub-repo), roda numa instancia SimpleGit propria
  (fila separada da de leitura), com `GIT_TERMINAL_PROMPT=0` e dedupe por repo.
  A rota de status dispara com `void` e o poll de 5s pega o novo ahead/behind
- `gitService.getStatus`: cache de 2,5s por repo + dedupe de chamadas em voo —
  o painel (5s), o refresh de projetos (15s) e o task review pediam o mesmo
  `git status` e enfileiravam no mesmo repo. **Toda mutacao chama
  `invalidateStatus`** (senao a UI mostra estado velho depois de um stage)
- `lib/prefetch.ts`: passar o mouse numa aba/linha de projeto ja busca tasks e
  git status daquele projeto (cooldown de 10s). As chaves tem que espelhar
  `useTasks`/`useGitStatus` — chave diferente enche cache que ninguem le
- `logService`: escritas em disco sao bufferizadas (flush 200ms / 64 linhas)
- **Aviso que se repete a cada ciclo usa `log.warnThrottled(chave, ...)`**:
  uma linha por chave a cada 10 min (push ao Trello, 5 min). Ate 2026-11, 58%
  do `server.log` eram as mesmas falhas do Trello e do medidor de uso
- Medidor de uso: depois de um 429, 10 min sem perguntar (`backoffUntil`),
  servindo a ultima leitura como `stale`
- Comentarios do Trello: no maximo uma busca a cada 2 min por board
  (`boardComments`, cache por `boardId`, compartilhado entre projetos que
  apontam para o mesmo board); falha reaproveita a ultima lista
- Componentes de lista (`TaskItem`, `SortableTaskItem`, `TaskRow`) sao `React.memo` —
  o structural sharing do react-query mantem `task` estavel entre polls
- Editor (CodeMirror), terminal (xterm) e markdown sao `lazy()`. **Nao** usar
  `manualChunks`: agrupar vendors puxa modulos compartilhados para o entry chunk

### Acesso local (seguranca)
- A API le arquivos e abre terminal: alcancar o server equivale a rodar codigo na
  maquina. **A fronteira e a propria maquina**: `SHIPYARD_HOST` default
  `127.0.0.1`, e o server recusa subir em host que nao seja loopback. Nao ha
  login nem token na API: processo do mesmo usuario ja le `data/`
- Sobra uma porta de entrada, a pagina aberta no navegador. `localAccess.ts`
  (`rejectionReason`) fecha, num hook `onRequest` registrado antes das rotas e do
  CORS, entao vale para preflight e upgrade de WebSocket:
  **Host** so loopback (DNS rebinding), **Origin** so a da propria porta (mais
  a do Vite quando a porta e 5420; `null`, do iframe sandbox do preview, cai
  aqui) e **Sec-Fetch-Site** so `same-origin`/`none`, com excecao de navegacao
  de topo (`<img src>` nao manda Origin). Sem Origin passa: agente, hook e curl
- Nao reabrir o CORS para cliente MCP de navegador nem por rota: a spec do MCP
  exige checar Origin. Cliente MCP em Node nao manda Origin
- `POST /authorize` e a tela de consentimento so aceitam `redirect_uri`
  registrado (`isRegisteredRedirect`; porta loopback pode variar, RFC 8252), e a
  tela escapa tudo que o cliente declarou

### Stores JSON (concorrencia)
- `taskStore.ts` e `syncStore.ts` serializam toda mutacao com mutex (promise chain)
  e gravam pelo `writeJsonAtomic` de `atomicJson.ts` (tmp + rename). Leitura
  corrompida usa ultima copia boa em memoria + backup `.corrupt-*.bak` — nunca
  retorna store vazio sobre dados existentes
- **Escrever direto por cima do arquivo trunca antes de gravar**: se o processo
  morre nessa janela, o que fica no disco e meio JSON e a leitura seguinte
  falha. Quanto maior o arquivo, maior a janela — um `tasks/*.json` de 1,3 MB
  gerou sozinho 855 `.corrupt-*.bak` (1,4 GB) antes de o taskStore passar a
  usar tmp + rename. `settingsStore` e `mcpAuth` tinham o mesmo furo
- Novos stores JSON DEVEM seguir esse padrao (read-modify-write sem lock corrompe
  dados; escrita nao atomica corrompe arquivo)

### Electron
- Bootstrap do backend em `electron/serverBootstrap.ts` (puro, testado em `server/test/electronBootstrap.test.ts`):
  antes de subir qualquer coisa, `GET /api/identity` na porta do backend (5420 dev / 5430 prod).
  - Porta livre (ECONNREFUSED) → Electron spawna o server (`own`) e o encerra no quit.
  - Resposta `app: "jabutistudio"` com `protocol` igual a `SERVER_PROTOCOL` → reusa (`external`);
    nunca e encerrado pelo Electron. Se o server nao serve o client (`serveClient: false`, dev),
    a janela carrega o Vite em 5421, que faz proxy de `/api` para o mesmo backend.
  - Qualquer outra coisa na porta (404, HTML, protocolo diferente, sem resposta) → erro claro,
    nada e iniciado nem parado. Um backend JabutiStudio antigo, sem `/api/identity`, cai aqui:
    reinicie o `pnpm dev` uma vez.
  - `SERVER_PROTOCOL` e duplicado em `server/src/routes/identity.ts` e `electron/serverBootstrap.ts`;
    o teste compara os dois. Mude os dois juntos.
- Server roda como child process via spawn (`ELECTRON_RUN_AS_NODE=1`) quando a porta esta livre
- Menu de aplicacao em `createApplicationMenu()` (main.ts) envia acoes via IPC
  `menu-action` → preload expoe `electronAPI.onMenuAction` → hook `useElectronMenu`
  roteia (`navigate:<path>`) ou redispara CustomEvents (`shipyard:toggle-search`,
  `shipyard:toggle-file-search`, `shipyard:toggle-terminal`)
- Atalhos Ctrl+K / Ctrl+Shift+F / Ctrl+` sao do renderer; itens de menu usam
  `registerAccelerator: false` para mostrar o hint sem duplicar o handler
- Terminal integrado (xterm) repassa esses atalhos globais via
  `attachCustomKeyEventHandler` (return false) em IntegratedTerminal.tsx
- Data path: `SHIPYARD_DATA_DIR` env var → AppData em prod, ./data em dev
- Centralizado em `server/src/services/dataDir.ts`
- asar desabilitado, afterPack reinstala deps via npm (pnpm symlinks nao sobrevivem)
- O main process so tem uma dep de runtime, `electron-updater`. O afterPack a
  instala num manifest descartavel e copia para `resources/app/node_modules`:
  `npm install` contra o `package.json` da raiz resolve a arvore de dev inteira
  (electron-builder junto) e estoura o timeout
