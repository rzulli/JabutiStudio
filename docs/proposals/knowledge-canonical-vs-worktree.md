# Diagnostico: Knowledge canonico x worktree (auditoria, nada de modelo novo implementado)

Status: **diagnostico + plano minimo**. Todas as respostas abaixo foram verificadas no codigo e reproduzidas
numa copia descartavel do bootstrap real do IncrementalStairs (repo `git init` sem commits, quatro sistemas
propostos por MCP). Nenhum dado real foi tocado.

## 0. Causa do "Revision not found: HEAD" e da lista vazia

| Sintoma | Causa real |
|---|---|
| `Revision not found: HEAD` na tela Publish | `systemKnowledge.reconcile` resolvia `HEAD^{commit}` antes de qualquer outra coisa. Num repo unborn nao existe HEAD, e a funcao devolvia erro 400 em vez de descrever o estado. O catalogo local nunca era lido. |
| Publicar/recuperar impossivel | `portableGitRoot` usa `rev-list --max-parents=0 HEAD`: a identidade do arquivo portatil **e o commit raiz**. Sem commit nao ha identidade; a mensagem era "requires a complete Git history". |
| "No systems yet" | Nao e consequencia do HEAD: `GET /systems` (catalogo) funciona em repo unborn (reproduzido: 4 sistemas). A lista vazia vem de dois defeitos independentes que **transformam erro em vazio**: (a) o client tratava query com erro como `systems = []` e mostrava "No systems yet"; (b) `catalog()` descartava em silencio qualquer sistema cujo `resolveSystem` devolvia erro; (c) `readStore` tratava arquivo corrompido como "primeiro uso" e devolvia catalogo vazio, e o **proximo `mutate` o sobrescreveria** (perda de dados). |
| Onde estao os dados | `<SHIPYARD_DATA_DIR>/systems/incrementalstairs-3fb30bd7f602.json`. No Electron: `%APPDATA%/JabutiStudio/data/systems/`. Os quatro sistemas estavam intactos la (`sys-momentum`, `sys-character-locomotion`, `sys-building-traversal`, `sys-pdi-perk-progression`, todos `proposed`/`agent`). O `data/` do repositorio de dev tem um arquivo de 35 B (`systems: []`) para esse id: outro data dir, nao o do app. |

## 1. Auditoria (7 perguntas)

1. **Onde sao persistidos.** Catalogo local: `data/systems/{projectId}.json` (fora do repo, `writeJsonAtomic` + mutex,
   cache por mtime). Publicado: `jabutistudio.systems.json` na raiz do checkout do projeto (versionavel, so por acao
   explicita). Decisoes de design: `jabutistudio.decisions.json`. Aprovacoes: ledger `data/design-approvals/`.
2. **Identidade do catalogo.** So pelo `projectId` (`data/project-identities.json`: caminho -> id, hash do caminho).
   Nao ha branch, worktree nem sha na chave.
3. **Sessao de worktree compartilha o catalogo?** **Sim, totalmente.** `propose_system` recebe so `projectId`; nao
   recebe `taskId` nem caminho. `catalog/resolveSystem(project, id, worktree)` usa `worktree` apenas para escolher
   **onde ler evidencia** (arquivos, git, dirty); o store e o mesmo. Um worktree registrado como projeto proprio
   teria outro id e outro catalogo (identidade por caminho), mas o fluxo de tarefas usa o id do projeto principal.
4. **Mudancas do agente numa worktree afetam outras sessoes na hora?** **Sim.** `propose`/`review` gravam no store
   unico e limpam o cache de views; qualquer sessao (de outra branch) ve a proposta no proximo poll (10 s).
   Nao existe isolamento nem marca de origem de branch no registro.
5. **O que Publish exporta.** `exportPortable`: sistemas do catalogo local (todos ou os marcados) como
   `jabutistudio.systems.json` com `gitRoots` = commits raiz; sem aprovacoes locais, sem caches, sem caminhos
   absolutos. Recusa sobrescrever (`link`), recusa symlink, exige historico completo. Nao faz add/commit/merge/push.
   `updatePortable` atualiza o arquivo existente com `expectedSha256` e exige `takeLocal` para trocar valor divergente.
