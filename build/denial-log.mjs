// Rate-limited denial logging (S5/A4). A denial flood must not flood the audit
// trail: denials are keyed per (actor, reasonCode) — actor type/id/status + a
// closed reason code, NEVER the reason's embedded values or any row/payload
// content — and the log emits ONE representative security audit event per fixed
// window per key, suppressing the rest. The representative rides the real actor
// (owner r2: status is an audit input), so a flood of anonymous-collapsed
// denials still attributes correctly in the security record without weakening
// the two-valued admission surface the decisions themselves saw.

                                                                                        
import { sanitizeOpaqueId,                                                } from './audit.mjs';
                                                        
import {                 statusOf } from './principal.mjs';
import { createKeyedRateLimiter,                       } from './rate-limit.mjs';

// The raw denial record. outcome is always 'deny' and reasonCode is REQUIRED (a
// closed admission code). `principal` is the real (pre-collapse) principal — the
// representative event records its true type/id/status.
                              
                                
                                                        
                                              
                                      
                                           
 

                                       
                            
                             
                              
                                      
 

                                
                            
                                                                               
                                                                              
                                                                   
                                                     
                                                                             
                                                                    
 

const KEY_SEPARATOR = '\u0000';

export function createDenialAuditor({
  auditor,
  windowMs = 60_000,
  now,
  limiter = createKeyedRateLimiter({ windowMs, max: 1, now }),
}                      )                {
  function actorOf(principal           )             {
    return Object.freeze({
      type: principal.type,
      id: sanitizeOpaqueId(principal.id),
      status: statusOf(principal),
    });
  }

  function keyOf(actor            , reasonCode                     )         {
    const id = sanitizeOpaqueId(actor.id) ?? 'anon';
    return `${actor.type}:${id}:${actor.status}${KEY_SEPARATOR}${reasonCode}`;
  }

  function auditDenial(input             )                    {
    const decision = limiter.check(keyOf(actorOf(input.principal), input.reasonCode));
    if (!decision.allowed) return null;
    return auditor.auditSecurity({
      principal: input.principal,
      operation: input.operation,
      resourceCategory: input.resourceCategory,
      resourceId: input.resourceId,
      outcome: 'deny',
      reasonCode: input.reasonCode,
    });
  }

  return Object.freeze({ windowMs, auditDenial, keyOf });
}
