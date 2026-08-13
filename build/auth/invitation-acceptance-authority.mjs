import { EventKind } from '../event-handle.mjs';

                                                                       
                       
                    
                       
                   
                   
               
                       
                                           
                    
 

                                     
            
                    
                   
                  
                        
    
                                        
 

const invitationAcceptanceAuthorities = new WeakMap                                            ();

export function invitationAcceptancePrincipal(user                                                              )         {
  const authority = Object.freeze({
    type: 'user',
    id: user.id,
    attributes: Object.freeze({ ...(user.attributes ?? {}) }),
  });
  invitationAcceptanceAuthorities.set(authority, null);
  return authority;
}

export function authorizeInvitationAcceptance(authority        , details                             )       {
  invitationAcceptanceAuthorities.set(authority, Object.freeze(details)                               );
}

export function admitInvitationAcceptance({ event, principal }                                                                            )          {
  const details = invitationAcceptanceAuthorities.get(principal);
  if (!details || !event?.handle) return false;
  const { handle, data } = event;
  if (
    handle.entity === details.targetEntity
    && handle.field === details.fieldName
    && handle.kind === EventKind.native
    && handle.nativeName === details.mapOperation
  ) {
    return String(data?.owner) === details.targetId
      && String(data?.member) === details.memberId
      && data?.role === details.role;
  }
  if (handle.entity !== 'Invitation' || String(data?.id) !== details.invitationId) return false;
  if (details.invitationOperation === 'update') {
    return handle.kind === EventKind.updated && data?.useCount === details.useCount;
  }
  return details.invitationOperation === 'remove' && handle.kind === EventKind.removed;
}

export function admitsInvitationRemoval(principal        , invitationId         )          {
  const details = invitationAcceptanceAuthorities.get(principal);
  return details?.invitationOperation === 'remove'
    && details.invitationId === String(invitationId);
}
