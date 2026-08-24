// The annotated-text field kind's contribution to the Kernel. Kernel stays a
// pure assembler: the kind's authorization branch and its generated history
// (undo/redo compensation) actions live here, in the module that owns the
// kind, and are contributed as a seam rather than hand-listed in kernel.mjs.

import { ANNOTATED_COMPENSATION_INPUT } from './entity/crud.mjs';
import { admitRow } from './row-grant.mjs';
import { write } from './grant.mjs';
import { rawRow } from './entity/query.mjs';
import { tryParseScopeKey } from './scope-handle.mjs';
import { compileNativeInsertContributionPolicy,                                } from './history-contribution-policy.mjs';









export function createAnnotatedTextKernelSeam(entities                  )                          {
  const annotatedScopeEntities = new Set(
    [...entities.values()]
      .filter((entity     ) => Object.values(entity.fields).some((field     ) => field.kind === 'annotatedText'))
      .map((entity     ) => entity.name),
  );
  const annotatedActionDetails = new Map();
  for (const entity of entities.values()) for (const [fieldName, field] of Object.entries(entity.fields)) {
    if ((field       ).kind !== 'annotatedText') continue;
    annotatedActionDetails.set(`${entity.name}.${fieldName}.operation`, { entity, fieldName, field });
    annotatedActionDetails.set(`${entity.name}.${fieldName}.compensate`, { entity, fieldName, field, compensation: true });
  }

  // Compile-produced native-insert contribution policies (scope#992 Finding 6):
  // one policy entry per native annotated `.operation` and `.compensate` action
  // type, so the history engine's eligibility/barrier/retry decisions are
  // policy-owned rather than classifier-name-driven. The policy exposes
  // requirements only; grant decisions stay with the central authorize/admitRow
  // seam.
  const nativeInsertPolicies                                       = Object.freeze(
    [...annotatedActionDetails.keys()].map((actionType) =>
      compileNativeInsertContributionPolicy(
        { entity: annotatedActionDetails.get(actionType).entity.name, fieldName: annotatedActionDetails.get(actionType).fieldName },
        actionType,
      )),
  );
  // Declaration-derived read-privacy scope set. It is used ONLY by the history
  // actions()/events() read boundary (rev 3 §3); it has no eligibility,
  // barrier, target-selection, retry, or compensation role.
  const privateHistoryScopes                      = new Set(annotatedScopeEntities);

  // Annotated text history is a package-owned compensation action. It is not a
  // public action and is admitted only through the trusted history capability.
  // The compensation dispatch is decided by the contribution policy, never by an
  // action-name test; the plain input kind routes the move to this field-owned
  // emitter.
  const historyActions                      = {};
  for (const [type, detail] of annotatedActionDetails) {
    if (detail?.compensation) continue;
    historyActions[type] = {
      inverse: ({ origin, target, targetFact }     ) => ({ type: `${type.replace(/\.operation$/, '')}.compensate`, payload: { version: 1, id: origin.payload.id, history: { version: 1, rootActionId: origin.actionId, targetActionId: target.actionId, direction: 'undo' } }, input: { kind: ANNOTATED_COMPENSATION_INPUT, targetFact } }),
      redo: ({ origin, target, targetFact }     ) => ({ type: `${type.replace(/\.operation$/, '')}.compensate`, payload: { version: 1, id: origin.payload.id, history: { version: 1, rootActionId: origin.actionId, targetActionId: target.actionId, direction: 'redo' } }, input: { kind: ANNOTATED_COMPENSATION_INPUT, targetFact } }),
    };
  }

  // Returns true/false when the action is an annotated-text action, or null
  // when it is not — the Kernel then falls through to registered actions and
  // generated CRUD admission.
  async function authorize(context     , app     )                          {
    for (const entity of entities.values()) {
      for (const [fieldName, field] of Object.entries(entity.fields)) {
        if ((field       ).kind !== 'annotatedText') continue;
        for (const annotation of (field       ).annotations ?? []) {
          for (const [actionName, action] of Object.entries(annotation.actions ?? {})                        ) {
            const actionType = `${entity.name}.${fieldName}.${annotation.annotationName}.${actionName}`;
            if (context.type !== actionType) continue;
            const id = context.payload?.id;
            const row = typeof id === 'string' ? rawRow(app.db, entity.name, id) : null;
            if (!row) return false;
            if (!(await admitRow({ kind: 'fieldOp', entity, row: entity.deserializeRow({ ...row }), fieldName, capability: write, principal: context.principal }))) return false;
            if (action.kind === 'annotationAction') return true;
            const targetName = typeof (field       ).annotations?.find((candidate     ) => candidate.annotationName === annotation.annotationName)?.fields?.[action.relation]?.target === 'string'
              ? (field       ).annotations.find((candidate     ) => candidate.annotationName === annotation.annotationName).fields[action.relation].target
              : (field       ).annotations.find((candidate     ) => candidate.annotationName === annotation.annotationName).fields[action.relation].target?.name;
            const target = targetName ? app.entities?.get(targetName) : null;
            if (!target || !target.grant) return false;
            const candidate                      = { id: 'authorization-probe', [action.project]: row[(field       ).project], [action.author]: context.principal?.id };
            for (const [publicName, entityField] of Object.entries(action.input ?? {})) candidate[entityField          ] = context.payload?.values?.[publicName];
            if (!(await admitRow({ kind: 'verb', entity: target, row: candidate, verb: 'create', principal: context.principal }))) return false;
            return true;
          }
        }
      }
    }
    const annotated = annotatedActionDetails.get(context.type);
    if (annotated) {
      const id = context.payload?.id;
      if (typeof id !== 'string' || id.length === 0) return false;
      const row = rawRow(app.db, annotated.entity.name, id);
      if (!row) return false;
      return admitRow({
        kind: 'fieldOp',
        entity: annotated.entity,
        row: annotated.entity.deserializeRow({ ...row }),
        fieldName: annotated.fieldName,
        capability: write,
        principal: context.principal,
      });
    }
    return null;
  }

  // A mutation on an entity that carries an annotatedText field must also be
  // admitted against the owning "project" scope (the document's container), so
  // editing a document requires access to the project it lives in.
  async function admitProject({ entityName, verb, principal, event }     , app     )                   {
    const entity = app.entities?.get(entityName);
    const descriptor = entity && Object.values(entity.fields).find((field     ) => field.kind === 'annotatedText');
    if (!descriptor) return true;
    const project = tryParseScopeKey(event?.scope);
    const projectEntity = project && app.entities?.get(project.entity);
    // Declarations may target an externally-owned project table. When that
    // declaration is registered, it is the package authorization boundary.
    if (!projectEntity) return true;
    let row = null;
    try { row = projectEntity.findById(project.id, principal); } catch { row = null; }
    return admitRow({ kind: 'verb', entity: projectEntity, row, principal, verb });
  }

  return { historyActions, nativeInsertPolicies, privateHistoryScopes, authorize, admitProject };
}
