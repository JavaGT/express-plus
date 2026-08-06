#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_WAIT_MS = 80;
const DEFAULT_START_WAIT_MS = 2_000;
const MAX_EVIDENCE_LENGTH = 12_000;
const KEY_ALIASES = new Map([
	['CMD', 'Meta'],
	['CTRL', 'Control'],
	['CONTROL', 'Control'],
	['ALT', 'Alt'],
	['OPTION', 'Alt'],
	['SHIFT', 'Shift'],
	['META', 'Meta'],
	['ENTER', 'Enter'],
	['RETURN', 'Enter'],
	['BACKSPACE', 'Backspace'],
	['DELETE', 'Delete'],
	['DEL', 'Delete'],
	['LEFT', 'ArrowLeft'],
	['RIGHT', 'ArrowRight'],
	['UP', 'ArrowUp'],
	['DOWN', 'ArrowDown'],
	['HOME', 'Home'],
	['END', 'End'],
	['TAB', 'Tab'],
	['ESC', 'Escape'],
	['ESCAPE', 'Escape'],
	['SPACE', 'Space'],
	['PAGEUP', 'PageUp'],
	['PAGEDOWN', 'PageDown']
]);
const VALID_SINGLE_KEYS = /^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/;

export class GoogleDocsScriptError extends Error {
	constructor(message, lineNumber) {
		super(lineNumber ? `Line ${lineNumber}: ${message}` : message);
		this.name = 'GoogleDocsScriptError';
		this.lineNumber = lineNumber;
	}
}

