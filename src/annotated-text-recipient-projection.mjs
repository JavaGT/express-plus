// Public recipient projection for the blockless annotated-text model (issue #33).
//
// The canonical document is ONE continuous text plus document-scoped
// annotation ranges. A denied protector redacts its range (inline placeholder)
// or, when unprojectable, restricts the whole document (fail closed — never
// partial disclosure). Ranges are mapped from canonical offsets to
// recipient-visible offsets (hidden intervals removed).

import { getAnnotatedTextCompiledMetadata } from './annotated-text-field.mjs';

// Snapshot minting needs the canonical intervals to bind an authoring token,
// but those intervals must never serialize with the recipient.
const recipientRedactionIntervals = new WeakMap          ();

export function authoringRedactionsForRecipient(recipient     ) {
  return recipientRedactionIntervals.get(recipient) ?? [];
}

function fail(message        )        { throw new Error(`annotated-text recipient projection: ${message}`); }

function freeze(value     ) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function exact(value     , keys          , label        ) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(`${label} has invalid shape`);
}

                               
             
                 
                              
                 
                                
 

                          
                       
                
              
 

                                
             
                 
                        
               
 

                           
             
                 
                              
                     
                               
                 
 

                                  
               
                  
               
                                     
                           
                                       
                            
                              
 

                              
                  
                                                              
                            
 

