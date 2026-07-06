# W2 Persistence Ownership Census

**Date:** 2026-07-06 | **Agent:** explore-flash | **Source:** Scope `~/Development/scope`

## (1) Summary

| Family | Count | Workbench Destination |
|---|---|---|
| **Domain** | 29 | station B entity declarations (Phase S) |
| **Infra** | 3 | Replaced wholesale by workbench `_Log`/cursors |
| **Search** | 2 (+3 FTS VTs) | Real W2 build items (vector field + FTS predicate plugin) |
| **Auth** | 6 | W1 |
| **Job** | 2 | W3 |
| **Preference/undo** | 7 | W5 (undo/cross-tab) + ordinary entities |
| **Total** | **49** | |

**GAP count: 2** (both search-family: vector embeddings and FTS need new workbench seams)

## (2) Per-Model Table

### Domain (29 models — station B entity declarations)

| Model | Fields | Has Raw SQL? | Workbench Destination | Notes |
|---|---|---|---|---|
| **Project** | 9 | No | Station B entity (`text`, `date`, `ref('Organization')`) | `iconMd5`/`originalIconMd5` → `text()`; FKs: org, members, codes, collections, artefacts etc |
| **Organization** | 7 | No | Station B entity (`text`, `boolean`, `date`) | `personalOwnerId` → `ref('User')` nullable |
| **OrganizationMember** | 5 | No | Station B entity (`ref('User')`, `ref('Organization')`, `text`) | Composite unique `[userId, orgId]` → workbench handles |
| **ProjectNote** | 7 | No | Station B entity; `sortOrder` → `number()` | Simple owned entity |
| **ProjectTranscriptionProfile** | 13 | No | Station B entity | All scalar fields → `text()`, `boolean()`, `number()`, `date()` |
| **ProjectApiKey** | 10 | No | Station B entity | `keyHash` → `hash()` kind; `keyPrefix` → `text()`. Expiry → `date()` |
| **ProjectMember** | 6 | No | Station B entity (`ref('User')`, `ref('Project')`, `text`) | Composite unique `[userId, projectId]` |
| **Invite** | 8 | No | Station B entity | `token` → unique `text()`; expiry semantics |
| **ProjectInvitation** | 5 | No | Station B entity (`ref('User')`, `ref('Project')`) | Composite unique `[userId, projectId]` |
| **Codebook** | 5 | No | Station B entity (`text`, `date`, `ref('Project')`) | Simple entity |
| **Code** | 8 | No | Station B entity | `colour` → `text()`; criteria fields → `text()`. FK: codebook |
| **Collection** | 6 | No | Station B entity (`text`, `date`, `ref('Project')`) | Simple entity |
| **CollectionArtefact** | 4 | No | Station B entity; join table → `map(ref('Artefact'))` on Collection | Composite PK `[collectionId, artefactId]`; `addedBy` → `ref('User')` |
| **Artefact** | 15 | No | Station B entity | All scalar → `text()`, `boolean()`, `date()`; FKs: project, collections, files, transcripts |
| **ArtefactCode** | 4 | No | Station B entity; join table | Composite PK `[artefactId, codeId, userId]` |
| **ArtefactTranscript** | 4 | No | Station B entity; join table | Composite PK `[artefactId, transcriptId]` |
| **MediaFile** | 16 | No | Station B entity (`text()`, `number()`, `date()`, `ref('User')`) | `sha256`/`md5` → `text()`; `size` → `number()`. Blob storage → workbench `blob()` field + BlobStore lifecycle with `blob-lifecycle.mjs` |
| **ArtefactFile** | 4 | No | Station B entity; join table | Composite PK `[artefactId, fileId]` |
| **Transcript** | 6 | No | Station B entity (`text`, `number`, `date`, `ref('MediaFile')`) | Simple entity with file link |
| **TranscriptSegment** | 10 | No | Station B entity | `wordConfidences` → `json()`, `avgLogprob`/`noSpeechProb` → `number()` | 
| **SegmentSpeaker** | 2 | No | Station B entity; join table | Composite PK `[segmentId, speakerId]` |
| **SegmentCode** | 4 | No | Station B entity; join table | Composite PK `[segmentId, codeId, userId]` |
| **Speaker** | 7 | No | Station B entity (`text`, `date`, `ref('Project')`) | Simple entity |
| **Source** | 7 | No | Station B entity (`text`, `date`, `ref('Project')`) | Simple entity |
| **Transformation** | 10 | No | Station B entity (`text`, `date`, `ref('MediaFile')` x2, `ref('Job')`) | Input/output file refs; job link |
| **Comment** | 10 | No | Station B entity | Self-referential FK `parentId` → `ref('Comment')`; resolution fields → `text()`, `boolean()`, `date()` |
| **ExternalRef** | 6 | No | Station B entity; polymorphic FK via entityType + entityId | Polymorphic pattern — workbench has no polymorphic FK yet; needs either a `ref()` per entityType or a generic `entityType`/`entityId` pair with app-level enforcement. Minor gap for W2 |
| **Theme** | 8 | No | Station B entity; `codeIds` → `json()` or `list(ref('Code'))` | `codeIds` is JSON-encoded string[] → stored as `json()`; a `list(ref('Code'))` would be more typed at the cost of a side-table |
| **ProjectReadme** | 5 | No | Station B entity (`text`, `date`, `ref('Project')`) | Simple entity; 1:1 with Project |

