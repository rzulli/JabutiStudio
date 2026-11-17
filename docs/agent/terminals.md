# Terminais integrados, estado de sessao Claude, hooks

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Terminais (multiplataforma)
- **Windows**: `wt.exe` + `cmd.exe /k` (NAO bash — causa erro WSL)
- **Linux**: `gnome-terminal --title --working-directory` + `bash -c "cmd; exec bash"`
- **macOS**: `osascript` (Terminal.app)
- Terminal integrado: xterm.js + node-pty (optional dep) + WebSocket

### Terminal integrado — copiar/colar e performance
- **Colar SEMPRE via `term.paste()`** (client). Ele converte `\n` → `\r` e aplica
  os marcadores de bracketed paste (`\x1b[200~`…`\x1b[201~`) quando o programa os
  pediu. Enviar o texto cru pelo WebSocket faz o Claude CLI ler cada `\n` como
  Enter e submeter linha a linha
- **Caminho de arquivo impresso e clicavel** (`lib/terminalLinks.ts`,
  `registerLinkProvider`): `C:\x\y.ts`, `src/a.ts:12`, `./x`, `~/x`, `file://` e
  nome solto com linha (`TaskRail.tsx:121`). Linhas quebradas pela largura
  sao juntadas antes de procurar; URL web fica com o `WebLinksAddon`. O clique
  chama `POST /api/terminal/sessions/:id/open-path`: relativo parte do `cwd`
  da sessao, nome solto e procurado no indice do projeto da sessao, arquivo
  dentro de um projeto conhecido (o mais fundo vence) volta como `editor` e
  abre no Editor (`openFileForProject`); pasta, arquivo fora de projeto ou
  **Ctrl/Cmd+clique** abrem no app do sistema (`openFolder`). **Arquivo que
  executa** (`RUNNABLE_EXT`: exe, bat, cmd, ps1, js, vbs, lnk, msi...) so e
  mostrado na pasta (`revealInFolder`), nunca aberto: um link OSC 8 pode
  esconder um `setup.exe` atras de "README". Caminho de rede (`\\servidor`)
  e recusado antes do `stat` (o Windows mandaria o hash NTLM). Hyperlink OSC 8
  passa pelo `linkHandler` do xterm: `file://` vai pela mesma rota, http no
  navegador. Ainda nao pula para a linha
- Botao direito: copia se ha selecao, senao cola. Botao do meio cola.
  Com mouse tracking ligado (Claude CLI), selecionar exige **Shift**+arrastar
- Imagens coladas com Ctrl+V sao salvas temporariamente em `data/terminal-clipboard/`
  e o caminho absoluto e inserido no prompt; limite de 10 MB e limpeza oportunista
  apos 24h
- `safeChunks()` (server) nunca corta um par surrogate nem uma sequencia de escape.
  Cortar `\x1b[201~` ao meio prende o CLI em bracketed-paste e engole o prompt
- Toda escrita no PTY passa por uma **fila por sessao** — sem ela uma tecla
  digitada cai no meio de um paste em andamento
- Saida do PTY e agrupada por ~8ms antes de ir pro WebSocket (um redraw de TUI
  gera centenas de chunks minusculos)
- Renderer WebGL com fallback automatico para DOM (`attachRenderer`)
- **O xterm e o dono do scrollback e dos modos do terminal** (tela alternativa,
  mouse tracking, bracketed paste): o programa liga uma vez e nao repete. Por
  isso o TerminalPanel **esconde** o conteudo quando fecha (`hidden`), nunca
  desmonta — um xterm novo nascia sem mouse tracking e a roda parava de rolar o
  Claude Code em `tui: fullscreen` depois de uma ida ao Board (a tela parecia
  certa porque o ConPTY repinta no resize). Para xterm criado depois (reload),
  `trackTerminalModes` (terminalService) guarda os modos ligados e o WS manda
  `terminalModePreamble` antes de qualquer saida

### Indicador de "esperando resposta" no terminal Claude
- `startOutputWatcher` (terminalService.ts) roda em **toda** sessao e classifica
  em `busy` / `awaiting-input` / `idle` / `finished`. So **observa**: nunca
  escreve no PTY, nunca toca na fila de escrita nem no flag `injecting` —
  escrever ali corromperia um paste em andamento
- **Quem decide que ha Claude ali e a tela, nao o tipo da sessao**: o usuario
  abre um shell e digita `claude`. Duas fontes: o **titulo do terminal** (o CLI
  escreve `OSC 0` com `✳ Claude Code`) e `CLAUDE_SCREEN_RE` (marcas na tela). O
  watcher fica **mudo** ate uma delas aparecer — terminal comum nunca pisca
