import { ref } from './field.mjs';
import { scope } from './scope.mjs';
import { grant, deny, read, write, subscribe, admin } from './grant.mjs';

                                                                        

export function owner()          {
  return ref('User', { role: 'owner', readonly: true });
}

(owner                                        ).only = () => [
  scope(({ is }          ) => is.owner()).can(
    async ({ is }          ) =>
      (await is.owner())
        ? grant(read, write, subscribe, admin)
        : deny('not the owner'),
  ),
];
