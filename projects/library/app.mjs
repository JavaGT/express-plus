// projects/library/app.mjs — thin global wiring for the library system.
//
// Follows the same pattern as domain-modules/app.mjs: mount entities
// at explicit paths, wire cross-cutting routes at app level.
//
import expressPlus from 'express-plus';
import {
  Patron, Item, Copy, Checkout, Hold, Comment, catalogRoutes,
} from './index.mjs';

const app = expressPlus();

// Auth boundary (framework User/Session routes).
app.use('/sessions', /* sessionRoutes() */ null);
app.use('/users',    /* userRoutes()    */ null);

// Mount domain entities.
app.mount('/patrons',   Patron);    // auto-CRUD behind grant (owner-only)
app.mount('/items',     Item);      // public catalog: read-only grant for patrons
app.mount('/copies',    Copy);      // CRUD + state transitions (staff-gated)
app.mount('/holds',     Hold);      // place/list holds
app.mount('/checkouts', Checkout);  // audit trail (read-only)
app.mount('/comments',  Comment);   // staff-only, hide() for patrons

// Cross-entity catalog routes (span Item + Copy).
app.use('/catalog', catalogRoutes());

app.listen(4000, () => console.log('library system on http://localhost:4000'));
