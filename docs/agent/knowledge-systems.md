# Design Knowledge nativo e System Explorer

> Detalhe sob demanda. O contrato curto fica em CLAUDE.md na raiz; este arquivo foi movido sem alteracao de conteudo.

### Design Knowledge (decisoes de design do projeto, lidas pelo Explorer)
- **R1-B3: o dk.py foi aposentado.** O JabutiStudio e o unico motor de DK: nao ha Python,
  CLI por jogo nem ponte. As decisoes moram no projeto em `jabutistudio.decisions.json`
  (ver "Design Knowledge Core"); `designKnowledge.ts` so guarda o que sobrou de apoio
  (checkouts examinaveis, relacoes do Graphify, ledger de atestacoes). Registros
  `docs/design_knowledge/records/*.md` que ainda nao foram migrados sao so **avisados**
  em `limitations`, nunca lidos por outro motor
- **Aprovacao** (tres niveis): `claimed` = documento/agente afirma; `attested_local` =
  atestacao no ledger local (`source: "attested_local"`); `verified` = identidade
  verificada de forma independente — **nao existe**. Arquivo do repositorio so produz
  `claimed`. A atestacao esta presa ao sha256 do texto da decisao: editar o texto a faz
  caducar (`attestation-lapsed`). Quem grava e `POST /design/approve`, que exige
  `Origin` igual ao `Host` + `sec-fetch-site: same-origin` + `sec-fetch-dest: empty`
  (o fetch do renderer). curl puro, MCP e hook levam 403; header so de Sec-Fetch sem
  Origin tambem. **Mas qualquer processo local que forje `Origin`+`Sec-Fetch-*` passa
  (reproduzido): `attested_local` NAO prova que uma pessoa clicou**, so que alguem
  chamou a rota. A UI diz "attested locally", nunca "approved by you". Nao ha
  autenticacao no servidor local (ver "Acesso local"); nao introduzir sem discutir.
  **Nao existe tool MCP de aprovar** — nao criar
- **Ledger**: `data/design-approvals/{projectId}.json` (fora do repositorio): sobrevive a
  restart, mas nao acompanha clone/nova worktree/outra maquina — leve junto com a data
  dir (workspace-export a inclui) ou atteste de novo. Agente com acesso ao filesystem pode editar o arquivo (sem HMAC,
  de proposito: a chave ficaria ao lado)
- **Raiz examinada x registro canonico**: o registro vem sempre do checkout do
  projeto; a evidencia e julgada em `--root` (uma worktree listada pelo `git
  worktree list`, nunca caminho arbitrario). A resposta traz `examined.isCanonical`
  para a UI nunca ler codigo de task como "integrado"
- Frescor por fonte: CURRENT | MOVED | CHANGED | AMBIGUOUS | STALE | GONE | UNKNOWN.
  Referencia sumida ou renomeada rebaixa o estado, nunca derruba a consulta
- MCP `get_design_context` (read-only; `taskId` usa a worktree da task). Inspector
  do Explorer: secao "Design decisions" (`DesignDecisions.tsx`) com aprovacao,
  conflito, evidencia por origem e impacto candidato (lista manual, incompleta)
- Testes: `pnpm --filter server test` (`test/design.test.ts` migra o registro da fixture e consulta so o nativo)

### Design Knowledge Core (R1-B1: contrato unico; R1-B3: so nativo)
- `designCore.ts` e o **unico contrato** que Inspector, System Explorer, rotas e MCP consomem
  (`query({file|q|id|system, worktree, revision})`, `forSystem`, `propose`, `attest`). Uma fonte (desde o R1-B3):
  a **nativa** (`designDecisions.ts`), na forma `Decision` (campos snake_case herdados do dk.py, para nao quebrar a UI).
  O legado (dk.py) foi removido; o que segue abaixo sobre ele e historico.
  Registros legados nunca sao convertidos nem reescritos; mesmo id nos dois = mostra o nativo e avisa
- **Persistencia nativa**: `jabutistudio.decisions.json` na raiz do repo do jogo (v1, `gitRoots` como o
  `jabutistudio.systems.json`, schema zod estrito, caminhos relativos sem `..`, sem caminho absoluto). Nao precisa de
  Python nem de `docs/design_knowledge/`. So guarda **alegacoes + evidencias** (`status: proposed|withdrawn`);
  **aprovacao nunca entra no arquivo** (fica no ledger `attested_local` em `data/design-approvals/`, preso ao sha256
  do `claim`: editar o texto a faz caducar -> `approval.lapsed`). Sistemas sao referenciados por id (`systems[]`);
  nada de decisao e copiado para o arquivo de sistemas. Escrita so no checkout canonico (tmp+rename, lock); worktree
  e `revision` sao somente leitura
