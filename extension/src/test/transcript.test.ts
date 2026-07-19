import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	mergeTranscriptSupplement,
	normalizeTranscript,
	parseCopilotTranscriptLog,
	parseMutationLog,
	parseMutationLogSnapshot,
} from '../transcript';

describe('parseMutationLog', () => {
	it('reconstructs set, append, splice, truncate, and delete entries', () => {
		const content = [
			{ kind: 0, v: { sessionId: 'session-1', requests: [], metadata: { stale: true } } },
			{ kind: 1, k: ['customTitle'], v: 'Live session' },
			{ kind: 2, k: ['requests'], v: [{ requestId: 'one', response: [] }] },
			{ kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'draft' }] },
			{ kind: 2, k: ['requests', 0, 'response'], i: 0, v: [{ value: 'final' }] },
			{ kind: 2, k: ['requests', 0, 'response'], i: 0 },
			{ kind: 3, k: ['metadata'] },
		].map(value => JSON.stringify(value)).join('\n');

		assert.deepEqual(parseMutationLog(content), {
			sessionId: 'session-1',
			requests: [{ requestId: 'one', response: [] }],
			customTitle: 'Live session',
			metadata: undefined,
		});
	});

	it('ignores a partially written final line', () => {
		const content = `${JSON.stringify({ kind: 0, v: { sessionId: 'safe' } })}\n{"kind":1`;
		assert.equal(parseMutationLog(content).sessionId, 'safe');
		const snapshot = parseMutationLogSnapshot(content);
		assert.equal(snapshot.state.sessionId, 'safe');
		assert.equal(snapshot.complete, false);
	});

	it('marks a fully written final entry as complete', () => {
		const content = [
			{ kind: 0, v: { sessionId: 'complete' } },
			{ kind: 1, k: ['customTitle'], v: 'Ready' },
		].map(value => JSON.stringify(value)).join('\n');
		const snapshot = parseMutationLogSnapshot(content);
		assert.equal(snapshot.complete, true);
		assert.equal(snapshot.state.customTitle, 'Ready');
	});
});