### Infra (3 models — replaced wholesale)

| Model | Fields | Has Raw SQL? | Workbench Destination | Notes |
|---|---|---|---|---|
| **ProjectActionLog** | 13 | No | Replaced by workbench `_Log` | Scope's in-tree event log — entire table retired. Workbench `_Log` table in `src/committed-log.mjs` |
| **ProjectActionCursor** | 4 | No | Replaced by workbench `_ConsumerCursor` | Per-scope cursor replaced by `_ConsumerCursor` + `_ProjectedCursor` in `ddl.mjs` |
| **ProjectEventLog** | 10 | No | Replaced by workbench `_Log` events | Event emission absorbed into workbench pipeline's mutation events |

### Search (2 models + 3 FTS virtual tables — real W2 build items)

| Model | Fields | Has Raw SQL? | Workbench Destination | Notes |
|---|---|---|---|---|
| **Embedding** | 12 | No (all via Prisma) | **GAP** — needs `vector(dim)` field type + cosine-similarity query | `embedding` column is `Json` (number[]). Workbench `json()` field stores it but cannot query by similarity. Council item #2: generic vector seam vs app-side blob-store |
| **TranscriptSpeakerEmbedding** | 12 | No (all via Prisma) | **GAP** — same vector gap as Embedding | Contains `embedding` JSON + `embeddingDimensions` + `segmentCount`. See Embedding notes |
| **FTS virtual tables** (segments_fts, artefacts_fts, codes_fts) | — | Yes (`$queryRawUnsafe` in `search.ts` and `fts-sync.ts`) | FTS predicate plugin — `.matches()` lowering to FTS5 | Council item #1: `text({ indexed: 'fts' })` + `.matches()` predicate via plugin seam |

### Auth (6 models — W1)

| Model | Fields | Has Raw SQL? | Workbench Destination | Notes |
|---|---|---|---|---|
| **User** | 11 | No | W1: workbench auth entity | `hash()` for password; `ref()` relations for sessions, accounts |
| **Session** | 8 | No | W1: workbench session entity | Token-based; expiry semantics |
| **Account** | 13 | No | W1: OAuth provider accounts | `accessToken`/`refreshToken` potentially sensitive → W1 handles secret storage |
| **Verification** | 6 | No | W1: verification tokens | Simple entity |
| **Passkey** | 12 | No | W1: WebAuthn | `publicKey` is raw crypto material → W1 handles |
| **TwoFactor** | 4 | No | W1: TOTP/backup-codes | `secret` is sensitive → W1 handles; `hash()` kind for backupCodes |

### Job (2 models — W3)

| Model | Fields | Has Raw SQL? | Workbench Destination | Notes |
|---|---|---|---|---|
| **Job** | 15 | No | W3: workbench `_Job` table (in `ddl.mjs`) | Workbench `_Job` table already exists with superset of columns. `outputLog`/`profile` → `text()`. `payload` → `text()` |
| **Worker** | 9 | No | W3: workbench `_Worker` table (in `ddl.mjs`) | Workbench `_Worker` table already exists. `secretHash` → `hash()` |

### Preference/undo (7 models — W5 / ordinary entities)