- **Proposta, nunca aprovacao**: `addProposal` exige >=1 evidencia real (arquivo existe, `needle` presente, fingerprint
  tirado na hora), referencias (`conflictsWith`/`supersedes`) existentes, origem `agent` (MCP, curl) ou `user` (so
  declara quem escreveu; nao verifica). MCP `propose_design_decision` so propoe; nao existe tool de aprovar
- **Frescor derivado a cada leitura** do checkout (ou `git show <revision>:`): CURRENT | MOVED (mesmo fingerprint/texto
  em outro caminho, mesma extensao, unico candidato) | AMBIGUOUS (varios) | CHANGED (arquivo mudou, texto ainda la) |
  STALE (texto sumiu) | GONE | UNKNOWN (evidencia sem fingerprint nem texto). `implementation`: `divergent` quando
  evidencia `code` com needle ficou STALE/GONE. CURRENT nao significa aprovado
- **Confianca**: `approval.state` unknown | claimed (evidencia `human_decision` em arquivo/documento = afirmacao nao
  verificada) | approved/rejected com `source: attested_local`. Conflitos (`conflicts_with`, inverso derivado) sao
  preservados lado a lado em `conflicts[]`; nunca se escolhe um lado
- `available` agora e verdadeiro para qualquer repo git (a fonte nativa pode estar vazia): o catalogo de sistemas mostra
  "None recorded" + "Propose decision…" em vez de "Not indexed". Rotas: `GET /design` (`file|q|id|system`, `worktree`,
  `revision`), `POST /design/proposals`, `POST /design/approve` (so UI). Testes: `server/test/designCore.test.ts`
  (T1-T11 do R1-B1). R1-B3 aposentou o dk.py (ver "Aposentadoria do dk.py")

### Migracao do DK legado (R1-B2: `designMigration.ts`)
- `docs/design_knowledge/records/*.md` (cabecalho `<!-- dk-record {json} -->`, lido por `legacyRecords.ts`, **sem Python**) ->
  `jabutistudio.decisions.json`. Deterministica e idempotente: mesmo legado = mesmos bytes; segunda rodada = `nothing-to-do`
  (resultado `equivalent` por registro). Os arquivos legados e o `dk.py` **nunca** sao tocados. Cada decisao migrada guarda o
  bloco `legacy` (`sourceRecord`, `sourceRecordSha256`, estados catalogados, `implementationSources`, ids) e entra como `proposed`
  com `origin: legacy`: **nada e promovido**. Aprovacao continua so no ledger `attested_local` (preso ao sha256 do claim: editar
  o texto migrado a faz caducar -> `attestation-lapsed`); `decision_state`/`approval_state` do registro viram, no maximo, `claimed`
- `plan(project, resolutions?)` so le e devolve `planSha256`; `apply` exige esse hash (a tela/CLI aplica o que foi revisado) e
  grava com backup + manifesto em `<data>/design-migration/<projectId>/<id>.json`; `rollback(manifestId)` restaura o arquivo
  anterior (ou remove o criado) e recusa se o arquivo foi editado depois. Registro que nao converte sem perda (campo sem
  equivalente, referencia inexistente ou fora do checkout, id invalido, arquivo ilegivel) **bloqueia**: nada e escrito. Decisao
  nativa com mesmo id e conteudo diferente = `divergent` e bloqueia; so `keep-native`/`take-legacy` explicitos resolvem. Os dois
  lados nunca sao mesclados. Evidencia externa (`@economy_csv:...`) fica `UNKNOWN` no nativo (dk.py lia via env): diferenca documentada
- Rotas: `GET /design/migration` (previa), `POST /design/migration/apply|rollback` (so navegador, `fromAppUi`). CLI:
  `node scripts/design-migrate.mjs <projeto> [--data-dir d] [--apply <hash> | --rollback <id>] [--keep-native|--take-legacy <id>]`
  (use `--data-dir` num ensaio). Sempre ensaie numa copia descartavel