export class GoogleDocsAssertionError extends Error {
	constructor({ actorId, path, expected, actual, step }) {
		super(`Step ${step}: ${actorId}.${path} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
		this.name = 'GoogleDocsAssertionError';
		this.actorId = actorId;
		this.path = path;
		this.expected = expected;
		this.actual = actual;
		this.step = step;
	}
}

function parseDuration(value, lineNumber) {
	const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value);
	if (!match) throw new GoogleDocsScriptError(`Invalid duration ${JSON.stringify(value)}; use ms or s`, lineNumber);
	const duration = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
	if (!Number.isFinite(duration) || duration < 0) throw new GoogleDocsScriptError('Duration must be non-negative', lineNumber);
	return duration;
}

function parseQuotedOrRaw(value, lineNumber) {
	const trimmed = value.trim();
	if (!trimmed) throw new GoogleDocsScriptError('Expected a value', lineNumber);
	if (trimmed.startsWith('"')) {
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed !== 'string') throw new Error('not a string');
			return parsed;
		} catch {
			throw new GoogleDocsScriptError('Invalid quoted string', lineNumber);
		}
	}
	return trimmed;
}

function parseExpectedValue(value, lineNumber) {
	const trimmed = value.trim();
	if (trimmed.startsWith('"')) return parseQuotedOrRaw(trimmed, lineNumber);
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	if (trimmed === 'null') return null;
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
	return trimmed;
}

function parseKeyCombo(value, lineNumber) {
	const parts = value.split('+').map((part) => part.trim().toUpperCase());
	if (parts.some((part) => !part)) throw new GoogleDocsScriptError(`Invalid key combo ${JSON.stringify(value)}`, lineNumber);
	return parts.map((part) => {
		if (KEY_ALIASES.has(part)) return KEY_ALIASES.get(part);
		if (VALID_SINGLE_KEYS.test(part)) return part;
		throw new GoogleDocsScriptError(`Unknown key ${JSON.stringify(part)}`, lineNumber);
	});
}

function parseActorDeclaration(line, lineNumber) {
	const match = /^ACTOR\s+([A-Za-z][\w-]*)\s+TAB\s+(\d+)$/i.exec(line);
	if (!match) throw new GoogleDocsScriptError('Expected ACTOR <id> TAB <number>', lineNumber);
	const tab = Number(match[2]);
	if (tab < 1) throw new GoogleDocsScriptError('Tab number must be at least 1', lineNumber);
	return { id: match[1], tab };
}

function parseActorCommand(line, lineNumber, actors) {
	const match = /^([A-Za-z][\w-]*)\s+(.+)$/.exec(line);
	if (!match) throw new GoogleDocsScriptError('Expected an actor-qualified command', lineNumber);
	const actorId = match[1];
	if (!actors.has(actorId)) throw new GoogleDocsScriptError(`Actor ${JSON.stringify(actorId)} was not declared`, lineNumber);
	const command = match[2].trim();
	const textMatch = /^(?:TEXT|TYPE)\s+(.+)$/i.exec(command);
	if (textMatch) return { type: 'action', actorId, action: { type: 'text', value: parseQuotedOrRaw(textMatch[1], lineNumber) }, lineNumber };
	const commentMatch = /^(?:COMMENT|LEAVE_COMMENT)\s+(.+)$/i.exec(command);
	if (commentMatch) {
		return { type: 'action', actorId, action: { type: 'comment', value: parseQuotedOrRaw(commentMatch[1], lineNumber) }, lineNumber };
	}
	if (/^INSERT_SMART_CHIP$/i.test(command)) {
		return { type: 'action', actorId, action: { type: 'placeholder' }, lineNumber };
	}
	if (/^FOCUS$/i.test(command)) return { type: 'action', actorId, action: { type: 'focus' }, lineNumber };
	const exportMatch = /^EXPORT\s+(.+)$/i.exec(command);
	if (exportMatch) return { type: 'export', path: parseQuotedOrRaw(exportMatch[1], lineNumber), lineNumber, actorId };
	const assertMatch = /^ASSERT\s+([\w.]+)\s*(?:==|=)\s*(.+)$/i.exec(command);
	if (assertMatch) {
		return {
			type: 'assert',
			actorId,
			path: assertMatch[1],
			expected: parseExpectedValue(assertMatch[2], lineNumber),
			lineNumber
		};
	}
	const repeatedKeyMatch = /^(.+?)\s+(\d+)$/i.exec(command);
	const keySource = repeatedKeyMatch ? repeatedKeyMatch[1] : command;
	const repeat = repeatedKeyMatch ? Number(repeatedKeyMatch[2]) : 1;
	if (repeat < 1) throw new GoogleDocsScriptError('Key repeat count must be at least 1', lineNumber);
	return { type: 'action', actorId, action: { type: 'key', keys: parseKeyCombo(keySource, lineNumber), source: keySource, repeat }, lineNumber };
}

function parseBlock(lines, start, actors) {
	const steps = [];
	let index = start;
	for (; index < lines.length; index += 1) {
		const { line, lineNumber } = lines[index];
		if (/^END$/i.test(line)) return { steps, next: index + 1 };
		if (/^(?:PARALLEL|CONCURRENT|URL\s|ACTOR\s|WAIT\s|EXPORT\s|ASSERT\s)/i.test(line)) {
			throw new GoogleDocsScriptError('Parallel blocks may contain actor commands only', lineNumber);
		}
		steps.push(parseActorCommand(line, lineNumber, actors));
	}
	throw new GoogleDocsScriptError('PARALLEL block is missing END');
}

export function parseGoogleDocsScript(source, { sourceName = 'script.gauto' } = {}) {
	const lines = source
		.split(/\r?\n/)
		.map((raw, index) => ({ line: raw.trim(), lineNumber: index + 1 }))
		.filter(({ line }) => line && !line.startsWith('#'));
	if (lines.length === 0) throw new GoogleDocsScriptError(`${sourceName} is empty`);

	const first = lines[0];
	const urlMatch = /^URL\s+(.+)$/i.exec(first.line);
	if (!urlMatch) throw new GoogleDocsScriptError('The first directive must be URL <document-url>', first.lineNumber);
	let url;
	try {
		url = new URL(parseQuotedOrRaw(urlMatch[1], first.lineNumber)).toString();
	} catch {
		throw new GoogleDocsScriptError('URL must be valid', first.lineNumber);
	}

	const actors = new Map();
	const steps = [];
	let defaultWaitMs = DEFAULT_WAIT_MS;
	let startWaitMs = DEFAULT_START_WAIT_MS;
	let index = 1;
	let headerOpen = true;
	while (index < lines.length) {
		const { line, lineNumber } = lines[index];
		if (headerOpen && /^WAIT\s+/i.test(line)) {
			defaultWaitMs = parseDuration(line.replace(/^WAIT\s+/i, ''), lineNumber);
			index += 1;
			continue;
		}
		if (headerOpen && /^START_WAIT\s+/i.test(line)) {
			startWaitMs = parseDuration(line.replace(/^START_WAIT\s+/i, ''), lineNumber);
			index += 1;
			continue;
		}
		if (headerOpen && /^ACTOR\s+/i.test(line)) {
			const actor = parseActorDeclaration(line, lineNumber);
			if (actors.has(actor.id)) throw new GoogleDocsScriptError(`Actor ${JSON.stringify(actor.id)} is declared twice`, lineNumber);
			actors.set(actor.id, actor);
			index += 1;
			continue;
		}
		headerOpen = false;
		if (/^(?:PARALLEL|CONCURRENT)$/i.test(line)) {
			const block = parseBlock(lines, index + 1, actors);
			steps.push({ type: /^CONCURRENT$/i.test(line) ? 'concurrent' : 'parallel', steps: block.steps, lineNumber });
			index = block.next;
			continue;
		}
		if (/^END$/i.test(line)) throw new GoogleDocsScriptError('END has no matching PARALLEL', lineNumber);
		if (/^WAIT\s+/i.test(line)) {
			steps.push({ type: 'wait', durationMs: parseDuration(line.replace(/^WAIT\s+/i, ''), lineNumber), lineNumber });
			index += 1;
			continue;
		}
		const exportMatch = /^EXPORT\s+(.+)$/i.exec(line);
		if (exportMatch) {
			steps.push({ type: 'export', path: parseQuotedOrRaw(exportMatch[1], lineNumber), lineNumber });
			index += 1;
			continue;
		}
		const assertMatch = /^ASSERT\s+([A-Za-z][\w-]*)\s+([\w.]+)\s*(?:==|=)\s*(.+)$/i.exec(line);
		if (assertMatch) {
			const actorId = assertMatch[1];
			if (!actors.has(actorId)) throw new GoogleDocsScriptError(`Actor ${JSON.stringify(actorId)} was not declared`, lineNumber);
			steps.push({
				type: 'assert',
				actorId,
				path: assertMatch[2],
				expected: parseExpectedValue(assertMatch[3], lineNumber),
				lineNumber
			});
			index += 1;
			continue;
		}
		if (/^URL\s+|^ACTOR\s+/i.test(line)) throw new GoogleDocsScriptError('URL and ACTOR declarations must be at the start', lineNumber);
		steps.push(parseActorCommand(line, lineNumber, actors));
		index += 1;
	}

	if (actors.size === 0) throw new GoogleDocsScriptError('Declare at least one actor');
	if (steps.length === 0) throw new GoogleDocsScriptError('Script has no steps');
	return { sourceName, url, defaultWaitMs, startWaitMs, actors: [...actors.values()], steps };
}

function normalizeKeyCombo(keys) {
	return keys.join('+');
}

function statePath(state, path) {
	return path.split('.').reduce((value, key) => value?.[key], state);
}

function compactEvidence(value) {
	return String(value ?? '').slice(0, MAX_EVIDENCE_LENGTH);
}

function evidenceLines(value, pattern) {
	return String(value ?? '')
		.split('\n')
		.filter((line) => pattern.test(line))
		.slice(-40);
}

async function readAriaSnapshot(page) {
	try {
		const body = page.locator('body');
		if (typeof body.ariaSnapshot === 'function') return await body.ariaSnapshot();
	} catch {
		// Some Playwright-compatible adapters do not expose ariaSnapshot.
	}
	return '';
}

async function readBodyText(page) {
	try {
		return await page.locator('body').innerText({ timeout: 5_000 });
	} catch {
		return '';
	}
}

async function readNativeSelection(page) {
	try {
		return await page.evaluate(() => {
			const selection = globalThis.getSelection?.();
			const active = document.activeElement;
			return {
				text: selection?.toString() ?? '',
				anchorOffset: selection?.anchorOffset ?? null,
				focusOffset: selection?.focusOffset ?? null,
				activeRole: active?.getAttribute?.('role') ?? null,
				activeLabel: active?.getAttribute?.('aria-label') ?? null
			};
		});
	} catch {
		return { text: '', anchorOffset: null, focusOffset: null, activeRole: null, activeLabel: null };
	}
}

async function readGoogleDocsAccessibilityState(page) {
	try {
		return await page.evaluate(() => {
			const liveRegions = [...document.querySelectorAll('[aria-live]')]
				.map((element, index) => ({
					key: element.id || `${element.getAttribute('role') || 'live'}:${element.getAttribute('aria-live') || 'off'}:${index}`,
					politeness: element.getAttribute('aria-live'),
					role: element.getAttribute('role'),
					text: (element.innerText || element.textContent || '').trim()
				}))
				.filter((region) => region.text);
			const screenReaderRegion = liveRegions
				.filter((region) => region.politeness === 'polite')
				.sort((left, right) => right.text.length - left.text.length)[0] ?? null;
			const lines = screenReaderRegion?.text.split('\n').filter(Boolean) ?? [];
			return {
				liveRegions,
				screenReader: {
					text: screenReaderRegion?.text ?? '',
					lines,
					pageAnnouncements: lines.filter((line) => /^(?:On page|Page )/i.test(line)),
					selectionAnnouncements: lines.filter((line) => /selected|unselected|selection/i.test(line)),
					commentAnnouncements: lines.filter((line) => /comment/i.test(line)),
					smartChipAnnouncements: lines.filter((line) => /smart chip|placeholder|file chip/i.test(line)),
					latestAnnouncement: lines.at(-1) ?? null
				}
			};
		});
	} catch {
		return { liveRegions: [], screenReader: { text: '', lines: [], pageAnnouncements: [], selectionAnnouncements: [], commentAnnouncements: [], smartChipAnnouncements: [], latestAnnouncement: null } };
	}
}

async function readGoogleDocsComments(page) {
	try {
		return await page.evaluate(() => [...document.querySelectorAll('.docos')]
			.map((element) => ({
				role: element.getAttribute('role'),
				label: element.getAttribute('aria-label'),
				className: typeof element.className === 'string' ? element.className : '',
				text: (element.innerText || element.textContent || '').trim()
			}))
			.filter((entry) => entry.text || entry.label)
			.slice(0, 100));
	} catch {
		return [];
	}
}

async function readClipboardState(page) {
	try {
		return await page.evaluate(async () => {
			const items = await navigator.clipboard.read();
			const representations = {};
			for (const item of items) {
				for (const type of item.types) {
					if (type !== 'text/plain' && type !== 'text/html') continue;
					representations[type] = (await (await item.getType(type)).text()).slice(0, 12_000);
				}
			}
			return { available: true, representations };
		});
	} catch (error) {
		return { available: false, error: error instanceof Error ? error.message : String(error), representations: {} };
	}
}

function isClipboardAction(action) {
	return action.type === 'key' && action.keys.includes('Meta') && action.keys.some((key) => ['C', 'X', 'V'].includes(key));
}

export async function captureGoogleDocsPageState(page, { actorId, tab, step }) {
	const [url, title, ariaSnapshot, bodyText, nativeSelection, docsAccessibility, commentThreads] = await Promise.all([
		page.url(),
		page.title(),
		readAriaSnapshot(page),
		readBodyText(page),
		readNativeSelection(page),
		readGoogleDocsAccessibilityState(page),
		readGoogleDocsComments(page)
	]);
	const combined = `${ariaSnapshot}\n${bodyText}`;
	const screenReader = docsAccessibility?.screenReader ?? {
		text: '', lines: [], pageAnnouncements: [], selectionAnnouncements: [], commentAnnouncements: [], smartChipAnnouncements: [], latestAnnouncement: null
	};
	return {
		actor: actorId,
		tab,
		url,
		title,
		document: {
			text: null,
			selection: {
				text: nativeSelection.text,
				anchorOffset: nativeSelection.anchorOffset,
				focusOffset: nativeSelection.focusOffset,
				announcements: screenReader.selectionAnnouncements
			},
			caret: {
				logicalOffset: null,
				latestAnnouncement: screenReader.latestAnnouncement
			}
		},
		comments: {
			evidence: evidenceLines(combined, /comment/i),
			threads: Array.isArray(commentThreads) ? commentThreads : [],
			announcements: screenReader.commentAnnouncements
		},
		accessibility: {
			snapshot: compactEvidence(ariaSnapshot),
			documentEvidence: evidenceLines(ariaSnapshot, /Document content|Selected|Unselected/i),
			commentEvidence: evidenceLines(combined, /comment|Comment created/i),
			bodyText: compactEvidence(bodyText),
			liveRegions: Array.isArray(docsAccessibility?.liveRegions) ? docsAccessibility.liveRegions : [],
			screenReader
		}
	};
}

async function focusDocument(page) {
	try {
		const documentContent = page.getByRole('textbox', { name: 'Document content' });
		if (await documentContent.count()) {
			await documentContent.click();
			return;
		}
	} catch {
		// Fall through to the body click for compatible pages without getByRole.
	}
	await page.locator('body').click({ position: { x: 300, y: 300 } });
}

async function performAction(page, action) {
	if (action.type === 'focus') return focusDocument(page);
	if (action.type === 'text') return page.keyboard.type(action.value);
	if (action.type === 'key') return page.keyboard.press(normalizeKeyCombo(action.keys));
	throw new Error(`Unknown action type ${action.type}`);
}

function describeInput(action) {
	if (action.type === 'text') return { input: action.value, key: action.value };
	if (action.type === 'key') return { input: normalizeKeyCombo(action.keys), key: normalizeKeyCombo(action.keys) };
	return { input: action.type, key: null };
}

function expandAction(action) {
	if (action.type === 'text') return Array.from(action.value, (value) => ({ type: 'text', value }));
	if (action.type === 'comment') {
		return [
			{ type: 'key', keys: ['Meta', 'Alt', 'M'] },
			...Array.from(action.value, (value) => ({ type: 'text', value })),
			{ type: 'key', keys: ['Meta', 'Enter'] }
		];
	}
	if (action.type === 'placeholder') {
		return [
			{ type: 'text', value: ' ' },
			{ type: 'text', value: '@' },
			...Array.from('placeholder', (value) => ({ type: 'text', value })),
			{ type: 'key', keys: ['Enter'] },
			{ type: 'key', keys: ['Enter'] }
		];
	}
	if (action.type === 'key' && action.repeat > 1) {
		return Array.from({ length: action.repeat }, () => ({ ...action, repeat: 1 }));
	}
	return [action];
}

function isMacroAction(action) {
	return ['comment', 'placeholder'].includes(action.type);
}

async function captureRunState(pages, actorById, step, captureState) {
	const entries = await Promise.all([...actorById.values()].map(async (actor) => [
		actor.id,
		await captureState(pages.get(actor.id), { actorId: actor.id, tab: actor.tab, step })
	]));
	const actors = Object.fromEntries(entries);
	return { schema: 'google-docs-runner-state-v1', capturedAt: new Date().toISOString(), step, actors };
}

async function writeExport(outputDir, exportPath, state) {
	const target = isAbsolute(exportPath) ? exportPath : resolve(outputDir, exportPath);
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
	return target;
}

async function executeAssertion(step, state) {
	const actorState = state.actors[step.actorId];
	const actual = statePath(actorState, step.path);
	if (!Object.is(actual, step.expected)) throw new GoogleDocsAssertionError({ actorId: step.actorId, path: step.path, expected: step.expected, actual, step: state.step });
}

async function waitMs(durationMs) {
	if (durationMs > 0) await new Promise((resolveWait) => setTimeout(resolveWait, durationMs));
}

export async function runGoogleDocsScript(source, {
	browser,
	context: existingContext,
	outputDir = resolve(process.cwd(), 'test-results/google-docs-runner'),
	captureState = captureGoogleDocsPageState,
	onEvent = () => {},
	wait = waitMs,
	keepOpen = false
} = {}) {
	if (!existingContext && !browser?.newContext) throw new TypeError('runGoogleDocsScript requires a Playwright browser or context');
	const script = typeof source === 'string' ? parseGoogleDocsScript(source) : source;
	await mkdir(outputDir, { recursive: true });
	const context = existingContext ?? await browser.newContext();
	try {
		await context.grantPermissions?.(['clipboard-read', 'clipboard-write'], { origin: new URL(script.url).origin });
	} catch {
		// Attached Chrome contexts may not allow changing permissions; exports record the read error instead.
	}
	const pagesByTab = new Map();
	const pagesByActor = new Map();
	const actors = new Map(script.actors.map((actor) => [actor.id, actor]));
	for (const actor of script.actors) {
		if (!pagesByTab.has(actor.tab)) {
			const page = await context.newPage();
			await page.goto(script.url, { waitUntil: 'domcontentloaded' });
			pagesByTab.set(actor.tab, page);
		}
		pagesByActor.set(actor.id, pagesByTab.get(actor.tab));
	}
	await wait(script.startWaitMs);

	const recording = [];
	const exports = [];
	let step = 0;
	let lastState = await captureRunState(pagesByActor, actors, step, captureState);
	const event = async (record) => {
		const state = await captureRunState(pagesByActor, actors, ++step, captureState);
		for (const actorId of record.clipboardActorIds ?? []) {
			state.actors[actorId].clipboard = await readClipboardState(pagesByActor.get(actorId));
		}
		for (const actor of script.actors) {
			const previousText = lastState.actors[actor.id]?.accessibility?.screenReader?.text ?? '';
			const currentScreenReader = state.actors[actor.id]?.accessibility?.screenReader;
			if (!currentScreenReader) continue;
			const deltaText = currentScreenReader.text.startsWith(previousText)
				? currentScreenReader.text.slice(previousText.length).trim()
				: currentScreenReader.text;
			currentScreenReader.delta = deltaText ? deltaText.split('\n').filter(Boolean) : [];
		}
		const full = { ...record, step, state };
		lastState = full.state;
		recording.push(full);
		await onEvent(full);
		return full;
	};
	const exportState = async (exportPath) => {
		const exportStateValue = { ...lastState, export: exportPath, recordingLength: recording.length, recording: [...recording] };
		const target = await writeExport(outputDir, exportPath, exportStateValue);
		exports.push(target);
		return target;
	};

	const runAction = async (item) => {
		if (item.type === 'action') {
			const actions = expandAction(item.action);
			for (const [inputIndex, action] of actions.entries()) {
				await performAction(pagesByActor.get(item.actorId), action);
				await wait(script.defaultWaitMs);
				await event({
					kind: action.type === 'text' || action.type === 'key' ? 'keypress' : 'action',
					actorId: item.actorId,
					action,
					...describeInput(action),
					...(isMacroAction(item.action) ? { macro: item.action.type, macroIndex: inputIndex } : { inputIndex }),
					...(isClipboardAction(action) ? { clipboardActorIds: [item.actorId] } : {}),
					lineNumber: item.lineNumber
				});
			}
			return;
		}
		if (item.type === 'wait') {
			await wait(item.durationMs);
			await event({ kind: 'wait', durationMs: item.durationMs, lineNumber: item.lineNumber });
			return;
		}
		if (item.type === 'export') {
			const target = await exportState(item.path);
			await event({ kind: 'export', path: item.path, target, lineNumber: item.lineNumber });
			await wait(script.defaultWaitMs);
			return;
		}
		if (item.type === 'assert') {
			const state = await captureRunState(pagesByActor, actors, step, captureState);
			await executeAssertion(item, state);
			lastState = state;
			await event({ kind: 'assert', actorId: item.actorId, path: item.path, expected: item.expected, lineNumber: item.lineNumber });
			await wait(script.defaultWaitMs);
			return;
		}
		if (item.type === 'parallel') {
			const expandedSteps = item.steps.map((parallelStep) => ({
				...parallelStep,
				actions: expandAction(parallelStep.action)
			}));
			const rounds = Math.max(...expandedSteps.map((parallelStep) => parallelStep.actions.length));
			for (let inputIndex = 0; inputIndex < rounds; inputIndex += 1) {
				const round = expandedSteps.flatMap((parallelStep) => {
					const action = parallelStep.actions[inputIndex];
					return action ? [{ parallelStep, action }] : [];
				});
				for (const { parallelStep, action } of round) {
					await performAction(pagesByActor.get(parallelStep.actorId), action);
					await wait(script.defaultWaitMs);
					await event({
						kind: action.type === 'text' || action.type === 'key' ? 'keypress' : 'action',
						actorId: parallelStep.actorId,
						action,
						...describeInput(action),
						parallel: true,
						...(isMacroAction(parallelStep.action) ? { macro: parallelStep.action.type, macroIndex: inputIndex } : { inputIndex }),
						...(isClipboardAction(action) ? { clipboardActorIds: [parallelStep.actorId] } : {}),
						lineNumber: parallelStep.lineNumber
					});
				}
			}
			await event({
				kind: 'parallel',
				actions: item.steps.map((parallelStep) => ({ actorId: parallelStep.actorId, action: parallelStep.action, lineNumber: parallelStep.lineNumber })),
				lineNumber: item.lineNumber
			});
			await wait(script.defaultWaitMs);
			return;
		}
		if (item.type === 'concurrent') {
			const expandedSteps = item.steps.map((concurrentStep) => ({ ...concurrentStep, actions: expandAction(concurrentStep.action) }));
			const rounds = Math.max(...expandedSteps.map((concurrentStep) => concurrentStep.actions.length));
			for (let inputIndex = 0; inputIndex < rounds; inputIndex += 1) {
				const round = expandedSteps.flatMap((concurrentStep) => {
					const action = concurrentStep.actions[inputIndex];
					return action ? [{ concurrentStep, action }] : [];
				});
				await Promise.all(round.map(({ concurrentStep, action }) => performAction(pagesByActor.get(concurrentStep.actorId), action)));
				await wait(script.defaultWaitMs);
				await event({
					kind: 'concurrent-round',
					round: inputIndex,
					inputs: round.map(({ concurrentStep, action }) => ({ actorId: concurrentStep.actorId, action, ...describeInput(action) })),
					clipboardActorIds: round.filter(({ action }) => isClipboardAction(action)).map(({ concurrentStep }) => concurrentStep.actorId),
					lineNumber: item.lineNumber
				});
			}
			return;
		}
		throw new Error(`Unknown script step ${item.type}`);
	};

	for (const item of script.steps) await runAction(item);
	return { script, recording, exports, lastState, context, pagesByActor, keepOpen };
}

function parseCliArgs(argv) {
	const options = {
		scriptPath: null,
		outputDir: resolve(process.cwd(), 'test-results/google-docs-runner'),
		channel: 'chrome',
		keepOpen: false,
		userDataDir: null,
		profileDirectory: null,
		cdpUrl: null,
		url: null,
		pauseBeforeRun: false
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--output-dir') options.outputDir = resolve(argv[++index]);
		else if (arg === '--channel') options.channel = argv[++index];
		else if (arg === '--keep-open') options.keepOpen = true;
		else if (arg === '--user-data-dir') options.userDataDir = resolve(argv[++index]);
		else if (arg === '--profile-directory') options.profileDirectory = argv[++index];
		else if (arg === '--cdp-url') options.cdpUrl = argv[++index];
		else if (arg === '--url') options.url = new URL(argv[++index]).toString();
		else if (arg === '--pause-before-run') options.pauseBeforeRun = true;
		else if (arg === '--help' || arg === '-h') options.help = true;
		else if (!options.scriptPath) options.scriptPath = resolve(arg);
		else throw new Error(`Unknown argument ${arg}`);
	}
	if ((options.pauseBeforeRun || options.profileDirectory) && !options.userDataDir) {
		throw new Error('--pause-before-run and --profile-directory require --user-data-dir');
	}
	if (options.cdpUrl && options.userDataDir) throw new Error('--cdp-url cannot be combined with --user-data-dir');
	return options;
}

function usage() {
	return `Usage: node scripts/google-docs/google-docs-runner.mjs <file.gauto> [options]\n\nOptions:\n  --channel <name>          Playwright browser channel (default: chrome)\n  --output-dir <path>       Export directory (default: test-results/google-docs-runner)\n  --url <document-url>      Override the fixture URL without editing the file\n  --user-data-dir <path>    Use this persistent Playwright Chrome profile\n  --profile-directory <name> Select a profile within the user data directory\n  --cdp-url <url>           Attach to an already-running regular Chrome\n  --pause-before-run        Open the document and wait for manual sign-in\n  --keep-open               Leave visible Chrome open after the run\n`;
}

async function main() {
	const options = parseCliArgs(process.argv.slice(2));
	if (options.help || !options.scriptPath) {
		console.log(usage());
		return;
	}
	const source = await readFile(options.scriptPath, 'utf8');
	const parsedScript = parseGoogleDocsScript(source, { sourceName: options.scriptPath });
	const script = options.url ? { ...parsedScript, url: options.url } : parsedScript;
	const { chromium } = await import('@playwright/test');
	let browser;
	let persistentContext;
	let connectedBrowser;
	try {
		if (options.cdpUrl) {
			connectedBrowser = await chromium.connectOverCDP(options.cdpUrl);
			const connectedContext = connectedBrowser.contexts()[0];
			if (!connectedContext) throw new Error('The connected Chrome has no browser context');
			browser = { newContext: async () => connectedContext };
		} else if (options.userDataDir) {
			persistentContext = await chromium.launchPersistentContext(options.userDataDir, {
				channel: options.channel,
				headless: false,
				args: options.profileDirectory ? [`--profile-directory=${options.profileDirectory}`] : []
			});
			if (options.pauseBeforeRun) {
				const signInPage = await persistentContext.newPage();
				await signInPage.goto(script.url, { waitUntil: 'domcontentloaded' });
				console.log('Sign in to the document in the visible Chrome window, then press Enter here to run.');
				await new Promise((resolveInput) => process.stdin.once('data', resolveInput));
				await signInPage.close();
			}
			browser = { newContext: async () => persistentContext };
		} else {
			browser = await chromium.launch({ channel: options.channel, headless: false });
		}
		const result = await runGoogleDocsScript(script, {
			browser,
			outputDir: options.outputDir,
			onEvent: async (event) => console.log(JSON.stringify({
				step: event.step,
				kind: event.kind,
				actorId: event.actorId,
				key: event.key,
				input: event.input,
				macro: event.macro,
				path: event.path
			}))
		});
		console.log(JSON.stringify({
			url: result.script.url,
			actors: result.script.actors,
			actions: result.recording.length,
			exports: result.exports,
			outputDir: options.outputDir
		}, null, 2));
		if (options.keepOpen) {
			console.log('Chrome is left open. Press Enter here to close it.');
			await new Promise((resolveInput) => process.stdin.once('data', resolveInput));
		}
	} finally {
		if (persistentContext) await persistentContext.close();
		// A CDP connection to the user's regular Chrome must not call close(): that
		// would close their browser. The CLI process exit below releases the socket.
		else if (!connectedBrowser && browser) await browser.close();
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main().then(
		() => process.exit(0),
		(error) => {
			console.error(error.stack ?? error);
			process.exit(1);
		}
	);
}
