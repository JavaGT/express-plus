import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TODO_MODULE = fileURLToPath(new URL('../projects/todo.mjs', import.meta.url));

function importTodoDeclarations() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(new URL('../projects/todo.mjs', import.meta.url).href)})`,
    ], {
      env: { ...process.env, PORT: '0' },
      stdio: 'ignore',
    });

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ exited: false });
    }, 1_000);

    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ exited: true, code });
    });
  });
}

test('importing todo declarations does not start an application', async () => {
  const result = await importTodoDeclarations();
  assert.deepEqual(result, { exited: true, code: 0 }, `${TODO_MODULE} kept the process alive`);
});
