import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { GoogleDocsAssertionError, GoogleDocsScriptError, parseGoogleDocsScript, runGoogleDocsScript } from './google-docs-runner.mjs';

const SCRIPT = `
URL https://docs.google.com/document/d/example/edit
START_WAIT 0ms
WAIT 10ms
ACTOR A TAB 1
ACTOR B TAB 2

A TEXT "hello!"
A SHIFT+LEFT
PARALLEL
  A LEFT
  B TEXT "other actor"
END
ASSERT A title = "Fake document"
EXPORT state.json
`;

function makeFakeBrowser() {
	const pages = [];
	const inputs = [];
	function page() {
		let text = '';
		return {
			url: async () => 'https://docs.google.com/document/d/example/edit',
			title: async () => 'Fake document',
			goto: async () => {},
			locator: () => ({
				ariaSnapshot: async () => `- textbox "Document content": ${text}`,
				innerText: async () => text,
				click: async () => {}
			}),
			getByRole: () => ({ count: async () => 0, click: async () => {} }),
			evaluate: async () => ({ text: '', anchorOffset: 0, focusOffset: 0, activeRole: 'textbox', activeLabel: 'Document content' }),
			keyboard: {
				type: async (value) => {
					text += value;
					inputs.push({ type: 'text', value });
				},
				press: async (value) => {
					inputs.push({ type: 'key', value });
				}
			}
		};
	}
	return {
		pages,
		inputs,
		newContext: async () => ({
			newPage: async () => {
				const value = page();
				pages.push(value);
				return value;
			}
		})
	};
}

test('parses URL, default wait, actors, parallel actions, assertions, and exports', () => {
	const script = parseGoogleDocsScript(SCRIPT);
	assert.equal(script.url, 'https://docs.google.com/document/d/example/edit');
	assert.equal(script.defaultWaitMs, 10);
	assert.equal(script.startWaitMs, 0);
	assert.deepEqual(script.actors, [{ id: 'A', tab: 1 }, { id: 'B', tab: 2 }]);
	assert.equal(script.steps[2].type, 'parallel');
	assert.equal(script.steps.at(-1).type, 'export');
});

test('defaults to a 2s startup wait and 80ms between inputs', async () => {
	const waits = [];
	const source = `
URL https://docs.google.com/document/d/example/edit
ACTOR A TAB 1
A TYPE "x"
`;
	const script = parseGoogleDocsScript(source);
	assert.equal(script.startWaitMs, 2_000);
	assert.equal(script.defaultWaitMs, 80);
	await runGoogleDocsScript(script, {
		browser: makeFakeBrowser(),
		outputDir: '/tmp/google-docs-runner-test',
		wait: async (durationMs) => waits.push(durationMs)
	});
	assert.deepEqual(waits, [2_000, 80]);
});

test('parses quick typing, comments, and placeholders', () => {
	const script = parseGoogleDocsScript(`
URL https://docs.google.com/document/d/example/edit
START_WAIT 0ms
ACTOR A TAB 1
A TYPE "hello"
A COMMENT "review this"
A INSERT_SMART_CHIP
`);
	assert.deepEqual(script.steps.map((step) => step.action), [
		{ type: 'text', value: 'hello' },
		{ type: 'comment', value: 'review this' },
		{ type: 'placeholder' }
	]);
});

test('parses compact repeated key and modified-key commands', () => {
	const script = parseGoogleDocsScript(`
URL https://docs.google.com/document/d/example/edit
ACTOR A TAB 1
A LEFT 4
A SHIFT+RIGHT 3
`);
	assert.deepEqual(script.steps.map((step) => step.action), [
		{ type: 'key', keys: ['ArrowLeft'], source: 'LEFT', repeat: 4 },
		{ type: 'key', keys: ['Shift', 'ArrowRight'], source: 'SHIFT+RIGHT', repeat: 3 }
	]);
});

test('records each repeated key as its own state transition', async () => {
	const browser = makeFakeBrowser();
	const source = `
URL https://docs.google.com/document/d/example/edit
START_WAIT 0ms
WAIT 0ms
ACTOR A TAB 1
A ALT+LEFT 3
`;
	const result = await runGoogleDocsScript(source, { browser, outputDir: '/tmp/google-docs-runner-test' });
	assert.deepEqual(result.recording.map((entry) => entry.key), ['Alt+ArrowLeft', 'Alt+ArrowLeft', 'Alt+ArrowLeft']);
	assert.deepEqual(result.recording.map((entry) => entry.state.step), [1, 2, 3]);
});

