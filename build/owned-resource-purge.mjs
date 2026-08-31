// Project declarations are ORDER-AGNOSTIC: the array order is never a purge
// instruction. The compiler topologically sorts dependent tables before their
// parents. Registration rejects only missing/invalid dispositions, foreign
// parents, and cycles; a declaration that lists a parent first is valid.
















const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
function identifier(value         , label        )                          {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${label} must be a bare SQL identifier`);
}

function dispositionOf(object                   , pluginId        )                          {
  const disposition = (object                                                 ).disposition;
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) {
    throw new Error(`search plugin '${pluginId}' owned object '${object.name}' is missing a project-purge disposition`);
  }
  const value = disposition                           ;
  if (value.kind === 'project-purge-root') {
    if (object.kind !== 'table') throw new Error(`search plugin '${pluginId}' object '${object.name}' has a project-purge root disposition but census kind '${object.kind}' is not a table`);
    identifier(value.projectKey, `project-purge root '${object.name}' projectKey`);
    return { kind: 'project-purge-root', projectKey: value.projectKey };
  }
  if (value.kind === 'project-purge-dependent') {
    if (object.kind !== 'table') throw new Error(`search plugin '${pluginId}' object '${object.name}' has a project-purge dependent disposition but census kind '${object.kind}' is not a table`);
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

export function compileProjectPurgePlan(plugin              )                   {
  const objects = plugin.ownedObjects.map((object) => ({ object, disposition: dispositionOf(object, plugin.id) }));
  const byName = new Map(objects.map((entry) => [entry.object.name.toLowerCase(), entry]));
  for (const { object, disposition } of objects) {
    if (disposition.kind !== 'project-purge-dependent') continue;
    const parent = byName.get(disposition.parent.toLowerCase());
    if (!parent) throw new Error(`search plugin '${plugin.id}' object '${object.name}' references foreign purge parent '${disposition.parent}'`);
    if (parent.object.kind !== 'table') throw new Error(`search plugin '${plugin.id}' dependent '${object.name}' parent '${disposition.parent}' is not a table`);
    if (parent.disposition.kind !== 'project-purge-root' && parent.disposition.kind !== 'project-purge-dependent') {
      throw new Error(`search plugin '${plugin.id}' dependent '${object.name}' parent '${disposition.parent}' is not project-purgeable`);
    }
  }
  const visiting = new Set        ();
  const visited = new Set        ();
  const ordered                 = [];
  const visit = (name        )       => {
    const key = name.toLowerCase();
    if (visiting.has(key)) throw new Error(`search plugin '${plugin.id}' project-purge dispositions contain a cycle at '${name}'`);
    if (visited.has(key)) return;
    visiting.add(key);
    const entry = byName.get(key) ;
    if (entry.disposition.kind === 'project-purge-root') {
      // roots are visited after all dependents below
    }
    for (const child of objects) {
      if (child.disposition.kind === 'project-purge-dependent' && child.disposition.parent.toLowerCase() === key) visit(child.object.name);
    }
    visiting.delete(key); visited.add(key); ordered.push(entry);
  };
  for (const { object } of objects) visit(object.name);
  const projectScopedIds = (name        )         => {
    const entry = byName.get(name.toLowerCase()) ;
    const disposition = entry.disposition;
    if (disposition.kind === 'project-purge-root') {
      return `SELECT id FROM ${entry.object.name} WHERE ${disposition.projectKey} = ?`;
    }
    if (disposition.kind !== 'project-purge-dependent') throw new Error(`project-purge parent '${name}' is not project-purgeable`);
    return `SELECT id FROM ${entry.object.name} WHERE ${disposition.foreignKey} IN (${projectScopedIds(disposition.parent)})`;
  };
  const plans = ordered.map(({ object, disposition }) => ({
    name: object.name,
    disposition,
    sql: disposition.kind === 'project-purge-root'
      ? `DELETE FROM ${object.name} WHERE ${disposition.projectKey} = ?`
      : disposition.kind === 'project-purge-dependent'
        ? `DELETE FROM ${object.name} WHERE ${disposition.foreignKey} IN (${projectScopedIds(disposition.parent)})`
        : '',
  }));
  // Prove the compiled child-before-parent invariant. Declaration order is
  // intentionally irrelevant; this checks the order produced by the sort.
  for (const [index, plan] of plans.entries()) if (plan.disposition.kind === 'project-purge-dependent') {
    const parent = plan.disposition.parent;
    if (index >= plans.findIndex((candidate) => candidate.name.toLowerCase() === parent.toLowerCase())) throw new Error(`search plugin '${plugin.id}' purge order places parent before dependent '${plan.name}'`);
  }
  return Object.freeze({ pluginId: plugin.id, objects: Object.freeze(plans.map((plan) => Object.freeze(plan))) });
}

export function executeProjectPurgePlans(db          , plans                             , projectId        )                     {
  const counts                                         = {};
  for (const plan of plans) {
    const pluginCounts                         = {};
    for (const object of plan.objects) {
      if (!object.sql) continue;
      pluginCounts[object.name] = Number(db.prepare(object.sql).run(projectId).changes);
    }
    if (Object.keys(pluginCounts).length > 0) counts[plan.pluginId] = pluginCounts;
  }
  return Object.freeze(Object.fromEntries(Object.entries(counts).map(([plugin, values]) => [plugin, Object.freeze(values)])));
}


export function ownedResourcesCapability(db          , plans                             )                           {
  let open = true;
  return Object.freeze({
    purgeProject(projectId        ) {
      if (!open) throw new Error('ownedResources capability is closed');
      if (typeof projectId !== 'string' || projectId.length === 0) throw new Error('ownedResources.purgeProject requires a project id');
      return executeProjectPurgePlans(db, plans, projectId);
    },
    close() { open = false; },
  });
}
