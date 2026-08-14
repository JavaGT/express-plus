// The generic audit contract (S5/A4): ONE event schema, TWO retention classes,
// and an injectable sink. This module owns the audit VOCABULARY and the
// classification/retention MODEL; storage is the app adapter's choice.
//
//   - ONE schema (AuditEvent): id, time, actor (the REAL type/id/status),
//     operation, resourceCategory, resourceId?, outcome, reasonCode,
//     classification. An event is a decision LABEL — no payload, body, secret,
//     alias, filename, or excerpt can ride it.
//   - TWO classes: `security` (administrative/security decisions — retained)
//     and `diagnostic` (operational — rotatable). Ordinary no-history
//     collaboration mutations are NOT audit events — they are the committed-log
//     / history tier already; this module never builds a hidden second history.
//   - STATUS IS AN AUDIT INPUT, NOT A DECISION INPUT (owner r2): the audit
//     context carries the REAL principal (statusOf reads the true status) even
//     though admission collapsed it to anonymous. `actor` records the real
//     type/id/status for the security record without weakening the two-valued
//     admission surface — a revoked and an unknown caller stay indistinguishable
//     to the DECISION caller.
//   - RETENTION IS ADAPTER POLICY: the package only exposes a two-class
//     `retentionConfig` and passes it through untouched; the reference app sets
//     security='12m' / diagnostic='30d'. The package stays generic.
//
// The denial path (rate-limited) lives in src/denial-log.ts and emits
// security-classified events through an Auditor.

import { randomUUID } from 'node:crypto';
                                                                                        
                                                        
import { statusOf,                                                          } from './principal.mjs';

                                                            
                                            

// The actor is the REAL principal identity and status (S5/A1 statusOf). This is
// the audit trail — never a decision input: admission collapsed non-active
// principals to anonymous before any gate ran, and the decision surface carries
// only 'anonymous'. The real status lives here so the security record can
// attribute a denial without weakening the two-valued admission rule.
                             
                               
                             
                                   
 

// The one audit event schema. Enumerated fields ONLY — no payload/body/secret/
// alias/filename/excerpt may ride an event. `operation` is the generic
// operation-category name ('read', 'update', ...); `resourceCategory` is a
// generic category (entity/blob/search/action/subscription/principal/policy),
// never a domain noun. `resourceId` is an opaque id when known; `reasonCode` is
// a closed admission code, null when the event records an allow.
                             
                      
                        
                             
                                    
                                              
                                     
                                 
                                                  
                                               
 

// Retention is ADAPTER policy, not package policy. Values are opaque duration
// strings ('12m' / '30d' in the reference app); the package passes them
// through untouched and the sink consumes them.
                                    

                                  
                                    
                                      
 

// The raw decision record an emitter classifies. `principal` is the REAL
// (pre-collapse) principal — the emitter records its true type/id/status via
// statusOf, exactly the "status is an audit input" rule.
                             
                                
                                                        
                                              
                                      
                                 
                                                   
 

// The injectable audit sink. The default is a no-op; the app adapter chooses
// storage and consumes the retention value applicable to the event's class
// (read from the auditor's retentionConfig).
                            
                                                            
 

export const noopAuditSink            = Object.freeze({ write() {} });

                                 
                            
                                                                   
                                            
                              
                             
 

                          
                                            
                                               
                                                 
 

// Build the audit emitters + retention passthrough for one application. A
// per-class sink (sinks.security / sinks.diagnostic) wins over the shared sink;
// the default sink is a no-op, so unconfigured audit calls are free.
export function createAuditor({
  sink,
  sinks,
  retentionConfig,
  now = Date.now,
  id = randomUUID,
}                )          {
  const config                  = Object.freeze({ ...retentionConfig });

  function emit(classification                     , input            )             {
    const target = sinks?.[classification] ?? sink ?? noopAuditSink;
    const event             = Object.freeze({
      id: id(),
      time: now(),
      actor: Object.freeze({
        type: input.principal.type,
        id: input.principal.id,
        status: statusOf(input.principal),
      }),
      operation: operationName(input.operation),
      resourceCategory: input.resourceCategory,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      classification,
    });
    target.write(event, config[classification]);
    return event;
  }

  return Object.freeze({
    retentionConfig: config,
    auditSecurity: (input            )             => emit('security', input),
    auditDiagnostic: (input            )             => emit('diagnostic', input),
  });
}

// Normalize an operation token or name to the generic category NAME recorded on
// the event.
function operationName(operation                                   )                {
  if (operation == null) return null;
  return typeof operation === 'string' ? operation : operation.operation;
}