- **O titulo tambem diz se ha execucao**: o glifo na frente e `✳` em repouso e
  um spinner (`◐`, `◑`...) enquanto trabalha. Spinner = `busy` + `working`
- `finished` e o `idle` que interessa: o CLI voltou ao prompt vazio **depois de
  receber trabalho**. Quem separa os dois e `session.working`, ligado pela
  injecao de prompt, pelo spinner do titulo e por input do usuario com Enter, e
  desligado ao anunciar. O anuncio e unico: o proximo so vem com trabalho novo
- **`awaiting-input` e `finished` sao pegajosos**: so input de verdade ou uma
  execucao nova os tira. Saida sozinha **nao** volta para `busy` — o TUI
  repinta parado, e tratar isso como "voltou a trabalhar" apagava o aviso antes
  de alguem ver. Pelo mesmo motivo `noteSessionInput` ignora as respostas
  automaticas do xterm (foco, posicao do cursor, device attributes, mouse):
  ninguem digitou aquilo
- **Pergunta em prosa conta como pergunta**: uma execucao que termina com `?`
  nas ultimas linhas acima da caixa vira `awaiting-input`, nao `finished`
  (`asksSomething`). Dialogo de permissao e opcoes numeradas continuam em
  `DECISION_RE`
- A classificacao roda sobre a saida **limpa** (`cleanTerminalOutput`) e so
  sobre as ultimas 15 linhas. **Vale a marca desenhada por ultimo, nao a
  presenca**: um pedaco assentado guarda todos os frames desde o anterior, e
  uma execucao curta cabe inteira nele (`esc to interrupt` e o prompt final
  juntos). Testar so presenca prendia a sessao em `busy`
- `IDLE_PROMPT_RE` aceita a regua colada na frente do prompt
  (`────────❯ Try "..."`): a regua tem a largura do terminal, que quebra a
  linha sozinho sem emitir quebra. Sem isso um CLI recem-aberto nunca era lido
  como parado
- Sessao com prompt injetado: o watcher e ligado **na criacao** com
  `watchHold` (para ver o titulo que o CLI escreve assim que o prompt cai) e so
  comeca a julgar a tela em `releaseOutputWatcher`, quando a injecao termina —
  durante a espera o CLI mostra prompt ocioso e daria falso `idle`. Bug
  antigo: o reconhecimento da tela zerava `working` tambem nessas sessoes, e
  task rodada pelo "Run with AI" nunca avisava que tinha terminado
- Digitar `claude` e dar Enter conta como input e ligaria `working`, entao o
  reconhecimento do CLI **zera `working`** (fora de `watchHold`): subir o CLI
  nao e trabalho
- **So o que submete conta como resposta** (`noteSessionInput`): Enter, ou,
  num dialogo, digito e Esc. Seta e rascunho digitado nao tiram o aviso — antes
  cada tecla virava `busy` e a pergunta piscava. `session.asking`
  (`dialog` | `prose`) diz de que tipo e a espera
- `DECISION_RE` casa tambem o **rodape** do dialogo (`Enter to confirm`,
  `Enter to select`, `Esc to cancel`): ele e a ultima linha de todo dialogo,
  entao continua a vista quando a lista e mais alta que as 15 linhas lidas, e
  ha dialogo sem numero nenhum ("Yes, I trust this folder"). Era assim que uma
  pergunta pendente aparecia como "trabalhando"
- **O titulo e a melhor testemunha de "nada rodando"** (`session.resting`):
  um Esc devolve o prompt enviado para a caixa, entao a tela nao mostra prompt
  vazio, e um pedaco pode terminar num `esc to interrupt` velho
- Titulo **vazio** = o CLI saiu (`markCliGone`): estado volta a `null` (shell
  comum). `goneUntil` ignora por 5s os ultimos frames, que ainda trazem as
  marcas do CLI
- Sessao de outro agente (Codex, Aider...) **nao recebe estado**: nada do que
  lemos vale para a tela deles e a aba ficava em `busy` para sempre
- Tudo sai por **um fluxo SSE**, `GET /api/terminal/events`
  (`onSessionEvent`): `snapshot` ao conectar, depois `state` / `label` /
  `exit`. O socket de um terminal so existe com ele montado, e timer de janela
  minimizada e estrangulado pelo Chromium ate 1 tick por minuto — por isso nao
  ha mais poll nem frame de estado no WS. O `EventSource` reconecta sozinho e
  cada conexao recomeca do snapshot
- O `pty.onExit` do **service** fecha a sessao e emite `exit`; antes so o WS
  ouvia, e processo que morria com o painel fechado ficava zumbi
