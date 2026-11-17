// One-off seeding of the PNMG Húmus pilot as an AGENT PROPOSAL (never confirmed). Evidence needles are exact
// text that exists in the checkout; the catalog re-verifies them on every read.
import * as svc from './src/services/systemCatalog.ts'

const ev = (path: string, needle: string, note?: string) => ({ path, needle, ...(note ? { note } : {}) })
const CH = 'scripts/CollectorHand.gd'
const FG = 'world/FertilityGrid.gd'
const FB = 'scripts/FruitingBodyCycle.gd'
const BT = 'scripts/FertilizerBeetleCoordinator.gd'
const PR = 'scripts/HumusEconomyParams.gd'

const res = await svc.propose('repo', {
  name: 'Húmus',
  kind: 'system',
  summary: 'Matéria orgânica coletada pela mão e pelo besouro vira Húmus: é guardada numa reserva, gasta para fertilizar o solo, amadurecer corpos de frutificação e gerar esporos, e é modulada por perks.',
  responsibilities: [
    'Captar matéria (torrões) e transformá-la em Húmus',
    'Guardar Húmus em reservas (besouro, corpo)',
    'Gastar Húmus/matéria em fertilidade, maturação e esporos',
    'Parâmetros econômicos provisórios centralizados',
    'Telemetria dos fluxos reais',
  ],
  areas: [
    { id: 'matter-acquisition', name: 'Matter acquisition', kind: 'mechanic', summary: 'A mão captura torrões de húmus e carrega a matéria.', files: [CH],
      evidence: [ev(CH, 'func _on_clod_captured(matter: float, clod: HumusClod)', 'captura de torrão')] },
    { id: 'reserve-storage', name: 'Reserve & storage', kind: 'subsystem', summary: 'O besouro fertilizador mantém uma reserva corporal de Húmus.', files: [BT],
      evidence: [ev(BT, 'var reserve_humus := 0', 'reserva do besouro'), ev(FB, 'humus_reserve = maxf(0.0, humus_reserve - first_maturation_humus_cost)', 'reserva do corpo')] },
    { id: 'fertility', name: 'Fertility', kind: 'mechanic', summary: 'Matéria efetiva sobe o nível de fertilidade do solo (estágios 20/60/180).', files: [FG],
      evidence: [ev(FG, 'const UPGRADE_COST_BASE: int = EconomyParams.SOIL_STAGE_COSTS[0]', 'custo de estágio de solo')] },
    { id: 'body-maturation', name: 'Body maturation', kind: 'mechanic', summary: 'A primeira maturação de um corpo de frutificação consome Húmus da reserva.', files: [FB],
      evidence: [ev(FB, 'humus_reserve = maxf(0.0, humus_reserve - first_maturation_humus_cost)', 'desconta o custo da primeira maturação'),
        ev(PR, 'const FIRST_MATURATION_MATTER := 1000.0', 'valor implementado')] },
    { id: 'sporulation', name: 'Sporulation', kind: 'mechanic', summary: 'Esporos extras custam Húmus por esporo.', files: [FB],
      evidence: [ev(PR, 'const SPORE_EXTRA_HUMUS_COST := 50.0', 'custo por esporo extra'), ev(FB, '@export var spore_humus_cost := EconomyParams.SPORE_EXTRA_HUMUS_COST')] },
    { id: 'perks-modifiers', name: 'Perks & modifiers', kind: 'subsystem', summary: 'Perks alteram o valor do torrão e o custo de esporos.', files: ['scripts/PerkStats.gd'],
      evidence: [ev('scripts/PerkStats.gd', '&"humus.clod_value"', 'modificador do valor do torrão'), ev('scripts/PerkStats.gd', '&"body.spore_cost_mult"', 'modificador do custo de esporo')] },
    { id: 'economy-params', name: 'Economy parameters', kind: 'subsystem', summary: 'Constantes econômicas provisórias do Húmus, num só arquivo.', files: [PR],
      evidence: [ev(PR, 'const SOIL_STAGE_COSTS := [20, 60, 180]')] },
    { id: 'telemetry', name: 'Telemetry', kind: 'subsystem', summary: 'Liga os fluxos reais de matéria/Húmus à telemetria de balanceamento.', files: ['scripts/telemetry/HumusFlowAdapter.gd'],
      evidence: [ev('scripts/telemetry/HumusFlowAdapter.gd', 'class_name HumusFlowAdapter')] },
  ],
  relations: [
    { kind: 'produces', from: 'area:matter-acquisition', to: 'ent:Húmus (matéria coletada)', note: 'A captura de um torrão soma a matéria carregada.', evidence: [ev(CH, 'func _on_clod_captured(matter: float, clod: HumusClod)')] },
    { kind: 'stores', from: 'area:reserve-storage', to: 'ent:Húmus', note: 'Besouro e corpos guardam Húmus em reservas.', evidence: [ev(BT, 'var reserve_humus := 0')] },
    { kind: 'consumes', from: 'sys:sys-fertility', to: 'area:matter-acquisition', note: 'Subir o estágio do solo gasta matéria efetiva.', evidence: [ev(FG, 'const UPGRADE_COST_BASE: int = EconomyParams.SOIL_STAGE_COSTS[0]')] },
    { kind: 'consumes', from: 'area:body-maturation', to: 'area:reserve-storage', note: 'A primeira maturação desconta Húmus da reserva do corpo.', evidence: [ev(FB, 'humus_reserve = maxf(0.0, humus_reserve - first_maturation_humus_cost)')] },
    { kind: 'consumes', from: 'area:sporulation', to: 'area:reserve-storage', note: 'Esporo extra custa Húmus.', evidence: [ev(PR, 'const SPORE_EXTRA_HUMUS_COST := 50.0')] },
    { kind: 'modifies', from: 'area:perks-modifiers', to: 'area:matter-acquisition', note: 'Perk altera o valor do torrão.', evidence: [ev('scripts/PerkStats.gd', '&"humus.clod_value"')] },
    { kind: 'modifies', from: 'area:perks-modifiers', to: 'area:sporulation', note: 'Perk reduz o custo de esporo extra.', evidence: [ev('scripts/PerkStats.gd', '&"body.spore_cost_mult"')] },
    { kind: 'implemented_by', from: 'area:economy-params', to: 'self', note: 'Constantes lidas por fertilidade, maturação e esporos.', evidence: [ev(PR, 'const FIRST_MATURATION_MATTER := 1000.0')] },
  ],
}, 'agent')
console.log(JSON.stringify(res, null, 1).slice(0, 600))
