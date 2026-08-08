import { mayRow } from '../row-grant.ts';

export const CASCADE_PREAUTHORIZED: unique symbol = Symbol('workbench.cascade-preauthorized');
export const CASCADE_DESCENDANT: unique symbol = Symbol('workbench.cascade-descendant');

interface FieldDescriptor {
  kind?: string;
  type?: string;
  onRemove?: string;
  target?: string | { name?: string };
  access?: unknown;
}

interface EntityRecord {
  name: string;
  fields: Record<string, FieldDescriptor>;
  crudHandlers: Record<string, { inTransaction?: boolean }>;
}

interface Statement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface DbHandle {
  prepare(sql: string): Statement;
}

interface ChildRef {
  entity: EntityRecord;
  fieldName: string;
}

interface CascadeEntry {
  entity: EntityRecord;
  id: string;
}

function targetName(descriptor: FieldDescriptor | undefined): string | undefined {
  return typeof descriptor?.target === 'string' ? descriptor.target : descriptor?.target?.name;
}

export function installRemovalCascades(entities: Map<string, EntityRecord>): Map<string, ChildRef[]> {
  const children = new Map<string, ChildRef[]>([...entities.values()].map((entity) => [entity.name, []]));
  for (const entity of entities.values()) {
    const refs = Object.entries(entity.fields).filter(([, field]) => field?.onRemove !== undefined);
    if (refs.length > 1) throw new Error(`entity '${entity.name}' may declare only one onRemove ref`);
    if (refs.length === 0) continue;
    const [[fieldName, field]] = refs;
    if (field?.kind !== 'value' || field.type !== 'ref') throw new Error(`${entity.name}.${fieldName}.onRemove requires ref(...)`);
    if (field.onRemove !== 'cascade') throw new Error(`${entity.name}.${fieldName}.onRemove must be 'cascade'`);
    const parent = entities.get(targetName(field)!);
    if (!parent) throw new Error(`${entity.name}.${fieldName} references unknown cascade target '${targetName(field)}'`);
    children.get(parent.name)!.push({ entity, fieldName });
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function check(name: string): void {
    if (visiting.has(name)) throw new Error(`removal cascade cycle involving '${name}'`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const child of children.get(name) ?? []) check(child.entity.name);
    visiting.delete(name);
    visited.add(name);
  }
  for (const entity of entities.values()) check(entity.name);

  for (const root of entities.values()) {
    if ((children.get(root.name) ?? []).length === 0) continue;
    // Declaration resolution happens after binding, so only actual cascade
    // roots join the transaction required to authorize and enumerate children.
    async function enumerate(id: string, db: DbHandle, authorize: unknown, includeRoot: boolean): Promise<CascadeEntry[]> {
      const result: CascadeEntry[] = [];
      async function visit(entity: EntityRecord, rowId: string): Promise<void> {
        const row = db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(rowId);
        if (!row) throw Object.assign(new Error(`${entity.name} '${rowId}' not found`), { status: 404 });
        if (authorize && !(await mayRow(entity, 'remove', row, authorize))) {
          throw Object.assign(new Error('forbidden'), { status: 403 });
        }
        for (const { entity: child, fieldName } of children.get(entity.name) ?? []) {
          const rows = db.prepare(`SELECT id FROM ${child.name} WHERE ${fieldName} = ? ORDER BY id ASC`).all(rowId);
          for (const childRow of rows) await visit(child, childRow.id as string);
        }
        if (includeRoot || entity !== root || rowId !== id) result.push({ entity, id: rowId });
      }
      await visit(root, id);
      return result;
    }
    Object.defineProperty(root, 'removalCascade', { value: async (id: string, principal: unknown, db: DbHandle): Promise<CascadeEntry[]> => {
      const descendants = await enumerate(id, db, principal, false);
      const row = db.prepare(`SELECT * FROM ${root.name} WHERE id = ?`).get(id);
      return [...descendants, { entity: root, id: (row as { id: string }).id }];
    } });
    Object.defineProperty(root, 'removalCascadeDescendants', { value: (id: string, db: DbHandle) => enumerate(id, db, null, false) });
    Object.defineProperty(root.crudHandlers[`${root.name}.remove`], 'inTransaction', { value: true });
  }
  return children;
}