- No client: `state` no `GlobalTab` (o que o CLI faz) + `awaitingInput` /
  `finished` (ainda nao visto). `tabStatus()` reduz a um `SessionStatus`.
  Pergunta fica acesa ate ser respondida, mesmo na aba aberta; "terminou" some
  quando a aba e vista

### Hooks do Claude Code (fonte primaria do estado)
- Ler a tela e inferencia. Sessao Claude aberta pelo Shipyard sobe com
  `--settings data/claude-hooks/{sessionId}.json` (`claudeHooks.ts`): hooks
  `type: http` que postam em `POST /api/terminal/hook/:sessionId`. Nada em
  `~/.claude` nem no projeto e tocado; o arquivo some com a sessao e a pasta e
  varrida no boot
- Eventos e o que viram (`handleClaudeHook`): `UserPromptSubmit` → `busy`;
  `PreToolUse` de `AskUserQuestion|ExitPlanMode`, `PermissionRequest` e
  `Elicitation` → `awaiting-input` (dialog); `Stop` → `finished`, ou
  `awaiting-input` (prose) quando `last_assistant_message` termina em `?`
  (`endsWithQuestion`, ultimas 3 linhas); `StopFailure` → `finished`;
  `SessionEnd` (menos `reason: clear`) → sem estado
- **So esses eventos**: cada hook e um request que o CLI espera. Nao registrar
  `PostToolUse` nem `PreToolUse` geral — tool de subagente em paralelo
  apagaria uma pergunta pendente. `Notification: permission_prompt` chega 6s
  depois do dialogo e marcaria pergunta ja respondida
- A rota responde `{}` na hora: qualquer corpo seria lido como decisao sobre a
  tool
- **Hook e titulo chegam por canais diferentes** (HTTP e PTY) e em qualquer
  ordem: spinner no titulo ate 1,5s depois de um hook de parada
  (`HOOK_TITLE_GRACE_MS`) e o frame anterior, nao trabalho novo
- Com `session.hooked` o leitor de tela so cobre o que hook nenhum anuncia:
  dialogo desconhecido (so enquanto a aba diz `busy`), Esc e comando de barra
  (titulo em repouso + `busy` → `idle`). Enter nao vira `busy` ali — quem diz
  e o `UserPromptSubmit`
- `claude` digitado a mao num shell nao tem `--settings`: segue so pela tela
- Verificado no CLI 2.1.289. `SessionStart` nao chega por hook http

### Avisos de sessao (som, notificacao, barra de tarefas)
- `lib/sessionAlerts.ts` + cartao em Settings > Preferences. Por evento
  (`question` / `finished`) tres canais: som, notificacao e barra de tarefas.
  Fica em `shipyard:session-alerts` (localStorage — e desta maquina)
- Quem dispara e um efeito no TerminalPanel que compara o `state` de cada aba
  com o anterior. **Vale a mudanca**: estado que ja estava la no load e aba
  vista pela primeira vez nao sao noticia (`alertsArmedRef`)
- "Olhando" = aba no pane **e** painel aberto **e** `document.hasFocus()`
  (`isWatching`). Janela minimizada ou atras de outra nao conta — a aba
  ativa tambem ganha o "terminou" e o aviso sai. Voltar o foco limpa
- Olhando: nada, ou so o som se `whenWatching`
- Desktop: IPC `session-alert` → `Notification` do Electron (`silent`, o som
  e nosso) + `flashFrame`; o clique manda `session-alert-click` e o renderer
  emite `shipyard:focus-terminal`. Navegador: Web Notification (pede
  permissao ao ligar) e `●` no titulo da aba
- Sons em `lib/sounds.ts` (`playSessionSound`): pergunta = a mesma nota duas
  vezes; terminou = tres notas subindo. Tem que dar para distinguir sem olhar
- `backgroundThrottling: false` na janela: agente trabalha com ela minimizada

### Ultimo terminal por projeto
- `shipyard:terminal-last-by-project` (`{ projectId: sessionId }`), gravado
  quando a aba ativa muda. Voltar a um projeto reabre a sessao que estava
  aberta nele; sem lembranca (ou sessao fechada), a primeira viva

### Retomar conversas do Claude depois de reiniciar
- Depois de um reboot nenhum terminal sobrevive. `claudeConversations.ts` le
  os transcripts do proprio Claude Code (`~/.claude/projects/<cwd com todo
  nao-alfanumerico virando ->/<id>.jsonl`): titulo (`custom-title` vence
  `ai-title`), `last-prompt` e `permission-mode` (`bypassPermissions` = YOLO),
  lendo so os ultimos 256KB e com cache por mtime. Nao guardamos copia
