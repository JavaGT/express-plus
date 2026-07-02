// todo-app.mjs — the todo demo, runnable.
//
// Start:  node todo-app.mjs
// then    curl http://localhost:3000/todos
//
// This wraps todo.mjs's entity declarations with DB setup, DDL auto-generation,
// and seed data so the demo works out of the box. The framework owns the auth,
// CRUD, error handling, and graceful shutdown — nothing to mount here.

import workbench, { User } from 'workbench';
import { config, generateDDL } from 'workbench/internal';

import { Todo, TodoList, SharedTodo } from './todo.mjs';
import { DatabaseSync } from 'node:sqlite';

// --- database setup ---

const db = new DatabaseSync('todo.db');
db.exec('PRAGMA journal_mode=WAL');

// Create system tables (User, Session) and product tables (Todo, TodoList, SharedTodo).
for (const stmt of [
  `CREATE TABLE IF NOT EXISTS User (
     id INTEGER PRIMARY KEY,
     username TEXT UNIQUE NOT NULL,
     password TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS Session (
     id INTEGER PRIMARY KEY,
     token TEXT UNIQUE NOT NULL,
     userId TEXT,
     principalType TEXT,
     principalId TEXT,
     kind TEXT,
     createdAt TEXT
   )`,
]) {
  db.exec(stmt);
}

for (const entity of [Todo, TodoList, SharedTodo]) {
  for (const sql of generateDDL(entity)) {
    db.exec(sql);
  }
}

// Seed a demo user (owner is auto-set from principal at create-time).
const existing = db.prepare('SELECT id FROM User WHERE username = ?').get('demo');
if (!existing) {
  db.exec("INSERT INTO User (id, username, password) VALUES (1, 'demo', '$2a$12$password-hash-placeholder')");
}

// --- app ---

const app = workbench({ db });

// Force a fixed principal for the demo (no login needed). In production this
// would come from session cookies via the session principal source.
const demoUser = { type: 'user', id: '1' };

app.mount('/todos', Todo)
   .mount('/lists', TodoList)
   .mount('/lists/:listId/items', SharedTodo);

app.listen(config.port, {
  principalOf: () => demoUser,
  onListening: () => {
    console.log(`todo-demo → http://localhost:${config.port}`);
    console.log(`  GET  /todos                      — list your todos`);
    console.log(`  POST /todos                      — create a todo`);
    console.log(`  GET  /todos/:id                  — read one todo`);
    console.log(`  PATCH /todos/:id                 — update a todo`);
    console.log(`  DELETE /todos/:id                — delete a todo`);
    console.log(`  GET  /lists                      — list your shared lists`);
    console.log(`  GET  /lists/:listId/items        — items in a shared list`);
    console.log(`  GET  /events (WebSocket)         — live updates`);
  },
});
