// The annotated-text field kind's contribution to the Kernel. Kernel stays a
// pure assembler: the kind's authorization branch and its generated history
// (undo/redo compensation) actions live here, in the module that owns the
// kind, and are contributed as a seam rather than hand-listed in kernel.mjs.

import { assertV9AnnotatedTextOffsetEditPayload, ANNOTATED_TEXT_COMPENSATION } from './entity/crud.ts';
import { admitRow } from './row-grant.ts';
import { write } from './grant.ts';
import { rawRow } from './entity/query.ts';
import { tryParseScopeKey } from './scope-handle.ts';
import { compileNativeInsertContributionPolicy, type HistoryContributionPolicy } from './history-contribution-policy.ts';

export interface AnnotatedTextKernelSeam {
  historyActions: Record<string, any>;
  annotatedHistory: unknown;
  nativeInsertPolicies: readonly HistoryContributionPolicy[];
  privateHistoryScopes: ReadonlySet<string>;
  authorize(context: any, app: any): Promise<boolean | null>;
  admitProject(event: any, app: any): Promise<boolean>;
}

export function createAnnotatedTextKernelSeam(entities: Map<string, any>): AnnotatedTextKernelSeam {
  const annotatedEntities = new Set(
    [...entities.values()]
      .filter((entity: any) => Object.values(entity.fields).some((field: any) => field.kind === 'annotatedText'))
      .map((entity: any) => entity.name),
  );
  const annotatedActionTypes = new Set(
    [...entities.values()].flatMap((entity: any) => Object.entries(entity.fields)
      .filter(([, field]) => (field as any).kind === 'annotatedText')
      .map(([field]) => `${entity.name}.${field}.operation`)),
  );
  const annotatedActionDetails = new Map();
  for (const entity of entities.values()) for (const [fieldName, field] of Object.entries(entity.fields)) {
    if ((field as any).kind !== 'annotatedText') continue;
    annotatedActionDetails.set(`${entity.name}.${fieldName}.operation`, { entity, fieldName, field });
    annotatedActionDetails.set(`${entity.name}.${fieldName}.compensate`, { entity, fieldName, field, compensation: true });
  }

  // Compile-produced native-insert contribution policies (scope#992 Finding 6):
  // one policy entry per native annotated `.operation` and `.compensate` action
  // type, so the history engine's retry/move authorization is policy-owned
  // rather than classifier-name-driven. The policy exposes requirements only;
  // grant decisions stay with the central authorize/admitRow seam.
  const nativeInsertPolicies: readonly HistoryContributionPolicy[] = Object.freeze(
    [...annotatedActionDetails.keys()].map((actionType) =>
      compileNativeInsertContributionPolicy(
        { entity: annotatedActionDetails.get(actionType).entity.name, fieldName: annotatedActionDetails.get(actionType).fieldName },
        actionType,
      )),
  );
  // Declaration-derived read-privacy scope set. It is used ONLY by the history
  // actions()/events() read boundary (rev 3 §3); it has no eligibility,
  // barrier, target-selection, retry, or compensation role.
  const privateHistoryScopes: ReadonlySet<string> = new Set(annotatedEntities);

  const isAnnotatedHistoryAction = ({ type, payload }: any) => {
    const detail = annotatedActionDetails.get(type);
    if (!detail || detail.compensation) return false;
    try {
      const command = assertV9AnnotatedTextOffsetEditPayload(detail.entity.name, detail.fieldName, payload);
      return command.edit.kind === 'text.insert' && command.edit.text.length > 0;
    } catch {
      return false;
    }
  };

  const isContribution = (fact: any, documentId: any) => fact?.version === 2 && fact.kind === 'annotated-text.contribution'
    && fact.documentId === documentId && fact.contribution?.kind === 'text.insert'
    && (!Object.hasOwn(fact.contribution, 'blockId') || (typeof fact.contribution.blockId === 'string' && fact.contribution.blockId.length > 0))
    && Array.isArray(fact.contribution.opId)
    && typeof fact.contribution.text === 'string' && Number.isSafeInteger(fact.contribution.scalarCount);

  const isAnnotatedHistoryFact = ({ type, payload, fact }: any) => {
    const detail = annotatedActionDetails.get(type);
    return Boolean(detail && isAnnotatedHistoryAction({ type, payload }) && isContribution(fact, payload.id));
  };

  // Annotated text history is a package-owned compensation action. It is not a
  // public action and is admitted only through the trusted history capability.
  const historyActions: Record<string, any> = {};
  for (const type of annotatedActionTypes) {
    historyActions[type] = {
      inverse: ({ origin, target, targetFact }: any) => ({ type: `${type.replace(/\.operation$/, '')}.compensate`, payload: { version: 1, id: origin.payload.id, history: { version: 1, rootActionId: origin.actionId, targetActionId: target.actionId, direction: 'undo' } }, input: { kind: ANNOTATED_TEXT_COMPENSATION, targetFact } }),
      redo: ({ origin, target, targetFact }: any) => ({ type: `${type.replace(/\.operation$/, '')}.compensate`, payload: { version: 1, id: origin.payload.id, history: { version: 1, rootActionId: origin.actionId, targetActionId: target.actionId, direction: 'redo' } }, input: { kind: ANNOTATED_TEXT_COMPENSATION, targetFact } }),
    };
  }

  const annotatedHistory = Object.freeze({
    entities: annotatedEntities,
    actionTypes: annotatedActionTypes,
    moveActionTypes: new Set([...annotatedActionDetails].filter(([, detail]) => detail).map(([type]) => type)),
    isEligibleAction: isAnnotatedHistoryAction,
    isCanonicalFact: isAnnotatedHistoryFact,
  });

  // Returns true/false when the action is an annotated-text action, or null
  // when it is not — the Kernel then falls through to registered actions and
  // generated CRUD admission.
  async function authorize(context: any, app: any): Promise<boolean | null> {
    for (const entity of entities.values()) {
      for (const [fieldName, field] of Object.entries(entity.fields)) {
        if ((field as any).kind !== 'annotatedText') continue;
        for (const annotation of (field as any).annotations ?? []) {
          for (const [actionName, action] of Object.entries(annotation.actions ?? {}) as Array<[string, any]>) {
            const actionType = `${entity.name}.${fieldName}.${annotation.annotationName}.${actionName}`;
            if (context.type !== actionType) continue;
            const id = context.payload?.id;
            const row = typeof id === 'string' ? rawRow(app.db, entity.name, id) : null;
            if (!row) return false;
            if (!(await admitRow({ kind: 'fieldOp', entity, row: entity.deserializeRow({ ...row }), fieldName, capability: write, principal: context.principal }))) return false;
            if (action.kind === 'annotationAction') return true;
            const targetName = typeof (field as any).annotations?.find((candidate: any) => candidate.annotationName === annotation.annotationName)?.fields?.[action.relation]?.target === 'string'
              ? (field as any).annotations.find((candidate: any) => candidate.annotationName === annotation.annotationName).fields[action.relation].target
              : (field as any).annotations.find((candidate: any) => candidate.annotationName === annotation.annotationName).fields[action.relation].target?.name;
            const target = targetName ? app.entities?.get(targetName) : null;
            if (!target || !target.grant) return false;
            const candidate: Record<string, any> = { id: 'authorization-probe', [action.project]: row[(field as any).project], [action.author]: context.principal?.id };
            for (const [publicName, entityField] of Object.entries(action.input ?? {})) candidate[entityField as string] = context.payload?.values?.[publicName];
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
  async function admitProject({ entityName, verb, principal, event }: any, app: any): Promise<boolean> {
    const entity = app.entities?.get(entityName);
    const descriptor = entity && Object.values(entity.fields).find((field: any) => field.kind === 'annotatedText');
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

  return { historyActions, annotatedHistory, nativeInsertPolicies, privateHistoryScopes, authorize, admitProject };
}
