import type { DbHandle } from './driver.ts';
import type { SearchOwnedObject, SearchPlugin } from './search-plugin.ts';

export type ProjectPurgeDisposition =
  | { readonly kind: 'project-purge-root'; readonly projectKey: string }
  | { readonly kind: 'project-purge-dependent'; readonly parent: string; readonly foreignKey: string }
  | { readonly kind: 'retained'; readonly reason: string }
  | { readonly kind: 'schema-only' };

export type ProjectPurgePlan = Readonly<{
  pluginId: string;
  objects: readonly Readonly<{ name: string; disposition: ProjectPurgeDisposition; sql: string }>[];
}>;

export type ProjectPurgeCounts = Readonly<Record<string, Readonly<Record<string, number>>>>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${label} must be a bare SQL identifier`);
}

function dispositionOf(object: SearchOwnedObject, pluginId: string): ProjectPurgeDisposition {
  const disposition = (object as SearchOwnedObject & { disposition?: unknown }).disposition;
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) {
    throw new Error(`search plugin '${pluginId}' owned object '${object.name}' is missing a project-purge disposition`);
  }
  const value = disposition as Record<string, unknown>;
  if (value.kind === 'project-purge-root') {
    identifier(value.projectKey, `project-purge root '${object.name}' projectKey`);
    return { kind: 'project-purge-root', projectKey: value.projectKey };
  }
  if (value.kind === 'project-purge-dependent') {
    identifier(value.parent, `project-purge dependent '${object.name}' parent`);
    identifier(value.foreignKey, `project-purge dependent '${object.name}' foreignKey`);
    return { kind: 'project-purge-dependent', parent: value.parent, foreignKey: value.foreignKey };
  }
  if (value.kind === 'retained') {
    if (typeof value.reason !== 'string' || value.reason.length === 0) throw new Error(`retained object '${object.name}' requires a named reason`);
    return { kind: 'retained', reason: value.reason };
  }
  if (value.kind === 'schema-only') return { kind: 'schema-only' };
  throw new Error(`search plugin '${pluginId}' owned object '${object.name}' has an unknown project-purge disposition`);
}

export function compileProjectPurgePlan(plugin: SearchPlugin): ProjectPurgePlan {
  const objects = plugin.ownedObjects.map((object) => ({ object, disposition: dispositionOf(object, plugin.id) }));
  const byName = new Map(objects.map((entry) => [entry.object.name.toLowerCase(), entry]));
  for (const { object, disposition } of objects) {
    if (disposition.kind !== 'project-purge-dependent') continue;
    const parent = byName.get(disposition.parent.toLowerCase());
    if (!parent) throw new Error(`search plugin '${plugin.id}' object '${object.name}' references foreign purge parent '${disposition.parent}'`);
    if (parent.object.kind !== 'table') throw new Error(`search plugin '${plugin.id}' dependent '${object.name}' parent '${disposition.parent}' is not a table`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: typeof objects = [];
  const visit = (name: string): void => {
    const key = name.toLowerCase();
    if (visiting.has(key)) throw new Error(`search plugin '${plugin.id}' project-purge dispositions contain a cycle at '${name}'`);
    if (visited.has(key)) return;
    visiting.add(key);
    const entry = byName.get(key)!;
    if (entry.disposition.kind === 'project-purge-root') {
      // roots are visited after all dependents below
    }
    for (const child of objects) {
      if (child.disposition.kind === 'project-purge-dependent' && child.disposition.parent.toLowerCase() === key) visit(child.object.name);
    }
    visiting.delete(key); visited.add(key); ordered.push(entry);
  };
  for (const { object } of objects) visit(object.name);
  const plans = ordered.map(({ object, disposition }) => ({
    name: object.name,
    disposition,
    sql: disposition.kind === 'project-purge-root'
      ? `DELETE FROM ${object.name} WHERE ${disposition.projectKey} = ?`
      : disposition.kind === 'project-purge-dependent'
        ? `DELETE FROM ${object.name} WHERE ${disposition.foreignKey} IN (SELECT id FROM ${disposition.parent})`
        : '',
  }));
  // A dependent must not precede its parent declaration's deletion unless it is
  // actually ordered before it; this assertion documents the compiled invariant.
  for (const [index, plan] of plans.entries()) if (plan.disposition.kind === 'project-purge-dependent') {
    const parent = plan.disposition.parent;
    if (index >= plans.findIndex((candidate) => candidate.name.toLowerCase() === parent.toLowerCase())) throw new Error(`search plugin '${plugin.id}' purge order places parent before dependent '${plan.name}'`);
  }
  return Object.freeze({ pluginId: plugin.id, objects: Object.freeze(plans.map((plan) => Object.freeze(plan))) });
}

export function executeProjectPurgePlans(db: DbHandle, plans: readonly ProjectPurgePlan[], projectId: string): ProjectPurgeCounts {
  const counts: Record<string, Record<string, number>> = {};
  for (const plan of plans) {
    const pluginCounts: Record<string, number> = {};
    for (const object of plan.objects) {
      if (!object.sql) continue;
      pluginCounts[object.name] = Number(db.prepare(object.sql).run(projectId).changes);
    }
    if (Object.keys(pluginCounts).length > 0) counts[plan.pluginId] = pluginCounts;
  }
  return Object.freeze(Object.fromEntries(Object.entries(counts).map(([plugin, values]) => [plugin, Object.freeze(values)])));
}

export interface OwnedResourcesCapability { readonly purgeProject: (projectId: string) => ProjectPurgeCounts; readonly close: () => void }
export function ownedResourcesCapability(db: DbHandle, plans: readonly ProjectPurgePlan[]): OwnedResourcesCapability {
  let open = true;
  return Object.freeze({
    purgeProject(projectId: string) {
      if (!open) throw new Error('ownedResources capability is closed');
      if (typeof projectId !== 'string' || projectId.length === 0) throw new Error('ownedResources.purgeProject requires a project id');
      return executeProjectPurgePlans(db, plans, projectId);
    },
    close() { open = false; },
  });
}
