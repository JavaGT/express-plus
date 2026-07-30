import { mayRow } from '../row-grant.mjs';

export const CASCADE_PREAUTHORIZED = Symbol('workbench.cascade-preauthorized');

function targetName(descriptor) {
  return typeof descriptor?.target === 'string' ? descriptor.target : descriptor?.target?.name;
}

export function installRemovalCascades(entities) {
  const children = new Map([...entities.values()].map((entity) => [entity.name, []]));
  for (const entity of entities.values()) {
    const refs = Object.entries(entity.fields).filter(([, field]) => field?.onRemove !== undefined);
    if (refs.length > 1) throw new Error(`entity '${entity.name}' may declare only one onRemove ref`);
    if (refs.length === 0) continue;
    const [[fieldName, field]] = refs;
    if (field?.kind !== 'value' || field.type !== 'ref') throw new Error(`${entity.name}.${fieldName}.onRemove requires ref(...)`);
    if (field.onRemove !== 'cascade') throw new Error(`${entity.name}.${fieldName}.onRemove must be 'cascade'`);
    const parent = entities.get(targetName(field));
    if (!parent) throw new Error(`${entity.name}.${fieldName} references unknown cascade target '${targetName(field)}'`);
    if (parent.conditionalCreateHistory) throw new Error(`entity '${parent.name}' conditional create history does not support removal cascades`);
    children.get(parent.name).push({ entity, fieldName });
  }

  const visiting = new Set();
  const visited = new Set();
  function check(name) {
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
    Object.defineProperty(root, 'removalCascade', { value: async (id, principal, db) => {
      const result = [];
      async function visit(entity, rowId) {
        const row = db.prepare(`SELECT * FROM ${entity.name} WHERE id = ?`).get(rowId);
        if (!row) throw Object.assign(new Error(`${entity.name} '${rowId}' not found`), { status: 404 });
        if (!(await mayRow(entity, 'remove', row, principal))) {
          throw Object.assign(new Error('forbidden'), { status: 403 });
        }
        for (const { entity: child, fieldName } of children.get(entity.name) ?? []) {
          const rows = db.prepare(`SELECT id FROM ${child.name} WHERE ${fieldName} = ? ORDER BY id ASC`).all(rowId);
          for (const childRow of rows) await visit(child, childRow.id);
        }
        result.push({ entity, id: rowId });
      }
      await visit(root, id);
      return result;
    } });
    Object.defineProperty(root.crudHandlers[`${root.name}.remove`], 'inTransaction', { value: true });
  }
  return children;
}
