import { EventKind } from '../event-handle.ts';

interface InvitationAcceptanceDetails extends Record<string, unknown> {
  targetEntity: string;
  fieldName: string;
  mapOperation: string;
  targetId: string;
  memberId: string;
  role: string;
  invitationId: string;
  invitationOperation: 'update' | 'remove';
  useCount: unknown;
}

interface InvitationAcceptanceEvent {
  handle?: {
    entity?: string;
    field?: string;
    kind?: string;
    nativeName?: string;
  };
  data?: Record<string, unknown> | null;
}

const invitationAcceptanceAuthorities = new WeakMap<object, InvitationAcceptanceDetails | null>();

export function invitationAcceptancePrincipal(user: { id: unknown; attributes?: Record<string, unknown> | null }): object {
  const authority = Object.freeze({
    type: 'user',
    id: user.id,
    attributes: Object.freeze({ ...(user.attributes ?? {}) }),
  });
  invitationAcceptanceAuthorities.set(authority, null);
  return authority;
}

export function authorizeInvitationAcceptance(authority: object, details: InvitationAcceptanceDetails): void {
  invitationAcceptanceAuthorities.set(authority, Object.freeze(details) as InvitationAcceptanceDetails);
}

export function admitInvitationAcceptance({ event, principal }: { event: InvitationAcceptanceEvent | null | undefined; principal: object }): boolean {
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

export function admitsInvitationRemoval(principal: object, invitationId: unknown): boolean {
  const details = invitationAcceptanceAuthorities.get(principal);
  return details?.invitationOperation === 'remove'
    && details.invitationId === String(invitationId);
}
