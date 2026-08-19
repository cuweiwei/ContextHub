import type { DB } from '../db/connection.js';
import type { ItemsRepo } from './items-repo.js';
import type { ReadAccess } from './types.js';

export function rebuildEntityGraph(db: DB): { nodes: number; aliases: number; edges: number } {
  const run = db.transaction(() => {
    db.exec('DELETE FROM entity_graph_nodes; DELETE FROM entity_graph_aliases; DELETE FROM entity_graph_edges;');
    const rows = db.prepare("SELECT id, namespace, type, data, entities, sensitivity, trust_state FROM context_items WHERE deleted = 0 AND trust_state = 'accepted' AND (expires_at IS NULL OR expires_at > datetime('now'))").all() as Array<{ id: string; namespace: string; type: string; data: string | null; entities: string; sensitivity: string; trust_state: string }>;
    let nodes = 0; let aliases = 0; let edges = 0;
    for (const row of rows) {
      const data = row.data ? JSON.parse(row.data) as Record<string, unknown> : {};
      const entities = JSON.parse(row.entities) as string[];
      const defs = row.type === 'entity_definition' ? [data] : [];
      for (const def of defs) {
        const key = typeof def.entity_key === 'string' ? def.entity_key : typeof def.key === 'string' ? def.key : null;
        if (!key) continue;
        const label = typeof def.label === 'string' ? def.label : key;
        db.prepare('INSERT OR REPLACE INTO entity_graph_nodes (namespace, entity_key, label, evidence_item_id, updated_at) VALUES (?, ?, ?, ?, ?)').run(row.namespace, key, label, row.id, new Date().toISOString()); nodes += 1;
        for (const alias of Array.isArray(def.aliases) ? def.aliases.filter((value): value is string => typeof value === 'string') : []) { db.prepare('INSERT OR REPLACE INTO entity_graph_aliases (namespace, entity_key, alias, evidence_item_id) VALUES (?, ?, ?, ?)').run(row.namespace, key, alias, row.id); aliases += 1; }
      }
      if (row.type === 'entity_relation') {
        const from = typeof data.from === 'string' ? data.from : typeof data.from_entity === 'string' ? data.from_entity : null;
        const to = typeof data.to === 'string' ? data.to : typeof data.to_entity === 'string' ? data.to_entity : null;
        const relation = typeof data.relation === 'string' ? data.relation : null;
        if (from && to && relation) { db.prepare('INSERT OR REPLACE INTO entity_graph_edges (namespace, from_entity, relation, to_entity, evidence_item_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(row.namespace, from, relation, to, row.id, new Date().toISOString()); edges += 1; }
      }
      for (const entity of entities) {
        if (!entity.includes(':')) continue;
        db.prepare('INSERT OR IGNORE INTO entity_graph_nodes (namespace, entity_key, label, evidence_item_id, updated_at) VALUES (?, ?, ?, ?, ?)').run(row.namespace, entity, entity, row.id, new Date().toISOString()); nodes += 1;
      }
    }
    return { nodes, aliases, edges };
  })();
  return run;
}

export interface GraphTraversal { nodes: Array<{ entity_key: string; label: string; evidence_item_id: string }>; edges: Array<{ from_entity: string; relation: string; to_entity: string; evidence_item_id: string }>; truncated: boolean }

export function traverseEntityGraph(db: DB, itemsRepo: ItemsRepo, access: ReadAccess, start: string, depth = 2): GraphTraversal {
  const maxDepth = Math.min(3, Math.max(1, depth)); const started = Date.now();
  const nodes = new Map<string, { entity_key: string; label: string; evidence_item_id: string }>();
  const edges: GraphTraversal['edges'] = []; const queue: Array<{ key: string; level: number }> = [{ key: start, level: 0 }];
  const alias = db.prepare('SELECT entity_key, evidence_item_id FROM entity_graph_aliases WHERE namespace = ? AND alias = ?').get(access.namespace, start) as { entity_key: string; evidence_item_id: string } | undefined;
  if (alias && itemsRepo.get(access, alias.evidence_item_id)) queue[0] = { key: alias.entity_key, level: 0 };
  while (queue.length && nodes.size < 100 && edges.length < 200 && Date.now() - started < 100) {
    const current = queue.shift()!;
    const node = db.prepare('SELECT entity_key, label, evidence_item_id FROM entity_graph_nodes WHERE namespace = ? AND entity_key = ?').get(access.namespace, current.key) as { entity_key: string; label: string; evidence_item_id: string } | undefined;
    if (node && itemsRepo.get(access, node.evidence_item_id)) nodes.set(node.entity_key, node);
    if (current.level >= maxDepth) continue;
    const rows = db.prepare('SELECT from_entity, relation, to_entity, evidence_item_id FROM entity_graph_edges WHERE namespace = ? AND (from_entity = ? OR to_entity = ?)').all(access.namespace, current.key, current.key) as GraphTraversal['edges'];
    for (const edge of rows) {
      if (!itemsRepo.get(access, edge.evidence_item_id)) continue;
      if (!edges.some((value) => value.from_entity === edge.from_entity && value.relation === edge.relation && value.to_entity === edge.to_entity)) edges.push(edge);
      const next = edge.from_entity === current.key ? edge.to_entity : edge.from_entity;
      if (!nodes.has(next)) queue.push({ key: next, level: current.level + 1 });
      if (edges.length >= 200) break;
    }
  }
  return { nodes: [...nodes.values()], edges, truncated: queue.length > 0 || nodes.size >= 100 || edges.length >= 200 || Date.now() - started >= 100 };
}