6. **Como Recover funciona.** `importPortable`: le o arquivo da **working tree do checkout do projeto** (nao de um
   commit), confere `gitRoots`, caminhos e `expectedSha256` da previa; e **tudo-ou-nada**: qualquer sistema `changed`
   (mesmo id, conteudo diferente) ou `duplicate` (mesmo nome/termos, outro id) bloqueia e nada e importado. So
   **adiciona** sistemas novos; nunca altera um existente. Proveniencia: preserva `origin`, `confirmedAt` e
   `confirmedVia` escritos no arquivo; proposta continua proposta. Nao ha merge nem escolha de lado.
7. **Integracao tarefa/merge x Knowledge.** **Nenhuma.** `taskLifecycle`, `worktreeClose` e `worktreeLinks` nao
   referenciam catalogo nem arquivo portatil. Integrar uma tarefa nao publica, importa nem compara Knowledge; o
   `file.integration` do Versions so compara o blob commitado do worktree com o HEAD do checkout principal.

**Conclusao:** o modelo atual **nao e branch-aware**. Ha um unico catalogo mutavel por projeto, compartilhado por todos
os checkouts, e um arquivo versionavel opcional que e so exportacao manual. "Canonico" hoje nao e um estado: e a
copia local, mais o arquivo se alguem o commitou.

## 2. O que Publish e Recover fazem hoje (e a UI agora diz)

| Acao | Escreve | Nao escreve |
|---|---|---|
| Publish (export/update) | `jabutistudio.systems.json` na working tree do checkout do projeto (nao commitado) | catalogo local, Git, status, aprovacao |
| Recover (import) | catalogo local (so sistemas novos) | repo, arquivos versionados |
| Primeiro commit (novo) | **um commit vazio** no Git | arquivos, indice, catalogo |

Publicar nunca aprova nem confirma; confirmar nunca escreve o arquivo.

## 3. O que falta para separar canonico de worktree com seguranca

Direcao desejada: canonico = estado integrado e versionado; worktree = mudanca em desenvolvimento com referencia ao
canonico e diferencas identificaveis; `proposed/confirmed` ortogonal a origem.

Plano minimo, cada passo entregavel sozinho e reaproveitando `systemKnowledge.reconcile` e o store atual:

1. **Marcar a origem de cada escrita** (menor mudanca): `propose`/`review` aceitam `taskId`/`worktree` opcional e o
   registro guarda `scope: { worktree, branch, baseSha }` (so local; nao entra no arquivo portatil ate a politica do
   passo 3). MCP passa o `taskId` que ja conhece (`get_system` ja resolve `task?.worktreePath`). Sem scope =
   canonico, como hoje. Nada de segundo banco: o mesmo `data/systems/{id}.json`.
2. **Mostrar diferencas por contexto**: `reconcile` ja compara publicado(revisao) x arquivo x local. Com o scope, a
   lista filtra "canonico" (sem scope ou integrado) x "em worktree X". Sem calculo novo.
3. **Politica explicita de promocao** (decisao de produto, nao automatica): ao `INTEGRATED` de uma tarefa a UI
   **oferece** "Publicar os sistemas desta tarefa" (previa do `planUpdate`); nunca promove sozinha. Promover = tirar o
   scope depois que o arquivo foi commitado/mergeado no alvo.
4. **Recuperacao por revisao**: `importPortable` ler de uma revisao (`git show`) em vez da working tree, para
   recuperar o canonico mesmo com arquivo editado.

Decisoes de produto pendentes: (a) o que vale como canonico (branch do checkout do projeto vs campo
`canonicalBranch`); (b) proposta de worktree descartada ao fechar a tarefa ou preservada como local; (c) se
Recover pode atualizar (hoje so adiciona).

Nada disso foi implementado: exigiria mudar o contrato de gravacao do catalogo (`propose`, MCP, `portableSystem`).