| Model | Fields | Has Raw SQL? | Workbench Destination | Notes |
|---|---|---|---|---|
| **UserUndoLog** | 11 | No | W5: undo log | Workbench will own the undo seam. `action`/`preimage` → `json()` |
| **UserUndoCursor** | 3 | No | W5: undo cursor | Workbench will own cursor tracking for undo |
| **UserCommandUsage** | 3 | No | Station B entity (`text()`, `date()`) | Simple usage tracking entity. Composite PK `[userId, commandId]` |
| **UserCodePreference** | 6 | No | Station B entity (`ref('User'), ref('Code'), boolean(), text())` | Per-user UI preference. Composite unique `[userId, projectId, codeId]` |
| **UserSpeakerPreference** | 6 | No | Station B entity (`ref('User'), ref('Speaker'), boolean(), text())` | Per-user UI preference. Composite unique `[userId, projectId, speakerId]` |
| **UserTranscriptPreference** | 8 | No | Station B entity (`ref('User'), ref('Transcript'), boolean())` | Per-user viewing preference. Composite unique `[userId, transcriptId]` |
| **Notification** | 15 | No | Station B entity or W5 | Polymorphic FKs (jobId, fileId, artefactId, transcriptId) — nullable refs all covered by workbench `ref()` with null allowed |

## (3) Raw SQL Surfaces

| File | Line | SQL | Classification |
|---|---|---|---|
| `db.ts` | 44 | `PRAGMA quick_check` (via `$queryRawUnsafe`) | Already planned — framework `ensureMigrationTable` + `runMigrations` own PRAGMA |
| `db.ts` | 75-81 | 7× `$executeRawUnsafe` PRAGMA: `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `cache_size=-64000`, `mmap_size=268435456`, `temp_store=MEMORY`, `foreign_keys=ON` | Already planned — framework `db.mjs` / driver owns all connection PRAGMAs |
| `health.ts` | 24 | `SELECT 1` (via `$queryRawUnsafe`) | Already planned — replaced by workbench health |
| `fts-sync.ts` | 33-34 | `SELECT sql FROM sqlite_master WHERE type='table' AND name=?` | Predicate-plugin candidate — introspection for FTS schema detection |
| `fts-sync.ts` | 48 | `DROP TABLE IF EXISTS ${name}` (FTS VT) | Predicate-plugin candidate — lifecycle DDL for FTS tables |
| `fts-sync.ts` | 50 | FTS5 `CREATE VIRTUAL TABLE` DDL (3×: segments_fts, artefacts_fts, codes_fts) | Predicate-plugin candidate — FTS creation belongs in the plugin lifecycle |
| `fts-sync.ts` | 64-65 | `DELETE FROM segments_fts WHERE segment_id=?` / `INSERT INTO segments_fts(segment_id, text) VALUES (?,?)` | Predicate-plugin candidate — FTS content sync hooks |
| `fts-sync.ts` | 72 | `DELETE FROM segments_fts WHERE segment_id=?` | Predicate-plugin candidate — FTS removal hook |
| `fts-sync.ts` | 79-80 | `DELETE FROM artefacts_fts WHERE artefact_id=?` / `INSERT INTO ...` | Predicate-plugin candidate — FTS content sync |
| `fts-sync.ts` | 87 | `DELETE FROM artefacts_fts WHERE artefact_id=?` | Predicate-plugin candidate |
| `fts-sync.ts` | 94-95 | `DELETE FROM codes_fts WHERE code_id=?` / `INSERT INTO ...` | Predicate-plugin candidate |
| `fts-sync.ts` | 102 | `DELETE FROM codes_fts WHERE code_id=?` | Predicate-plugin candidate |
| `fts-sync.ts` | 165 | `SELECT COUNT(*) as c FROM ${table}` (FTS row count) | Predicate-plugin candidate |
| `search.ts` | 35 | `SELECT segment_id FROM segments_fts WHERE segments_fts MATCH ? LIMIT 50` | Predicate-plugin candidate — `.matches()` lowering to FTS5 MATCH |
| `search.ts` | 82 | `SELECT artefact_id FROM artefacts_fts WHERE artefacts_fts MATCH ? LIMIT 50` | Predicate-plugin candidate |
| `search.ts` | 105 | `SELECT code_id FROM codes_fts WHERE codes_fts MATCH ? LIMIT 50` | Predicate-plugin candidate |

No embedding similarity `$queryRaw` was found — Scope's embeddings use pure Prisma `findMany` + in-process cosine distance (or the embedding is stored as JSON and compared in JS).

## (4) Verdict

| Metric | Value |
|---|---|
| **Total Prisma models** | **49** |
| **Domain (station B)** | 29 (59%) |
| **Infra (retired)** | 3 (6%) |
| **Search (W2 gap)** | 2 models + 3 FTS VTs |
| **Auth (W1)** | 6 (12%) |
| **Job (W3)** | 2 (4%) |
| **Preference/undo (W5)** | 7 (14%) |
| **GAP count** | **2** |
| **GAP ratio** | 2/49 = **4%** |

### Key GAPs

**GAP 1: Vector embeddings (`Embedding`, `TranscriptSpeakerEmbedding`)** — Scope stores `number[]` embeddings as JSON in Prisma. Workbench has `json()` for storage but has no `vector(dim)` field type and no nearest-neighbour query lowering. Scope currently handles similarity in-memory via JS (no raw SQL cosine distance in codebase). Council decision needed: generic `vector(dim)` field + brute-force SQL (fine for Scope's single-user-project scale) vs app-side blob-store.

**GAP 2: FTS predicate plugin** — Scope uses 3 FTS5 virtual tables (`segments_fts`, `artefacts_fts`, `codes_fts`) with `MATCH` queries via `$queryRawUnsafe` in `search.ts` (3 query sites) and lifecycle operations in `fts-sync.ts` (12 raw SQL sites total). Workbench needs a `text({ indexed: 'fts' })` field option + `.matches()` predicate that lowers to FTS5 `MATCH`. Council decision needed on plugin seam shape.
