// svelte-loader.mjs — Node --import hook that compiles .svelte files on the fly.
// Usage: node --import ./test/svelte-loader.mjs --test test/workbench-ui.test.mjs
//
// Uses Node's Module.register() API to intercept .svelte imports and compile
// them with svelte/compiler before evaluation.

import { register } from 'node:module';
import { compile } from 'svelte/compiler';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

register('./svelte-loader-hook.mjs', import.meta.url);
