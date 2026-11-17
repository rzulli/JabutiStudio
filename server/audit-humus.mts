const svc = await import('./src/services/systemCatalog.js')
const pd = await import('./src/services/projectDiscovery.js')
const p:any = {id:'repo', path:'C:/dev/GAMEDEV_V2/PNMG/repo'}
const v:any = await svc.resolveSystem(p as any, process.argv[2]||'sys-humus')
if (v.error) { console.log(v); process.exit(1) }
console.log(JSON.stringify({checkout:v.checkout, nMembers:v.members.length, weaker:v.weakerMembers,
 byRole:Object.fromEntries(['code','scene','resource','test'].map(r=>[r,v.members.filter((m:any)=>m.role===r).length])),
 members:v.members.map((m:any)=>`${m.role} ${m.score} ${m.confidence} ${m.path} [${m.symbols.length}]`),
 neighbors:v.neighbors.map((n:any)=>`${n.path} ${n.relation} x${n.edges} ${n.confidence}`),
 decisions:v.design.decisions.map((d:any)=>[d.id,d.relevance,d.decisionState,d.evidenceStatus,d.implementation,d.evidence.map((e:any)=>e.type+' '+e.ref+' '+e.freshness)]),
 conflicts:v.design.conflicts, related:v.related.map((r:any)=>r.id+':'+r.shared.length), tasks:v.tasks.length},null,1))
process.exit(0)
