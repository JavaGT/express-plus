// svelte-loader-hook.mjs — The actual resolve/load hooks registered by svelte-loader.mjs.
//
// Intercepts .svelte imports and compiles them with svelte/compiler before
// evaluation. Non-.svelte imports pass through to the default resolver/loader.

import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.svelte')) {
    const resolved = await nextResolve(specifier, context);
    return {
      ...resolved,
      format: 'module',
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.svelte')) {
    return nextLoad(url, context);
  }

  const filePath = fileURLToPath(url);
  const source = readFileSync(filePath, 'utf-8');

  let compiled;
  try {
    compiled = compile(source, {
      filename: filePath,
      generate: 'client',
      dev: true,
    });
  } catch (err) {
    const message = err.message ? `${filePath}: ${err.message}` : `${filePath}: compilation failed`;
    throw new Error(message);
  }

  return {
    format: 'module',
    source: compiled.js.code,
    shortCircuit: true,
  };
}
