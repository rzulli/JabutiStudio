# Project Explorer (Godot / Graphify)

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Project Explorer (projetos Godot, motor = Graphify)
- Aba **Explorer** do Workspace (`components/explorer/ProjectExplorer.tsx`): busca de
  arquivos/funcoes/sinais/classes, subgrafo ego navegavel (quem chama / quem e
  chamado) e inspector de relacoes. Abrir no editor leva ao arquivo **e a linha**
  (`openFileForProject` + `reveal`); "Ask Claude/Codex" manda o no selecionado e
  suas relacoes como prompt (`shipyard:open-terminal`)
- **Nao existe indexador GDScript proprio.** O motor e o fork
  https://github.com/hidalgob/graphify-godot, externo: `pnpm graphify:setup`
  (`scripts/setup-graphify.mjs`) instala em `data/graphify/{src,venv}`;
  `SHIPYARD_GRAPHIFY_PYTHON` aponta para outro interpretador. O Shipyard so roda
  `python -I -m graphify update` e le o `graph.json` (`services/graphifyAdapter.ts`)
- **O checkout nunca e tocado**: `.gd/.tscn/.tres` + `project.godot` sao copiados
  para `data/graphify/projects/{id}/tree` (sem `addons/`, `.godot/`, `worktrees/`,
  `artifacts/`, `release/`, `playtest_data/`, build) e o Graphify roda la
- A analise e **manual** (botao "Analyze project" / "Re-analyze"; ~25 s no PNMG,
  1440 arquivos, 7,9 mil nos, 22,8 mil relacoes). O server guarda o grafo em
  memoria (por mtime do `graph.json`) e responde `explorer`, `explorer/build`
  (POST), `explorer/search`, `explorer/node`
- **`source`/`target` do graph.json vem trocados em ~metade das arestas**
  (`RefCounted -inherits-> X.gd`, `calls` invertidos). A direcao real esta em
  `_src`/`_tgt`: o adapter usa **so esses**. Nao voltar a ler `source`/`target`
- Arestas duplicadas (mesmo from/to/relation) viram uma com `count`; `contains`
  e `method` viram a lista "Contains" do inspector, nao entram no grafo
- Limitacoes conhecidas da extracao (nao resolvidas de proposito):
  - ~38% das arestas sao `INFERRED`: `calls` casados pelo **nome** da funcao.
    Nomes comuns (`_run()` x312, `_check()`, `_ready()`) apontam para o homonimo
    errado, sobretudo `tests/`. A UI marca "inferred" (tracejado) e o prompt do
    agente avisa para confirmar no codigo
  - Chamada entre arquivos via autoload/instancia (`Global.foo()`) so aparece
    como `calls` inferido; `signal.connect` entre arquivos nao vira `connected_to`
  - `load(variavel)`, varredura de pasta, `get_node()` por string, `.gdshader` e
    `.import` nao sao vistos; `.tres` de dados (ex.: `perks_v5/*.tres`) aparecem
    como nos soltos
  - Scripts em `addons/` ficam fora do grafo; uma ref a eles aparece como no
    "externo" (nome do `res://...` entre aspas)
  - Escopo de classe interna e por nome global (pode colidir com funcao de topo)
  - O grafo e um retrato: muda depois de editar codigo ate re-analisar
- **Listas por tipo**: `searchGraph` (graphifyAdapter) sem texto lista **todos** os
  nos do tipo da aba (arquivo, linha, nome); "All" sem texto lista so arquivos.
  A resposta traz `counts` do grafo inteiro (contadores nas abas). Antes a busca
  vazia so devolvia arquivos e Functions/Signals/Classes ficavam sempre vazias.
  O estado vazio vem de `listState` (`lib/explorerView.ts`): loading / erro /
  indice sem esse tipo / nenhum resultado para o texto. Logica de view fica em
  `explorerView.ts` (testavel), nao no componente
- **Selecionar x abrir**: 1 clique seleciona (230 ms de espera, o duplo clique
  cancela, senao o grafo recentra sob o mouse); duplo clique, botao `</>` do no
  ou "Open in editor" abrem. O Explorer chama `editor.openFile(..., { reveal })`
  direto — `openFileForProject` dispara `shipyard:workspace-mode` e trocaria a
  vista — e emite `shipyard:explorer-editor` (`EXPLORER_EDITOR_EVENT`)
- **Explorer + Editor lado a lado** (`pages/Workspace.tsx`): o editor abre num
  painel ao lado (split flex com alca de arraste por pointer events, fracao em
  `shipyard:explorer-split:{id}`, aberto em `shipyard:explorer-editor-open:{id}`;
  empilha abaixo de 900 px). O Explorer **nao remonta** (mesma arvore) e entra em
  modo `compact`: lista 230px, Inspector vira gaveta ("Details") e o toggle
  "Follow" (`shipyard:explorer-follow`, default off) faz a selecao navegar o
  editor aberto. Fechar o painel mantem os arquivos como abas
- **Defasagem da analise**: `doBuild` grava `meta.json` (`startedAt`, `root`) ao lado do
  grafo; `getStaleness` conta arquivos editados/novos/removidos desde entao (cache
  30 s, sem watcher). Sem `meta.json` (analise antiga) = desconhecido, nada e mostrado
- **Ask Claude/Codex** manda projeto, checkout (`root` da analise) e `arquivo:linha`
  (`buildAgentPrompt`). O Explorer indexa o checkout do projeto, nao worktrees de task
- **Realce de Godot** (`lib/godotLanguage.ts`): `.gd`, `.tscn`, `.tres` com
  `StreamLanguage` (token a token). E so realce — sem AST, escopo ou tipos. As
  tabelas de linguagem do CodeMirror/DiffEditor sao chaveadas **com o ponto**
- **Testes**: `pnpm --filter server test` (fatia real do grafo do PNMG em
  `server/test/fixtures`, regenerada por `server/test/make-fixture.mjs`; cobre
  adapter, rotas, `_src/_tgt`, EXTRACTED/INFERRED, busca, defasagem e a logica do client)