- (historico, substituido no R1-B3) **Selecao de fonte sem duplicar**: registro ja presente no arquivo nativo nao e perguntado ao dk.py de novo. Todos migrados =
  dk.py nem e chamado (`sources.legacy.migrated`); parcial = os nao migrados ainda vem do dk.py (`source: legacy`); `nativeOnly`
  (`?nativeOnly=1` ou `SHIPYARD_DK_NATIVE_ONLY=1`) forca so o nativo e diz o que deixou de ler. `SHIPYARD_DK_FORBID_PYTHON=1` faz
  qualquer tentativa de subir Python falhar; `pythonAttempts` conta as tentativas (prova de que o caminho nativo nao usa Python)
- Paridade: `server/test/support/parity.ts` compara campo a campo o dk.py endurecido (`test/fixtures/dk`) com o nativo migrado;
  `designMigration.test.ts` (M0-M13) cobre id/termo/arquivo/conflito, CURRENT/MOVED/CHANGED/STALE/GONE, atestacao valida e
  caducada, worktree, revisao, rollback e modo so-nativo. Regras que **nao** mudam: legado compara palavra inteira (prefixo so em
  decisao nativa pura); `decision_state` de registro migrado nao sobe por atestacao (so `approval` sobe). Diferencas aceitas e
  medidas: `ref` de uma linha (`#L2-L2` vs `#L2`), trecho (6 vs 12 linhas), CSV externo `UNKNOWN`, `record_integration`

### Aposentadoria do dk.py (R1-B3)
- **Sem Python, sem fallback**: nenhum codigo de produto sobe Python para DK (`designRetire.test.ts` T14 varre `server/src`).
  `SHIPYARD_DK_FORBID_PYTHON`, `SHIPYARD_DK_NATIVE_ONLY`, `nativeOnly` e `pythonAttempts` deixaram de existir. A copia de
  `dk.py` em `test/fixtures/dk` so serve de **oraculo** da paridade (`test/support/parity.ts`); nao e produto
- **Evidencia externa** (`designSources.ts`): `@nome:chave` num registro cita um arquivo fora do repo. O repo so carrega o
  **nome**; onde ele aponta nesta maquina e configuracao explicita: `data/design-sources.json`
  (`{version:1, projects:{id:{nome:"<caminho absoluto>"}}}`) ou `SHIPYARD_DK_SOURCE_<NOME>`. Rotas
  `GET /design/sources` e `PUT /design/sources/:name` (so UI, `{path|null}`). So caminho absoluto local (UNC/relativo recusados);
  le-se apenas para fingerprint e para citar a linha da chave. Veredito: nao configurada ou ilegivel = UNKNOWN (nada verificado,
  nunca GONE); arquivo configurado inexistente = GONE; mesmo sha = CURRENT; sha diferente = CHANGED (linha ainda la) ou STALE.
  Em `revision` e sempre UNKNOWN/`unsupported`: arquivo de hoje nao julga historia. PNMG: `PNMG_ECO_CSV` do dk.py vira
  `SHIPYARD_DK_SOURCE_ECONOMY_CSV`
- **Identidade de caminho** (`pathIdentity.ts`, `canonicalPath`): realpath nativo + barras + minusculas no Windows, cache de 30 s.
  Nome curto 8.3, separadores e caixa dao **um** projeto/worktree; duas pastas de mesmo nome em pais diferentes continuam
  duas. `projectDiscovery.pathKey` e `designKnowledge.norm` usam essa funcao; a lista de worktrees do git continua sendo a
  unica autoridade do que pode ser examinado
- **Revisao historica**: so lê o arquivo nativo naquela revisao (`git show`); revisao desconhecida = `invalid`
  ("Unknown revision"); revisao sem manifesto = vazio + limitation, nada inferido da working tree
- **`record_integration`** (`fileIntegration` em designDecisions): `revision` | `local` (arquivo modificado/nao commitado) |
  `committed` (worktree de task) | `integrated` (commitado no checkout canonico) | `unknown`. Substitui a regra do dk.py,
  que fixava o nome de uma branch de um jogo
- Agentes: use o MCP `get_design_context` e `propose_design_decision`; nunca rode dk.py, nunca trate doc historico como aprovacao

### System Explorer (Projeto -> Sistemas -> Sistema)
- Aba **Systems** dentro do Explorer (`SystemsExplorer.tsx`, montada por `ExplorerHost`; "Files & symbols" e o
  Explorer antigo). Catalogo com busca/estado/flags e detalhe do sistema; abrir arquivo usa o Editor ao lado
  (`focusFile` no `ProjectExplorer` leva o Graphify ao no). Dados: `services/systemCatalog.ts`, rotas em `routes/systems.ts`