export function projectAnnotatedTextForRecipient(canonical                        , descriptor     , decisions                    ) {
  const meta = getAnnotatedTextCompiledMetadata(descriptor);
  if (!meta) fail('descriptor must be compiled');
  const canonicalKeys = ['kind', 'version', 'text', 'annotations', 'ranges', 'measurements', 'capabilityHints'];
  if (Object.hasOwn(canonical ?? {}, 'orphans')) canonicalKeys.push('orphans');
  exact(canonical, canonicalKeys, 'canonical');
  exact(decisions, ['version', 'protectors', 'capabilityHints'], 'decisions');
  if (canonical.kind !== 'workbench.annotatedText.canonical' || canonical.version !== 1 || decisions.version !== 1 ||
      typeof canonical.text !== 'string' || !Array.isArray(canonical.annotations) || !Array.isArray(canonical.ranges) ||
      !Array.isArray(canonical.measurements) || !Array.isArray(canonical.capabilityHints) ||
      (canonical.orphans !== undefined && !Array.isArray(canonical.orphans)) || !Array.isArray(decisions.protectors) || !Array.isArray(decisions.capabilityHints)) fail('invalid version or collection');

  const textLength = canonical.text.length;
  const annotations = new Map                             ();
  for (const annotation of canonical.annotations) {
    const keys = annotation?.protectedTargetIds === undefined
      ? (annotation?.owner === undefined ? ['id', 'family', 'fields'] : ['id', 'family', 'fields', 'owner'])
      : (annotation?.owner === undefined ? ['id', 'family', 'fields', 'protectedTargetIds'] : ['id', 'family', 'fields', 'owner', 'protectedTargetIds']);
    exact(annotation, keys, 'annotation');
    if (typeof annotation.id !== 'string' || annotations.has(annotation.id) || !Object.hasOwn(meta.annotationHandles, annotation.family)) fail('annotation is invalid');
    if (annotation.protectedTargetIds !== undefined && (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !Array.isArray(annotation.protectedTargetIds) || annotation.protectedTargetIds.some((id, i, all) => typeof id !== 'string' || (i > 0 && all[i - 1] >= id)))) fail('protector targets are invalid');
    annotations.set(annotation.id, annotation);
  }

  // Document-scoped ranges: absolute offsets. An annotation may own ZERO or MORE
  // (disjoint) ranges: an exclusive 'one'-cardinality apply trims the overlapped
  // middle of a same-family annotation into left/right remnants, so a single
  // annotation is no longer guaranteed one contiguous range.
  const rangeByAnnotation = new Map                          ();
  for (const range of canonical.ranges) {
    exact(range, ['annotationId', 'start', 'end'], 'range');
    const annotation = annotations.get(range.annotationId);
    if (!annotation || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
        range.start < 0 || range.end < range.start || range.end > textLength) fail('range is invalid');
    const own = rangeByAnnotation.get(range.annotationId);
    if (own) own.push(range);
    else rangeByAnnotation.set(range.annotationId, [range]);
  }

  const orphanIds = new Set        ();
  const disclosableOrphans                    = [];
  for (const orphan of canonical.orphans ?? []) {
    exact(orphan, orphan?.owner === undefined ? ['id', 'family', 'fields', 'savedQuote', 'savedRange'] : ['id', 'family', 'fields', 'owner', 'savedQuote', 'savedRange'], 'orphan');
    if (typeof orphan.id !== 'string' || orphanIds.has(orphan.id) || !Object.hasOwn(meta.annotationHandles, orphan.family) ||
        typeof orphan.savedQuote !== 'string' || !Array.isArray(orphan.savedRange) || orphan.savedRange.length !== 2 ||
        !Number.isSafeInteger(orphan.savedRange[0]) || !Number.isSafeInteger(orphan.savedRange[1]) || orphan.savedRange[0] < 0 || orphan.savedRange[1] < orphan.savedRange[0]) fail('orphan is invalid');
    if (annotations.has(orphan.id)) fail('orphan id conflicts with active annotation');
    orphanIds.add(orphan.id);
    disclosableOrphans.push(orphan);
  }

  const measurementIds = new Set        ();
  for (const measurement of canonical.measurements) {
    exact(measurement, ['id', 'family', 'formatVersion', 'payload'], 'measurement');
    if (typeof measurement.id !== 'string' || measurementIds.has(measurement.id) ||
        !Object.hasOwn(meta.measurementHandles, measurement.family) || !Number.isSafeInteger(measurement.formatVersion) || measurement.formatVersion < 1) fail('measurement is invalid');
    measurementIds.add(measurement.id);
  }

  // Protector activation: a protector range must intersect a protected target's
  // range. Whole-document (0..textLength) protectors cover everything. A stale
  // protectedTargetIds entry (naming an annotation that does not exist) is
  // invalid canonical state and fails closed — validate EVERY target id before
  // any intersection break. A rangeless protector or target (its only range was
  // displaced by an exclusive apply) is legal but can never activate.
  for (const annotation of annotations.values()) {
    if (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !annotation.protectedTargetIds?.length) continue;
    for (const targetId of annotation.protectedTargetIds) {
      if (!annotations.has(targetId)) fail(`protector '${annotation.id}' names an unknown protected target '${targetId}'`);
    }
  }
  const active = new Set        ();
  for (const annotation of annotations.values()) {
    if (!Object.hasOwn(meta.protectingFamilies, annotation.family) || !annotation.protectedTargetIds?.length) continue;
    const ownRanges = rangeByAnnotation.get(annotation.id) ?? [];
    if (ownRanges.length === 0) continue;
    const wholeDocument = ownRanges.some((own) => own.start === 0 && own.end === textLength);
    for (const targetId of annotation.protectedTargetIds) {
      const targetRanges = rangeByAnnotation.get(targetId) ?? [];
      const intersects = ownRanges.some((own) => targetRanges.some((target) => own.start < target.end && target.start < own.end));
      if (wholeDocument || intersects) {
        active.add(annotation.id);
        break;
      }
    }
  }

  const outcomes = new Map                ();
  for (const decision of decisions.protectors) {
    exact(decision, ['protectorId', 'outcome'], 'protector decision');
    if (!active.has(decision.protectorId) || outcomes.has(decision.protectorId) || !['allow', 'deny'].includes(decision.outcome)) fail('protector decisions must exactly match active protectors');
    outcomes.set(decision.protectorId, decision.outcome);
  }
  if (outcomes.size !== active.size) fail('protector decisions must exactly match active protectors');
  const capabilityHints = new Set        ();
  for (const hint of decisions.capabilityHints) {
    if (typeof hint !== 'string' || !Object.hasOwn(meta.capabilityHandles ?? {}, hint) || capabilityHints.has(hint)) fail('capability hints must be unique declared capabilities');
    capabilityHints.add(hint);
  }

  // A denied protector redacts its own range. If the range is the whole
  // document, restrict the document (fail closed) and return NO text.
  const deniedIntervals                                                          = [];
  let restricted = false;
  for (const id of active) {
    if (outcomes.get(id) !== 'deny') continue;
    const ownRanges = rangeByAnnotation.get(id) ;
    if (ownRanges.some((range) => range.start === 0 && range.end === textLength)) {
      restricted = true;
      break;
    }
    for (const range of ownRanges) {
      deniedIntervals.push({ start: range.start, end: range.end, placeholder: meta.protectingFamilies[annotations.get(id) .family].placeholder });
    }
  }
  if (restricted) {
    const result = { kind: 'workbench.annotatedText.recipient', version: 1, restricted: true, text: '', ranges: [], annotations: [] };
    recipientRedactionIntervals.set(result, []);
    return freeze(result);
  }
  deniedIntervals.sort((left, right) => left.start - right.start || right.end - left.end);
  const merged                                                          = [];
  for (const interval of deniedIntervals) {
    const prior = merged.at(-1);
    if (prior && interval.start <= prior.end) {
      prior.end = Math.max(prior.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  // Build the recipient-visible text (hidden intervals replaced by their
  // placeholder) and map canonical offsets to visible offsets.
  let text = '';
  let offset = 0;
  const authoring                                                              = [];
  const redactions = merged.map((interval) => {
    text += canonical.text.slice(offset, interval.start);
    const visibleStart = text.length;
    offset = interval.end;
    authoring.push(Object.freeze({ visibleStart, start: interval.start, end: interval.end }));
    return { start: visibleStart, end: visibleStart, placeholder: interval.placeholder };
  });
  text += canonical.text.slice(offset);

  const visibleOffsetFor = (canonicalOffset        ) => {
    let hidden = 0;
    for (const interval of authoring) {
      if (canonicalOffset < interval.start) break;
      // An offset at or inside a hidden interval maps to the interval's visible
      // marker position (zero-width); never to an unrelated earlier offset.
      if (canonicalOffset <= interval.end) return interval.visibleStart;
      hidden += interval.end - interval.start;
    }
    return canonicalOffset - hidden;
  };

  const recipientRanges                                                              = [];
  const retainedAnnotationIds = new Set        ();
  for (const [annotationId, ownRanges] of rangeByAnnotation) {
    const family = annotations.get(annotationId) .family;
    if (Object.hasOwn(meta.protectingFamilies, family)) continue;
    for (const range of ownRanges) {
      const start = visibleOffsetFor(range.start);
      const end = visibleOffsetFor(range.end);
      // Fully inside a redaction → no positive visible span; the range drops out
      // of delivery (no show-through for fully-redacted ranges).
      if (end <= start) continue;
      retainedAnnotationIds.add(annotationId);
      recipientRanges.push({ annotationId, start, end });
    }
  }

  const result = {
    kind: 'workbench.annotatedText.recipient', version: 1,
    text,
    ranges: recipientRanges,
    annotations: [...annotations.values()].filter((a) => retainedAnnotationIds.has(a.id)).map(({ id, family, fields, owner }) => ({ id, family, fields: { ...fields }, ...(owner ? { owner } : {}) })),
    measurements: canonical.measurements.map((m) => ({ ...m })),
    capabilityHints: [...capabilityHints].filter((hint) => (!redactions.length) || hint !== 'body.read'),
    orphans: (canonical.orphans ?? [])
      .filter((orphan) => !Object.hasOwn(meta.protectingFamilies, orphan.family))
      // An orphan's savedQuote is HISTORICAL text (the range it lived in is
      // gone) and cannot be provenance-checked against the current text. Any
      // redaction for this recipient could have come to cover where that quote
      // originated, so fail closed: no redacted document discloses orphans.
      .filter(() => redactions.length === 0)
      .map(({ id, family, fields, savedQuote, owner }) => ({ id, family, fields: { ...fields }, savedQuote, ...(owner ? { owner } : {}) })),
    ...(redactions.length ? { redactions } : {}),
  };
  recipientRedactionIntervals.set(result, authoring);
  return freeze(result);
}
