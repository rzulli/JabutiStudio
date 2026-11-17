import { z } from 'zod';
import { RELATION_KINDS } from './systemSemantics.js';
import type { StoredSystem } from './systemCatalog.js';

const text = z.string();
const id = text.min(1);
const strings = z.array(text);
const origin = z.enum(['discovery', 'agent', 'user']);
const status = z.enum(['proposed', 'confirmed']);
// Anchors can include a symbol after #, but must never escape the checkout.
const path = text.refine(p => {
  const file = p.split('#')[0];
  return !!file && !file.includes('\\') && !file.startsWith('/') && !/^[a-z]:/i.test(file)
    && file.split('/').every(part => !!part && part !== '.' && part !== '..');
}, 'Expected a relative checkout path');
const evidence = z.object({ path, needle: text.optional(), note: text.optional() }).strict();
const anchors = z.object({ terms: strings, files: z.array(path), decisions: strings }).strict();
const area = z.object({
  id, name: text, kind: z.enum(['subsystem', 'mechanic', 'entity']), summary: text, status, origin,
  anchors: z.object({ files: z.array(path), terms: strings }).strict(), evidence: z.array(evidence),
  responsibilities: strings.optional(), planned: z.boolean().optional(),
}).strict();
const relation = z.object({
  id, kind: z.enum(RELATION_KINDS), from: id, to: id, note: text.optional(), status, origin, evidence: z.array(evidence),
}).strict();
const suggestion = z.object({
  at: text, origin, summary: text.optional(), anchors, areas: z.number().optional(), relations: z.number().optional(),
  payload: z.object({ areas: z.array(area), relations: z.array(relation) }).strict().optional(),
}).strict();
const system = z.object({
  id, name: text, summary: text, responsibilities: strings, status: z.enum(['proposed', 'confirmed', 'dismissed', 'merged']),
  origin, createdAt: text, updatedAt: text, confirmedAt: text.optional(), confirmedVia: z.literal('ui-request').optional(),
  mergedInto: id.optional(), mergedFrom: z.array(id).optional(), anchors,
  kind: z.enum(['system', 'subsystem', 'mechanic', 'entity']).optional(), planned: z.boolean().optional(),
  areas: z.array(area).optional(), relations: z.array(relation).optional(), related: z.array(id), suggestions: z.array(suggestion).optional(),
}).strict();

export const portableSchema = z.object({
  version: z.literal(1), gitRoots: z.array(z.string().regex(/^[a-f0-9]{40,64}$/)).min(1), systems: z.array(system),
}).strict().superRefine((doc, ctx) => {
  const unique = (ids: string[], label: string) => {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${label} ID` });
  };
  unique(doc.systems.map(s => s.id), 'system');
  for (const s of doc.systems) {
    unique((s.areas ?? []).map(a => a.id), 'area');
    unique((s.relations ?? []).map(r => r.id), 'relation');
  }
  // Refuse to export operational paths accidentally embedded in free text, too.
  const scan = (v: unknown): void => {
    if (typeof v === 'string' && /(?:^|[\s"'=(])(?:[a-z]:[\\/]|\\\\|\/[^\s/])/i.test(v))
      ctx.addIssue({ code: 'custom', message: 'Absolute path in portable catalog' });
    else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  scan(doc.systems);
});

/** Whitelist durable fields; local membership snapshots and future cache fields stay local. */
export function portableSystem(s: StoredSystem): z.infer<typeof system> {
  const { id, name, summary, responsibilities, status, origin, createdAt, updatedAt, confirmedAt, confirmedVia,
    mergedInto, mergedFrom, anchors, kind, areas, relations, related, suggestions } = s;
  return system.parse({ id, name, summary, responsibilities, status, origin, createdAt, updatedAt, confirmedAt,
    confirmedVia, mergedInto, mergedFrom, anchors, kind, areas, relations, related, suggestions });
}