- **Identidade** (`data/systems/{projectId}.json`, `writeJsonAtomic` + mutex): so o que nao da para derivar —
  id estavel `sys-<slug>`, nome, resumo, responsabilidades, `status` (proposed|confirmed|dismissed|merged),
  `origin` (discovery|agent|user), proveniencia da confirmacao, **ancoras** (termos, arquivos, ids de decisao DK),
  relacoes declaradas, `seen` (chaves vistas) e `vanished`. Nada de membros, simbolos, arestas ou estado de DK
  gravados: tudo isso e derivado sob demanda (`resolveSystem`, cache 4 s, memo por checkout) para nunca ficar velho
- **Identidade nao e pasta/classe/documento/comunidade do Graphify**: e uma ancora semantica (termos + arquivos +
  decisoes). Renomear arquivo mantem o sistema (ancora de arquivo cai para o mesmo basename = `moved`); reanalisar o
  Graphify nao muda o id; relacao N:N vem de membros/termos compartilhados (`related`)
- **Autoridade**: fato = git, arestas Graphify EXTRACTED, registro DK; **hipotese** = agrupamento, arestas INFERRED,
  vizinhos ("possible participants"); **decisao** = confirmacao humana. Agente so **propoe** (`propose_system`, MCP):
  proposta contra sistema confirmado vira `suggestions` pendente, nunca edita. Confirmar/editar/mesclar/dividir so pela
  UI (`fromAppUi`, mesma ressalva do DK: `attested_local` nao prova pessoa). Nao existe tool MCP de confirmar
- Descoberta (`discover`) = candidatos por tokens de nome de arquivo (>=4 letras, sem `STOP`) + mencao em texto (>=3
  linhas); idempotente, nao duplica, estende o dono quando o agente propoe termos ja cobertos. Ruidosa de proposito:
  o humano confirma/corrige/divide/mescla
- **Manutencao derivada, sem watcher/cron/agente**: o catalogo so recalcula quando a aba esta aberta (poll 10 s) e
  em cache curto. Sinais: `changedSinceAnalysis` (mtime > inicio da analise; so no checkout canonico), `vanished`
  (arquivo/simbolo que sumiu desde o snapshot `seen`; so o canonico grava; "Acknowledge" limpa), `unresolvedAnchors`,
  decisoes novas do DK (reaparecem na consulta), projeto sem DK (`design.available=false`, nunca erro)
- **Worktree**: `?worktree=` muda o checkout examinado (membros por nome/texto, git, dirty, integracao); o grafo
  continua o do canonico e a UI/limitacoes dizem isso. Nunca reescreve o snapshot do canonico
- **V2**: Overview, Map, Rules & decisions, Implementation e Evidence agrupam responsabilidades, relacoes de
  gameplay, codigo e registros DK. Areas e relacoes propostas sao julgamentos persistidos, nao descobertas
  automaticas; facetas por nome sao inferencias. Graphify fornece simbolos e ligacoes tecnicas, nunca causalidade.
  Evidencia textual e reverificada no checkout: encontrar o trecho nao comprova a relacao nem aprovacao humana.
  Mudanca de nome detectada no diff Git contra HEAD pode ser seguida; renomeacoes ja commitadas com novo nome
  podem exigir atualizacao manual das ancoras. O grafo continua descrevendo o checkout canonico ate nova analise.
- Para outro projeto Godot, descubra candidatos e revise/proponha suas responsabilidades e evidencias; DK e
  opcional, nao copie dados de outro jogo. Adicione testes de semantica e manutencao em `server/test/systemsV2.test.ts`;
  rode `pnpm --filter shipyard-server test` (inclui `systems.test.ts` e os testes V2).
- O ID de projeto e compartilhado por tasks, sistemas, Graphify e integracoes. `data/project-identities.json`
  reserva o ID por caminho, inclusive depois da remocao; novos projetos usam hash do caminho e nao dependem da
  ordem. Na primeira inicializacao, IDs existentes sao preservados a partir de `projects.json`. IDs legados
  duplicados entre caminhos sao ambiguos: a inicializacao falha sem sobrescrever dados, para revisao manual.
  O importador de workspace remapeia os caminhos desse registro junto aos de settings e projects. Na nuvem,
  IDs recebidos so sao vinculados a caminhos sem outro dono; pastas candidatas ambiguas ficam pendentes.