test('quick actions record every represented key', async () => {
	const browser = makeFakeBrowser();
	const source = `
URL https://docs.google.com/document/d/example/edit
START_WAIT 0ms
WAIT 0ms
ACTOR A TAB 1
A TYPE "hi"
A COMMENT "ok"
A INSERT_SMART_CHIP
`;
	const result = await runGoogleDocsScript(source, { browser, outputDir: '/tmp/google-docs-runner-test' });
	assert.deepEqual(result.recording.map((entry) => entry.key), [
		'h', 'i', 'Meta+Alt+M', 'o', 'k', 'Meta+Enter', ' ', '@',
		'p', 'l', 'a', 'c', 'e', 'h', 'o', 'l', 'd', 'e', 'r', 'Enter', 'Enter'
	]);
	assert.equal(result.recording.every((entry) => entry.kind === 'keypress'), true);
	assert.deepEqual(browser.inputs.map((input) => input.value), result.recording.map((entry) => entry.key));
});

test('applies startup and default waits around every typed input', async () => {
	const waits = [];
	const source = `
URL https://docs.google.com/document/d/example/edit
START_WAIT 7ms
WAIT 3ms
ACTOR A TAB 1
A TYPE "hi"
`;
	await runGoogleDocsScript(source, {
		browser: makeFakeBrowser(),
		outputDir: '/tmp/google-docs-runner-test',
		wait: async (durationMs) => waits.push(durationMs)
	});
	assert.deepEqual(waits, [7, 3, 3]);
});

test('expands comment and smart-chip macros inside parallel blocks', async () => {
	const browser = makeFakeBrowser();
	const source = `
URL https://docs.google.com/document/d/example/edit
START_WAIT 0ms
WAIT 0ms
ACTOR A TAB 1
ACTOR B TAB 2
PARALLEL
  A COMMENT "x"
  B INSERT_SMART_CHIP
END
`;
	const result = await runGoogleDocsScript(source, { browser, outputDir: '/tmp/google-docs-runner-test' });
	const keysByActor = Object.groupBy(
		result.recording.filter((entry) => entry.parallel && entry.key),
		(entry) => entry.actorId
	);
	assert.deepEqual(keysByActor.A.map((entry) => entry.key), ['Meta+Alt+M', 'x', 'Meta+Enter']);
	assert.deepEqual(keysByActor.B.map((entry) => entry.key), [
		' ', '@', 'p', 'l', 'a', 'c', 'e', 'h', 'o', 'l', 'd', 'e', 'r', 'Enter', 'Enter'
	]);
});

test('records concurrent actors as one atomic state transition per input round', async () => {
	const browser = makeFakeBrowser();
	const source = `
URL https://docs.google.com/document/d/example/edit
START_WAIT 0ms
WAIT 0ms
ACTOR A TAB 1
ACTOR B TAB 2
CONCURRENT
  A TYPE "ab"
  B TYPE "xy"
END
`;
	const result = await runGoogleDocsScript(source, { browser, outputDir: '/tmp/google-docs-runner-test' });
	assert.deepEqual(result.recording.map((entry) => entry.inputs.map((input) => [input.actorId, input.key])), [
		[['A', 'a'], ['B', 'x']],
		[['A', 'b'], ['B', 'y']]
	]);
	assert.deepEqual(result.recording.map((entry) => entry.state.step), [1, 2]);
});

test('requires URL first and rejects undeclared actors', () => {
	assert.throws(() => parseGoogleDocsScript('WAIT 10ms\nURL https://example.com\nACTOR A TAB 1\nA TEXT x'), GoogleDocsScriptError);
	assert.throws(() => parseGoogleDocsScript('URL https://example.com\nB TEXT x'), GoogleDocsScriptError);
});

test('runs each declared tab and records actions after execution', async () => {
	const browser = makeFakeBrowser();
	const result = await runGoogleDocsScript(SCRIPT, { browser, outputDir: '/tmp/google-docs-runner-test' });
	assert.equal(browser.pages.length, 2);
	assert.equal(result.recording.filter((entry) => entry.kind === 'keypress').length, 19);
	assert.equal(result.recording.find((entry) => entry.kind === 'parallel').actions.length, 2);
	assert.deepEqual(
		result.recording.filter((entry) => entry.parallel && entry.kind === 'keypress').map((entry) => [entry.actorId, entry.key]),
		[['A', 'ArrowLeft'], ['B', 'o'], ['B', 't'], ['B', 'h'], ['B', 'e'], ['B', 'r'], ['B', ' '], ['B', 'a'], ['B', 'c'], ['B', 't'], ['B', 'o'], ['B', 'r']]
	);
	const exported = JSON.parse(await readFile('/tmp/google-docs-runner-test/state.json', 'utf8'));
	assert.deepEqual(Object.keys(exported.actors).sort(), ['A', 'B']);
	assert.equal(exported.recording.length, 21);
});

test('fails assertions with actor and state path details', async () => {
	const browser = makeFakeBrowser();
	const source = 'URL https://example.com\nSTART_WAIT 0ms\nACTOR A TAB 1\nASSERT A title = "wrong"';
	await assert.rejects(() => runGoogleDocsScript(source, { browser, outputDir: '/tmp/google-docs-runner-test' }), GoogleDocsAssertionError);
});