- O que guardamos e **quais conversas estavam numa aba**
  (`data/claude-conversations.json`): todo hook traz `session_id`, e
  `handleClaudeHook` mantem `session.claudeSessionId` (muda no `/clear`). A
  entrada so sai quando o usuario fecha a aba (`DELETE` da sessao) — desligar
  o PC mata os PTYs sem passar por essa rota, entao a lista sobrevive
- `POST /api/terminal/sessions` com `resume` roda `claude [--dangerously-skip-permissions] --resume <id>`
  no cwd onde a conversa rodou (o Claude so acha a conversa a partir dele),
  ja com o titulo na aba e sem mover a task para In Progress
- `ResumeConversations` aparece no Dashboard (todos os projetos, "Reopen N
  tabs") e no estado vazio do painel de agentes. Em focus o painel fecha em
  projeto sem sessao; por isso, uma vez por projeto apos o boot, ele abre se
  houver conversa "open at close"

### Abas do terminal: nome, ordem e split
- O nome de uma aba nao e uma string so: o server guarda `projectName`,
  `typeLabel`, `taskTitle`/`taskNumber`, `customTitle` e `summary` na sessao, e
  `describeTab()` (TerminalPanel) escolhe nessa ordem —
  **customTitle > task > summary > tipo**. O `title` antigo
  (`[Projeto] Shell`) so serve de fallback para sessao velha
- Aba de task abre com o numero: `#12 Titulo` (com `Projeto ·` so fora de um
  projeto, onde a fila e global). O truncamento come o fim do rotulo, nunca o
  numero
- **Aba de Claude sem task usa o titulo que o proprio Claude Code da ao
  terminal** (`OSC 0`, lido em `readTitles`): o assunto da conversa, um segundo
  depois do primeiro prompt, na lingua do usuario e sem chamada de IA. So vale
  depois que o terminal se apresentou como `Claude Code` (`session.titled`) —
  qualquer programa pode por um simbolo na frente do titulo. Com `titled` o
  resumo por IA nao roda: ele so via o banner e escrevia "Claude Code session
  started"
- Rotulo novo vai por WS (`{ type: 'label', summary }`, `setLabelListener`) e
  cai na aba na hora; o poll de sessoes cobre o terminal desmontado
- Sessao aberta para uma task recebe titulo e numero da task **no server**
  (`POST /api/terminal/sessions` le a task) — sobrevive a refresh sem o client
  carregar nada
- Shell e dev sem task ganham um rotulo escrito pela IA a partir da saida do
  proprio terminal (`terminalSummary.ts` + `startSummaryWatcher`). Regras que nao podem
  cair: so tipos `shell`/`dev`/`claude`/`claude-yolo` (aba de Claude tambem —
  "Claude" diz tao pouco quanto "Shell" quando ha tres abertas), so depois de
  3s de silencio e 120 chars novos,
  no maximo uma chamada a cada 45s por sessao, **uma chamada por vez no
  processo inteiro** (fila em terminalSummary) e a sessao sai do watcher depois
  de 2 falhas. Desliga em Settings > AI (`terminalAiTitles`)
- `cleanTerminalOutput` transforma `ESC[nC` (mover para a direita) em n
  espacos: a TUI do Claude Code desenha **todo** espaco assim, e descartar a
  sequencia gruda a tela inteira numa palavra so (`fixlinterrors`) — era isso
  que estragava o rotulo escrito pela IA
- `cleanTerminalOutput` existe porque o ConPTY **move o cursor** em vez de
  escrever `
`: sem transformar `ESC[linha;colH` em quebra de linha, um
  `git status` inteiro vira uma linha so. E o `
` do CRLF tem que sair antes
  do split de redraw, senao o texto da linha some com ele
- Renomear: duplo clique na aba ou "Rename tab" no menu. Campo vazio devolve a
  aba ao nome automatico. O nome vai pro server (sobrevive a refresh)
- O tooltip da aba e o `title` nativo, como nas abas de projeto: um Tooltip do
  Radix em volta do trigger **engole o clique direito** que abre o menu
- Abas dividem a largura (`basis-0 flex-1`), truncam e sao reordenaveis por
  drag (mesmo gesto das abas de projeto)
- A aba aberta tem que ser achada num relance numa fila de oito: fundo aceso,
  `font-medium` e uma regua neutra de 2px no topo (`before:`). Neutra de
  proposito — cor ali brigaria com o numero do pane no split
- Fechar uma aba leva o workspace para o projeto da aba vizinha
  (`followTabProject`) — antes o terminal trocava e o projeto ficava para tras
- No split, a cor vive **so** no numero do pane (1 azul / 2 verde) e na regua
  do topo do pane focado. Nada de anel colorido em volta da aba: ao lado das
  abas de projeto, neutras, aquilo virava ruido