describe('normalizeTranscript', () => {
	it('extracts user, assistant, tool, thinking, and live status data', () => {
		const transcript = normalizeTranscript({
			sessionId: 'session-1',
			customTitle: 'Parser task',
			requests: [{
				requestId: 'request-1',
				timestamp: 123,
				message: { text: 'User: Fix the parser' },
				modelState: { value: 0 },
				response: [
					{ kind: 'thinking', value: '**Plan**\n\nInspect the parser first.', id: 't1', generatedTitle: 'Planning the fix' },
					{ kind: 'thinking', value: '', id: '', metadata: { vscodeReasoningDone: true } },
					{ value: 'Working on it.' },
					{
						kind: 'toolInvocationSerialized',
						toolCallId: 'call-1',
						invocationMessage: { value: 'Reading parser.ts' },
						isComplete: false,
					},
				],
			}],
		});

		assert.equal(transcript.title, 'Parser task');
		assert.equal(transcript.status, 'working');
		assert.deepEqual(transcript.turns[0], {
			id: 'request-1',
			editable: true,
			timestamp: 123,
			userText: 'Fix the parser',
			thinking: '**Plan**\n\nInspect the parser first.',
			thinkingTitle: 'Planning the fix',
			assistantText: 'Working on it.',
			activities: [{ id: 'call-1', label: 'Reading parser.ts', status: 'running' }],
			blocks: [
				{ kind: 'thinking', text: '**Plan**\n\nInspect the parser first.', title: 'Planning the fix' },
				{ kind: 'text', text: 'Working on it.' },
				{ kind: 'activity', activity: { id: 'call-1', label: 'Reading parser.ts', status: 'running' } },
			],
			status: 'working',
			completedAt: undefined,
		});
	});

	it('does not expose generated fallback request ids as editable', () => {
		const transcript = normalizeTranscript({
			sessionId: 'legacy-session',
			requests: [{ message: { text: 'Legacy prompt' }, response: [] }],
		});
		assert.equal(transcript.turns[0].id, 'request-0');
		assert.equal(transcript.turns[0].editable, false);
	});

	it('extracts pending approval and live terminal output metadata', () => {
		const transcript = normalizeTranscript({
			sessionId: 'terminal-session',
			requests: [{
				requestId: 'request-terminal',
				timestamp: 500,
				message: { text: 'Check git' },
				modelState: { value: 0 },
				response: [{
					kind: 'toolInvocationSerialized',
					toolCallId: 'call-git',
					toolId: 'run_in_terminal',
					isComplete: true,
					invocationMessage: { value: 'Running `git status`' },
					toolSpecificData: {
						kind: 'terminal',
						commandLine: { original: 'git status', forDisplay: 'git status' },
						cwd: { fsPath: 'C:\\code\\project' },
						confirmation: { commandLine: 'git status' },
						terminalCommandOutput: { text: '\u001b[32mworking\u001b[0m\r\n', lineCount: 1 },
					},
				}],
			}],
		});

		assert.deepEqual(transcript.turns[0].activities, [{
			id: 'call-git',
			label: 'Running `git status`',
			status: 'waiting',
			toolId: 'run_in_terminal',
			command: 'git status',
			cwd: 'C:\\code\\project',
			output: 'working',
			outputTruncated: false,
			outputLineCount: 1,
			exitCode: undefined,
			durationMs: undefined,
			canApprove: true,
		}]);
	});

	it('keeps terminal output running until an exit code is recorded', () => {
		const transcript = normalizeTranscript({
			sessionId: 'running-terminal',
			requests: [{
				requestId: 'request-running',
				message: { text: 'Run a slow command' },
				modelState: { value: 0 },
				response: [{
					kind: 'toolInvocationSerialized',
					toolCallId: 'call-running',
					toolId: 'run_in_terminal',
					isConfirmed: { type: 4 },
					isComplete: true,
					invocationMessage: { value: 'Running command' },
					toolSpecificData: {
						kind: 'terminal',
						commandLine: { original: 'slow-command' },
						terminalCommandState: { exitCode: undefined, timestamp: 100, duration: 0 },
						terminalCommandOutput: { text: 'first line\r\n', lineCount: 1 },
					},
				}],
			}],
		});

		assert.equal(transcript.turns[0].activities[0].status, 'running');
		assert.equal(transcript.turns[0].activities[0].output, 'first line');
		assert.equal(transcript.turns[0].activities[0].durationMs, 0);
	});

	it('merges Copilot transcript completion ahead of delayed session persistence', () => {
		const transcript = normalizeTranscript({
			sessionId: 'session-1',
			requests: [{
				requestId: 'request-1',
				message: { text: 'Explain ArrayList' },
				modelState: { value: 0 },
				response: [{ value: 'An ArrayList is' }],
			}],
		});
		const supplement = parseCopilotTranscriptLog([
			{ type: 'user.message', data: { content: 'Explain ArrayList' }, timestamp: '2026-07-15T13:30:35.505Z' },
			{ type: 'assistant.turn_start', data: { turnId: '0' }, timestamp: '2026-07-15T13:30:37.277Z' },
			{
				type: 'assistant.message',
				data: { content: 'An ArrayList is a resizable array.', reasoningText: 'Preparing the explanation.' },
				timestamp: '2026-07-15T13:30:54.237Z',
			},
			{ type: 'assistant.turn_end', data: { turnId: '0' }, timestamp: '2026-07-15T13:30:54.237Z' },
		].map(value => JSON.stringify(value)).join('\n'));

		const merged = mergeTranscriptSupplement(transcript, supplement);
		assert.equal(merged.status, 'idle');
		assert.equal(merged.turns[0].assistantText, 'An ArrayList is a resizable array.');
		assert.equal(merged.turns[0].thinking, 'Preparing the explanation.');
		assert.equal(merged.turns[0].status, 'completed');
		assert.equal(merged.turns[0].completedAt, Date.parse('2026-07-15T13:30:54.237Z'));
	});
});