- Reanalise Graphify real: `SHIPYARD_GRAPHIFY_PYTHON=<python do graphify-godot>` e
  `node --import tsx --test --test-force-exit test/graphifyIntegration.test.ts` em `server/`. O teste usa uma
  fixture descartavel e verifica reextracao, renomeacao, classificacao e evidencias; sem o interpretador configurado,
  ele e explicitamente pulado na suite normal. Nao executa o projeto Godot.
- **Conhecimento por checkout (R1-A2)**: `systemKnowledge.ts`. `reconcile(project, {worktree?, revision?})` (somente leitura; `GET /api/projects/:id/systems/knowledge`) compoe o `jabutistudio.systems.json` publicado na revisao examinada (`git show`) + catalogo local + evidencia relida naquele checkout. Estados: `published` | `local-change` | `diverged` | `unpublished-proposal` | `unavailable`; arquivo: present/modified/untracked/absent/invalid/incompatible. Divergencia nunca e resolvida sozinha: devolve publicado, arquivo de trabalho e local lado a lado. Com `revision` explicita nao le a working tree. `updatePortable` (`POST .../knowledge/update`, so UI) exige `expectedSha256` do arquivo, nunca cria o arquivo, nunca muda status e exige `takeLocal` para sobrescrever valor divergente; escrita tmp+rename. Nao depende de DK nem de Graphify
- **Publicar e recuperar (R1-A3)**: botao "Knowledge / Publish" no System Explorer (`KnowledgePanel.tsx`). Rotas: `GET .../systems/knowledge/plan` (previas de export, update e import; nada escreve), `POST .../knowledge/export` (so UI; nunca sobrescreve), `POST .../knowledge/update` (so UI; `expectedSha256` + `systemIds` + `takeLocal`), `POST .../knowledge/import` (so UI; exige o `expectedSha256` da previa). Previa e escrita usam o mesmo codigo (`planUpdate` e `classifyPortableImport`), entao o que a tela mostra e o que sera feito. Import e tudo-ou-nada: sistema com mesmo id e conteudo diferente (`changed`) ou mesmo nome/termos com outro id (`duplicate`) bloqueia, e nada e escolhido sozinho. Nada faz `git add/commit/merge/push`: publicar escreve o arquivo na working tree, o commit e do usuario. Escrita so no checkout do projeto; worktree e `revision` explicita sao somente leitura. A tela nao faz poll: o hash mostrado e o hash enviado; "Refresh" e explicito. Worktree mostra `file.integration` (igual/diferente do HEAD do checkout principal). Em dev (Vite 5421) as escritas de UI levam 403 por Origin diferente do Host: teste no app servido pelo server (`SHIPYARD_STATIC_DIR=client/dist`). Export aceita `systemIds` (candidatos de discovery nao revisados comecam desmarcados) e o update aceita `expectedLocal` (updatedAt local visto na previa; mudou = recusa). Teste: `server/test/systemPublish.test.ts` (clone em outra data dir/processo)
- Teste: `server/test/systems.test.ts` (fixture com git init, sem DK, worktree, idempotencia, vanished, MCP).
  **Nao hardcodar nomes/ids/caminhos de um jogo na logica geral** — so em fixtures

## Repositorio sem commits, erros de leitura e aba Versions (KNOWLEDGE-BOOTSTRAP)

- **Unborn nao e erro.** `isUnborn(root)` (`systemCatalog.ts`) = sem `HEAD^{commit}` mas com `symbolic-ref HEAD`. `reconcile`
  devolve `revision: {commit: null, unborn: true}`, `checkout.unborn`, branch via `symbolic-ref`, sistemas locais como
  `unpublished-proposal`; `catalog().checkout.integration` = "no commits yet". Revisao **explicita** inexistente continua erro.
- **Publicar exige commit raiz** (a identidade do arquivo e `gitRoots`): `portableGitRoot` lanca `UnbornRepoError`;
  `previewExport` devolve `needsFirstCommit`; arquivo ja existente num repo unborn fica `untracked` (nao `invalid`).
- **Primeiro commit** (`createFirstCommit`, `POST .../knowledge/first-commit`, so UI): um commit **vazio** (`--allow-empty`),
  sem staging, sem tocar arquivos nem catalogo; recusa se ja ha commits ou se ha algo no indice. O usuario pode preferir o
  proprio commit pelo Git panel.
- **Erro nunca vira lista vazia**: `readStore` so trata `ENOENT` como "sem sistemas"; JSON invalido/forma inesperada lanca
  (e nao sobrescreve); `catalog()` devolve `loadErrors[]` em vez de descartar sistemas; `GET /systems` responde 500 com a
  causa; o client mostra caixa de erro + Retry, nunca "No systems yet".
