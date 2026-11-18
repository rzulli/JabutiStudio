# Execucao Godot contextual (RC1)

Do Editor e do Review de uma task, abre o editor Godot, joga o jogo e roda cenas/testes pelo **Godot Agent Harness
existente** (`runner/godot-harness.ps1`), no checkout certo, com proveniencia. Nao ha segundo Harness, segundo gerenciador
de worktrees nem banco paralelo de resultados.

## Auditoria (antes do RC1)
- Nao havia execucao Godot; so Graphify (explorer) e suporte a texto. Reaproveitado: `worktreeService`,
  `worktreeLinks.withLink`, `worktreeInventory.findRegistered`, `gitService`, `pathIdentity.canonicalPath`,
  `worktreeClose.isInside`, `fromAppUi` (routes/design.ts), `projectDiscovery`, `taskStore`.
- **Divergencia conhecida**: o Editor/arquivos (`routes/files.ts`) sempre usam `project.path` (checkout principal) e o
  `EditorPanel` nao tem conceito de task; agentes rodam na worktree via `ensureTaskWorktree` (que agora recusa, em vez de cair no
  `project.path`. O contexto de execucao **nao** faz esse fallback.

## Arquitetura (server/src/services/godot/)
| Arquivo | Papel |
|---|---|
| `context.ts` | `resolveContext`: projectId + taskId? + `checkout` (`main`\|`task`) + file? -> `ExecutionContext` (checkout, branch, sha, dirty, `reproducibleFromSha`, `sameAsEditorCheckout`). Nenhuma rota aceita diretorio. Recusas explicitas com `options` (ex.: "rodar no checkout principal" so por escolha visivel) |
| `classify.ts` | cena / cena de teste (`tests/`) / script de teste / script de gameplay; `.gd` nunca executa; "relacionado" so se uma cena o anexa por `ext_resource` (mesmo nome = sugestao) |
| `harness.ts` | localiza o Harness (setting `godotHarnessDir` -> env `GODOT_HARNESS_DIR` -> default), `doctor`, `run` via `pwsh` (array de args, sem shell), le `receipt.json`; `deriveVerdict` |
| `runs.ts` | indice de proveniencia `data/godot-runs/<projectId>.json` (nunca copia receipts), `openInGodot`, `playGame`, `startGodotRun` (uma run ativa por checkout), `cancel`, `listTestScenes` |
| `instances.ts` | janelas Godot GUI lancadas por este servidor (editor/play) por checkout: repetir a acao e recusado (`already-running`); sessoes de terminal no mesmo checkout geram avisos |

Rotas (`routes/godot.ts`): leitura aberta (`status`, `context`, `runs`, `runs/:id`, `runs/:id/evidence`); **`open`, `play`,
`runs` (POST) e `cancel` so do navegador** (403 senao). Nada roda ao abrir arquivo/Review.

## Semantica
- **Open Editor**: `godot --path <checkout> --editor [cena]` desacoplado; perfil real do usuario (o `editor` do Harness usa
  APPDATA isolado). **Play Game**: `godot --path <checkout>` (`run/main_scene` do `project.godot` do proprio checkout;
  sem ele, 409 `no-main-scene`). Play **nao e run do Harness**: sem receipt, sem asserts, nunca PASS nem aceite.
- **Run Scene/Test**: Harness `run -Mode HEADLESS`. O veredito separa quatro dimensoes: execucao concluida, asserts
  verificados, evidencia visual, validacao humana (sempre PENDING). PASS exige receipt PASS + marker + exit 0.
- Contexto da task: worktree da task se existir; **Direct checkout** (sem worktree) usa o checkout do projeto *declarado*
  (`checkout: 'main'` + `taskId`), rotulado "Direct checkout". Worktree sumida => recusa, nunca fallback silencioso.
- Avisos antes/ao lancar: alteracoes nao commitadas (o commit nao reproduz o que roda), agente ainda trabalhando no
  checkout, CLI que nao reporta estado, checkout compartilhado com outra task.
- Run de outro checkout nunca e apresentada como evidencia da versao atual: o registro guarda checkout/branch/sha/dirty e
  a UI mostra "Re-run on <contexto atual>" explicitamente.

## UI
`components/editor/GodotActions.tsx` (barra do Editor para `.tscn`/`.gd`; seletor de checkout), `GodotResults.tsx`
(dialog de runs/recibos/evidencias, reaproveitavel por uma futura aba Testing via `hooks/useGodot.ts`),
`components/tasks/TaskGodotReview.tsx` (Open Editor / Play Game / Run Test / View Results no Review),
`DirectDeliveryPicker.tsx` (atribuicao de entrega direta; ver `lifecycle-worktrees.md`).

## Testing (RC2)
Aba `Testing` do Workspace (`components/testing/TestingPanel.tsx`), mesma fonte do Editor e do Review: contexto
(`/godot/context`), runs (`/godot/runs`, sem arquivo = projeto inteiro, com `taskId` = task), recibo (`RunDetail` de
`GodotResults.tsx`, exportado). Nada novo no servidor alem de `testScripts` no `/godot/context`: `.gd` em `tests/` que
nenhuma cena de teste anexa (`listUnattachedTestScripts`), so como candidato, nunca executavel. "Run All" nao existe
(o projeto nao declara suite). "Open in Editor" so no checkout principal (o Editor so le o checkout do projeto).
Seletor de checkout proprio da aba (`shipyard:testing-checkout:<id>`), independente do da barra do Editor.

## Limitacoes
- Cena que nao imprime o marker nao pode dar PASS (NO_ASSERTIONS/FAIL/TIMEOUT). `project.godot` precisa estar na raiz.
- Reiniciar o servidor perde o rastreio de runs vivas (o receipt ainda e lido; senao NO_RECEIPT) e das janelas GUI.
- Godot aberto a mao nao e visto pelo guard de instancias.
- No dev server (Vite 5421) escritas da UI podem dar 403 por origem; use Electron/porta servida.
- Verificacao manual Electron: ver relatorio da entrega do RC1.
- Testing mostra so as ultimas 30 runs do projeto: "ultimo resultado" por teste sai dessa janela.
- Explorer ainda nao oferece acoes Godot (RC2 nao integrou o Explorer).
