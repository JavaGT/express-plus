// schema-maintenance.ts — resumable, explicitly non-transactional boot work.
//
// A completed step is recorded only after its body returns. Work before a
// failure is deliberately retained: maintenance is not a migration and makes
// no atomicity claim. A checkpoint lets a long-running step resume from its
// own durable cursor after interruption.


import { createMaintenanceSeam } from './maintenance.mjs';


export const SCHEMA_MAINTENANCE_TABLE = '_SchemaMaintenance';




























const DDL = `CREATE TABLE IF NOT EXISTS ${SCHEMA_MAINTENANCE_TABLE} (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  state TEXT NOT NULL,
  progress TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  lastError TEXT
)`;

function encodeProgress(progress         )         {
  const encoded = JSON.stringify(progress ?? null);
  if (encoded === undefined) throw new TypeError('maintenance checkpoint progress must be JSON-serializable');
  return encoded;
}

function decodeProgress(progress         , id        )          {
  try {
    return JSON.parse(String(progress));
  } catch {
    throw new Error(`maintenance step '${id}' has corrupt durable progress`);
  }
}

function messageOf(error         )         {
  return error instanceof Error ? error.message : String(error);
}

export function createSchemaMaintenanceRunner({
  db,
  steps,
  writeCoordinator,
}



 )                          {
  const ids = new Set        ();
  for (const step of steps) {
    if (!step || typeof step.id !== 'string' || step.id.length === 0 || typeof step.description !== 'string' || step.description.length === 0 || typeof step.run !== 'function') {
      throw new TypeError('maintenance steps require a non-empty id, description, and run function');
    }
    if (ids.has(step.id)) throw new Error(`duplicate maintenance step '${step.id}'`);
    ids.add(step.id);
  }

  const resolveDb = ()           => {
    const handle = typeof db === 'function' ? db() : db;
    if (!handle) throw new Error('schema maintenance requires a database');
    return handle;
  };
  const foreignKeys = createMaintenanceSeam(resolveDb, writeCoordinator).withForeignKeysDisabled;

  function states()                                    {
    if (steps.length === 0) return [];
    const handle = resolveDb();
    const exists = handle.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(SCHEMA_MAINTENANCE_TABLE);
    if (!exists) return [];
    return (handle.prepare(`SELECT id, description, state, progress, attempts, lastError FROM ${SCHEMA_MAINTENANCE_TABLE} ORDER BY id`).all()                                  )
      .map((row) => Object.freeze({
        id: String(row.id),
        description: String(row.description),
        state: String(row.state)                                   ,
        progress: decodeProgress(row.progress, String(row.id)),
        attempts: Number(row.attempts),
        lastError: row.lastError == null ? null : String(row.lastError),
      }));
  }

  async function run()                                             {
    if (steps.length === 0) return [];
    for (const step of steps) {
      await writeCoordinator.run(async () => {
        const handle = resolveDb();
        handle.exec(DDL);
        const prior = handle.prepare(`SELECT state, progress, attempts FROM ${SCHEMA_MAINTENANCE_TABLE} WHERE id = ?`).get(step.id)                                       ;
        if (prior?.state === 'completed') return;
        const progress = prior ? decodeProgress(prior.progress, step.id) : null;
        const attempts = Number(prior?.attempts ?? 0) + 1;
        handle.prepare(`INSERT INTO ${SCHEMA_MAINTENANCE_TABLE} (id, description, state, progress, attempts, lastError)
          VALUES (?, ?, 'running', ?, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET description = excluded.description, state = 'running', attempts = excluded.attempts, lastError = NULL`)
          .run(step.id, step.description, encodeProgress(progress), attempts);
        const context                           = Object.freeze({
          db: handle,
          progress,
          checkpoint(nextProgress         )       {
            handle.prepare(`UPDATE ${SCHEMA_MAINTENANCE_TABLE} SET progress = ? WHERE id = ?`).run(encodeProgress(nextProgress), step.id);
          },
          withForeignKeysDisabled: foreignKeys,
        });
        try {
          await step.run(context);
          handle.prepare(`UPDATE ${SCHEMA_MAINTENANCE_TABLE} SET state = 'completed', lastError = NULL WHERE id = ?`).run(step.id);
        } catch (error) {
          handle.prepare(`UPDATE ${SCHEMA_MAINTENANCE_TABLE} SET state = 'failed', lastError = ? WHERE id = ?`).run(messageOf(error), step.id);
          throw error;
        }
      });
    }
    return states();
  }

  return Object.freeze({ run, states });
}