- **UI**: barra de contexto fixa no topo da aba Systems (branch/sha ou "no commits yet", checkout/worktree, "catalogo local,
  compartilhado") e abas **Systems | Versions**. "Versions" substituiu o botao do rodape ("Publish & recover"); la ficam
  publicar, comparar, recuperar e o primeiro commit, cada um dizendo o que escreve (arquivo do repo / so catalogo / Git).
- **Auditoria canonico x worktree**: `docs/proposals/knowledge-canonical-vs-worktree.md`. Resumo: o catalogo e unico por
  projeto e compartilhado por todos os checkouts; nao e branch-aware; tarefa/merge nao tocam Knowledge.
- Teste: `server/test/systemUnborn.test.ts` (U1-U8).

## Edicao humana de Systems (R3-KNOWLEDGE-UX)

- **Editor dedicado** (`EditSystemDialog.tsx`, 5 passos: Identity / Responsibilities / Members / Relations / Review). Nada grava antes do passo Review, que mostra o diff e uma caixa por item a confirmar; "Save changes" nao confirma nada. Reusa `PATCH /systems/:sid` (`fromAppUi`), com `Edit.setArea`, `Edit.dropSuggestion`, `upsertRelation`. Merge e Split sao dialogos proprios (`StructureDialogs.tsx`) com comparacao e previa; o sistema fundido fica como redirect.
- **Ask Claude/Codex** (`AskMenu.tsx`): ajuda contextual (explicar, sugerir responsabilidades, investigar relacao, propor classificacao, consequencias). Devolve proposta via MCP `propose_system`; o agente nunca confirma. Sem banco novo.
- **Leitura**: Overview edita a descricao no lugar; Map sem relacao declarada mostra a limitacao (nao desenha diagrama de nomes); Rules abre pela regra + impacto, evidencia tecnica em `<details>`; Evidence tem "Where each claim comes from" (observed / inferred / test reference / human, nunca fundidos).
- Conflitos continuam vindo so de `conflictsWith` das decisoes registradas; a tela nao detecta conflito novo. Descoberta e nominal (nomes de arquivo + mencao em texto). Relacao so e "demonstrated" com texto citado, nunca por nome parecido.
- Escritas de UI so funcionam no app servido pelo server (5420); no Vite 5421 levam 403 por Origin.

## Criar e editar Systems visualmente (R3-KNOWLEDGE-UX2)

- **Novo sistema** (`NewSystemDialog.tsx`, botao "New system" na navegacao): Manual / From the project / Ask an agent. Manual e From-project abrem o **mesmo** `EditSystemDialog` em modo `draft` (cria com `POST /systems` + `createOnly`, depois a mesma sequencia de PATCH de uma edicao). O agente recebe um brief para `propose_system` e a resposta volta como proposta comum. Nada e confirmado por criar.
- **Quick edit**: `Focus` = identity | responsibility | component | relation, abre o mesmo dialogo so com a peca (lapis nas responsabilidades, Edit no componente, "Edit this relation" no inspetor do Map).
- **Modelo**: componente tem `responsibilities` e `planned` (planejado = sem arquivos esperados); sistema tem `planned`. Entidade, mecanica e sistema gestor sao objetos separados. Mudar um componente confirmado o devolve a `proposed`.
- **Regras de relacao** (`RELATION_RULES` em `systemSemantics.ts`, espelho em `client/src/lib/relationRules.ts`; manter os dois iguais): produces/consumes so tem entidade como alvo; stores: alvo entidade; modifies/controls: so ator na origem; grupos gameplay/structure/implementation. Endpoint de tipo desconhecido nao e bloqueado. `review` valida tudo antes de gravar (recusa = nada gravado, 400); proposta de agente com relacao invalida e gravada sem ela. Relacao entre sistemas usa `sys:<id>[/<area>]`. `replaceRelation` edita no lugar (mesmo sentido mantem status; sentido diferente volta a proposed). Ids de relacao da view (`owner:id`) sao aceitos pelo server.
- **Review**: 4 blocos (mudancas / propostas pendentes / escolha de confirmacao, tudo desmarcado / previa do resultado). "Save changes" ignora marcas. Confirmar classificacao nao aprova decisao de design.
- **Editor de relacao (RelationForm) e edicao rapida**: o estado vive em `client/src/lib/relationForm.ts` (puro, testado em `server/test/relationEditor.test.ts`). O operador (`kind`) so muda por `setOperator`; nao existe "grupo" como estado (as abas Gameplay/Structure/Implementation foram removidas: `pickGroup` re-escolhia o primeiro operador do grupo ao voltar, `modifies` -> `produces`). Operadores aparecem num unico `<select>` com `optgroup`. "Alterado" e sempre derivado da comparacao com o persistido (`relSig`), e `relationEdits` planeja as gravacoes (sem mudanca = nenhuma gravacao). Na edicao rapida o formulario e `live` (sem botoes proprios) e o rodape tem um unico **Save**; confirmar e uma caixa explicita ("Also confirm it") que troca o botao para **Save and confirm**, e so aparece se o item nao estiver ja confirmado. Salvar nunca confirma. A identidade do sistema so e regravada se mudou.
- **Members**: classes confirmed / declared / candidate-by-code / candidate-by-name, com "why", abrir no editor e Pin/Unpin. Arquivos vem do indice de arquivos do projeto (mesmo da busca do Explorer), nao de uma arvore.
- Testes: .

## Relacoes de design sem codigo (R3-KNOWLEDGE-UX RC2)

- **Existir nao depende de evidencia.** O mapa antigo escondia basis `candidate` (= sem evidencia) atras de um checkbox; relacao puramente conceitual ficava sem aresta e sem caminho ate o editor. Agora `buildSystemMap` desenha **toda** relacao declarada (evidencia so muda o estilo: pontilhada = design only, tracejada = ponteiro de arquivo, solida = texto achado). O checkbox "candidates" foi removido.
- **Dois eixos independentes** (`client/src/lib/relationState.ts`, `RelationPills`): *design* = proposed | confirmed (sua classificacao) e *codigo* = design only | code pointer | code matched | code stale. Confirmar nao implica codigo; codigo achado nao implica confirmacao.
- **Entrada direta**: lista "Design relations" abaixo do mapa (`RelationList.tsx`) e botao Edit na aba Evidence abrem o editor rapido sem passar pelo grafo.
- **Contrato de salvar (igual no rapido e em etapas)**: Save / "Save changes" grava como proposta; **qualquer mudanca** de direcao, nota ou evidencia de relacao confirmada a devolve a proposed (server: `replaceRelation` so mantem o status se o conteudo for identico). Confirmar e explicito ("Also confirm it" / ticks do Review / Accept) e usa um unico texto (`CONFIRM_MEANING`): registro local de que voce aceita a classificacao; **nao** e aprovacao de decisao de design (essa e o ledger `attested_local` do DK). Cancelar nunca grava.
- Testes: `server/test/relationEditor.test.ts` (6-9).

## Consolidacao UX (R3-KNOWLEDGE-UX3)

- **Estado vazio** (`EmptyDesign` em `SystemsExplorer.tsx`): projeto sem sistemas abre "Design the game before the code" (descrever / pedir a um agente / achar no codigo, nessa ordem).
- **Agente**: todo envio da aba Systems usa `openAgentSession` (`terminalDispatch.ts`). "Sessao aberta" nao e proposta: `NewSystemDialog` chama `onSent`, a sidebar mostra "Waiting for its proposal…" (poll 3 s) e so a chegada de um sistema `origin: agent` novo vira "proposed", com selecao automatica. O gate de MCP pronto e do KNOWLEDGE-MCP-SESSION-01.
- **Editor**: componente sem nome tem erro inline e foco automatico; "Add component" reabre o sem nome em vez de criar outro; Review lista "Fix" por problema; sistema `planned` sem arquivos pula Members ("optional"). `save` espera o refetch antes de fechar/avisar.
- **Termo**: "project checkout" (pasta registrada, qualquer branch) vs "worktree". Nunca "main" como nome de branch. A proposta de UI canonica esta em `docs/proposals/knowledge-canonical-ui.md` (nao implementada).

## Catalogos distintos para o mesmo projeto (CATALOG-SOURCE)

- **Causa do "No systems yet" no Electron real**: o ID do projeto vem do caminho (`project-identities.json`), entao o app instalado
  (`%APPDATA%/JabutiStudio/data`, porta 5430, e o que o `.mcp.json` dos jogos aponta) e o `pnpm dev:electron` (`<repo>/data`,
  porta 5420, `isDev = !app.isPackaged`) usam o **mesmo id e o mesmo nome de arquivo** em pastas diferentes. Sistemas propostos
  por MCP na 5430 nao aparecem na 5420. O primeiro commit nao altera a identidade (testado, C2).
- Nada e escolhido, copiado ou mesclado sozinho. `catalogSources.ts` so le: `GET /projects/:id/systems/catalog-source` devolve
  identidade, data dir ativo (e como foi escolhido), arquivo, sha256, contagem, ultima leitura e os catalogos **irmaos** conhecidos
  (`<repo>/data`, data dir do Electron instalado, `SHIPYARD_SIBLING_DATA_DIRS`; nunca caminho arbitrario) com relacao
  identical | addable | conflicting | unreadable.
- A UI mostra um aviso na aba Systems quando existe irmao com sistemas que o ativo nao tem; o estado vazio deixa de dizer que nao ha
  nada. **Versions -> Technical details** lista identidade, contexto Git, data dir, catalogo, sistemas carregados, ultima leitura e irmaos.
- Migracao: `POST .../catalog-source/import` (so UI). Add-only, exige o sha256 visto na previa da origem e do destino, recusa tudo
  se qualquer id diverge ou duplica nome/termo, faz backup do arquivo ativo e grava manifesto em
  `<data>/catalog-backups/<projectId>/`. A origem nunca e alterada. Teste: `server/test/catalogSources.test.ts` (nao esta no script
  `test` de package.json por la haver edicao alheia pendente; rode com `node --import tsx --test test/catalogSources.test.ts`).

## propose_system: alvo explicito e tres operacoes (MCP-TARGET)

- **Causa provada**: `systemCatalog.propose` (descoberta/UI) acha o "dono" por `id === sys-<nome>` **ou por qualquer termo em comum**. A tool MCP passava por ele, entao uma proposta "Character Locomotion" com o termo `traversal` foi gravada em "Building Traversal". Regressao: `server/test/systemProposeTarget.test.ts`.
- O MCP agora usa `agentPropose` e **nunca escolhe sistema por nome ou termo**. `operation`: `create` (novo; sem `systemId`; erro `already-exists` se o nome ja existe; `similar` so informa), `extend` (so soma ancoras/responsabilidades/areas/relacoes; nunca sobrescreve o resumo; contra sistema confirmado vira `suggestion`), `correct` (substitui resumo/responsabilidades e remove conteudo via `remove.{terms,files,decisions,related,responsibilities,areas,relations}`; recusa sistema confirmado e o que uma pessoa escreveu: `origin: user`, itens `confirmed`). `extend`/`correct` exigem `systemId` exato; id desconhecido = erro `not-found` e **nada e gravado**. Sem `operation`: com `systemId` = extend, sem = create.
- Prompts (`terminalDispatch.ts`: `systemTargetRules`, `systemBasisKind`): todo pedido por sistema leva o id exato e a base (`code-derived` = candidato agrupado por nomes de arquivo, `design-first` = concebido antes do codigo; falta de codigo nao prova erro).

## Resolver dois catalogos (CATALOG-RESOLVE)

- **Diagnostico real** (IncrementalStairs): `%APPDATA%/JabutiStudio/data` e `<repo>/data` tinham os mesmos 4 ids; 1 identico e 3 (`momentum`, `building-traversal`, `pdi-perk-progression`) com conteudo diferente. O import antigo era add-only e **bloqueava tudo** num conflito, sem saida: o aviso nunca saia (nem era "importacao" nem "troca de catalogo": nada era gravado).
- `compareSystems` ignora `updatedAt/createdAt`: mesmo conteudo = `identical`, nunca conflito. Linhas: identical | only-here | only-there | different (campo a campo) | duplicate (nome/termo igual sob outro id).
- `GET .../catalog-source/compare?fromDir=` (leitura) e `POST .../catalog-source/resolve` (so UI): uma escolha por conflito (`keep-active` | `take-other` | `keep-both` = copia `<id>-other` como proposed). Tudo ou nada; escolha faltando = 409 e nada gravado. Nunca mescla. Backup do arquivo ativo + manifesto (`discardedActiveVersions`, `declinedOtherVersions`) em `<data>/catalog-backups/<projectId>/`; o outro catalogo nunca e escrito.
- A decisao fica em `<data>/catalog-backups/resolutions.json` presa ao sha256 do arquivo do outro catalogo: relacao `resolved` (sem aviso) ate esse arquivo mudar. A UI (`CatalogResolveDialog`) rotula "Installed app" / "Dev checkout" e diz qual esta ativo. Teste: `server/test/catalogResolve.test.ts` (nao esta no script `test` por edicao alheia pendente em package.json).
