import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LiveTurnAccumulator, parseAgentResponse, relevantDebugLogTypes, sniffDebugLogType } from '../liveTurns';

const t0 = Date.parse('2026-09-21T20:05:48.000Z');
const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

function transcript(type: string, data: Record<string, unknown>, offsetMs: number): string {
	return JSON.stringify({ type, data, id: `${type}-${offsetMs}`, timestamp: iso(offsetMs), parentId: null });
}

function debug(type: string, attrs: Record<string, unknown>, offsetMs: number, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ts: t0 + offsetMs, dur: 0, sid: 'sid-1', type, name: type, spanId: `span-${offsetMs}`, status: 'ok', attrs, ...extra });
}

describe('LiveTurnAccumulator (transcript)', () => {
	it('builds a turn from user message through tool rounds to the final answer', () => {
		const live = new LiveTurnAccumulator();
		const lines = [
			transcript('session.start', { sessionId: 'sid-1', version: 1 }, 0),
			transcript('user.message', { content: 'Fix the tests', attachments: [] }, 10),
			transcript('assistant.turn_start', { turnId: '0' }, 20),
			transcript('assistant.message', {
				messageId: 'm1', content: 'Let me look.', reasoningText: 'Need to inspect files',
				toolRequests: [{ toolCallId: 'call_1', name: 'read_file', arguments: '{"filePath":"a.ts"}', type: 'function' }],
			}, 30),
			transcript('assistant.turn_end', { turnId: '0' }, 40),
			transcript('assistant.turn_start', { turnId: '1' }, 50),
			transcript('tool.execution_start', { toolCallId: 'call_1', toolName: 'read_file', arguments: { filePath: 'a.ts' } }, 60),
			transcript('tool.execution_complete', { toolCallId: 'call_1', success: true }, 70),
			transcript('assistant.message', { messageId: 'm2', content: 'Fixed it.', toolRequests: [] }, 80),
			transcript('assistant.turn_end', { turnId: '1' }, 90),
		];
		const changes = lines.map(line => live.applyTranscriptLine(line));
		assert.equal(live.observedSessionId, 'sid-1');
		assert.equal(live.turns.length, 1);
		const turn = live.turns[0];
		assert.equal(turn.userText, 'Fix the tests');
		assert.equal(turn.assistantText, 'Let me look.\n\nFixed it.');
		assert.equal(turn.thinking, 'Need to inspect files');
		assert.equal(turn.rounds, 2);
		assert.equal(turn.status, 'completed');
		assert.equal(turn.completedAt, t0 + 90);
		assert.deepEqual(turn.tools.map(tool => [tool.name, tool.status]), [['read_file', 'completed']]);
		assert.equal(turn.tools[0].startedAt, t0 + 60);
		assert.equal(turn.textTruncated, false);
		// Structural lines (session.start, turn_start, turn_end with tools) report no visible change.
		assert.deepEqual(changes, [false, true, false, true, false, false, true, true, true, true]);
	});

	it('keeps the turn working while tools are outstanding and matches ids with the __vscode suffix', () => {
		const live = new LiveTurnAccumulator();
		live.applyTranscriptLine(transcript('user.message', { content: 'User: go' }, 0));
		live.applyTranscriptLine(transcript('assistant.turn_start', { turnId: '0' }, 1));
		live.applyTranscriptLine(transcript('assistant.message', { content: '', toolRequests: [{ toolCallId: 'call_9', name: 'run_in_terminal', arguments: '{"command":"npm test"}' }] }, 2));
		live.applyTranscriptLine(transcript('assistant.turn_end', { turnId: '0' }, 3));
		live.applyTranscriptLine(transcript('assistant.turn_start', { turnId: '1' }, 4));
		live.applyTranscriptLine(transcript('tool.execution_start', { toolCallId: 'call_9__vscode-12', toolName: 'run_in_terminal', arguments: { command: 'npm test' } }, 5));
		const turn = live.latest!;
		assert.equal(turn.userText, 'go');
		assert.equal(turn.status, 'working');
		assert.equal(turn.tools.length, 1);
		assert.equal(turn.tools[0].status, 'running');
		assert.equal(turn.tools[0].argsPreview, '{"command":"npm test"}');
		live.applyTranscriptLine(transcript('tool.execution_complete', { toolCallId: 'call_9', success: false }, 6));
		assert.equal(live.latest!.tools[0].status, 'failed');
	});

	it('starts a new turn per user message and ignores malformed lines', () => {
		const live = new LiveTurnAccumulator();
		live.applyTranscriptLine(transcript('user.message', { content: 'one' }, 0));
		assert.equal(live.applyTranscriptLine('{"type":"user.message"'), false);
		live.applyTranscriptLine(transcript('user.message', { content: 'two' }, 1));
		assert.deepEqual(live.turns.map(turn => [turn.index, turn.userText]), [[0, 'one'], [1, 'two']]);
		live.reset();
		assert.equal(live.turns.length, 0);
	});

	it('collapses a replayed user message that had no assistant activity', () => {
		const live = new LiveTurnAccumulator();
		live.applyTranscriptLine(transcript('user.message', { content: 'same' }, 0));
		live.applyTranscriptLine(transcript('user.message', { content: 'same' }, 5));
		assert.equal(live.turns.length, 1);
		assert.equal(live.turns[0].startedAt, t0 + 5);
		live.applyTranscriptLine(transcript('assistant.turn_start', { turnId: '0' }, 6));
		live.applyTranscriptLine(transcript('user.message', { content: 'same' }, 7));
		assert.equal(live.turns.length, 2);
	});
});

describe('LiveTurnAccumulator (debug log)', () => {
	it('sniffs the type without parsing and lists which types matter', () => {
		const line = debug('llm_request', { inputMessages: 'x'.repeat(100_000) }, 0);
		assert.equal(sniffDebugLogType(line), 'llm_request');
		assert.equal(relevantDebugLogTypes.has('llm_request'), false);
		assert.equal(relevantDebugLogTypes.has('agent_response'), true);
		assert.equal(sniffDebugLogType('not json'), undefined);
	});

	it('reconstructs a turn from agent_response, hook and tool_call spans', () => {
		const live = new LiveTurnAccumulator();
		const response = JSON.stringify([{ role: 'assistant', parts: [
			{ type: 'text', content: 'Checking the browser.' },
			{ type: 'tool_call', id: 'call_ab', name: 'mcp_playwright_browser_run_code_unsafe', arguments: '{"code":"async (page) => 1"}' },
		] }]);
		live.applyDebugLogLine(debug('user_message', { content: 'complete this thing' }, 0));
		live.applyDebugLogLine(debug('turn_start', { turnId: '68' }, 1));
		live.applyDebugLogLine(debug('agent_response', { response, reasoning: 'Exploring options' }, 2));
		live.applyDebugLogLine(debug('turn_end', { turnId: '68' }, 3));
		live.applyDebugLogLine(debug('hook', { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp_playwright_browser_run_code_unsafe', tool_use_id: 'call_ab__vscode-3', tool_input: { code: 'x' } }), output: '{}' }, 4, { name: 'PreToolUse', dur: 937 }));
		let turn = live.latest!;
		assert.equal(turn.status, 'working');
		assert.equal(turn.assistantText, 'Checking the browser.');
		assert.equal(turn.thinking, 'Exploring options');
		assert.deepEqual(turn.tools.map(tool => [tool.name, tool.status]), [['mcp_playwright_browser_run_code_unsafe', 'running']]);

		live.applyDebugLogLine(debug('tool_call', { args: '{"code":"x"}', result: '### Error' }, 5, { name: 'mcp_playwright_browser_run_code_unsafe', dur: 34552 }));
		live.applyDebugLogLine(debug('turn_start', { turnId: '69' }, 6));
		live.applyDebugLogLine(debug('agent_response', { response: JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'Done.' }] }]) }, 7));
		live.applyDebugLogLine(debug('turn_end', { turnId: '69' }, 8));
		turn = live.latest!;
		assert.equal(turn.tools[0].status, 'completed');
		assert.equal(turn.tools[0].completedAt, t0 + 5 + 34552);
		assert.equal(turn.status, 'completed');
		assert.equal(turn.assistantText, 'Checking the browser.\n\nDone.');
		assert.equal(live.observedSessionId, 'sid-1');
	});

	it('recovers text and tool names from a truncated agent_response payload', () => {
		const full = JSON.stringify([{ role: 'assistant', parts: [
			{ type: 'text', content: 'A long explanation with \\"quotes\\" and\nnewlines.' },
			{ type: 'tool_call', id: 'call_z', name: 'create_file', arguments: '{"filePath":"x"}' },
		] }]);
		const cut = full.slice(0, full.length - 30);
		const parsed = parseAgentResponse(cut);
		assert.equal(parsed.truncated, true);
		assert.ok(parsed.text.startsWith('A long explanation'));
		assert.deepEqual(parsed.toolCalls.map(call => call.name), ['create_file']);

		const live = new LiveTurnAccumulator();
		live.applyDebugLogLine(debug('user_message', { content: 'q' }, 0));
		live.applyDebugLogLine(debug('agent_response', { response: cut }, 1));
		assert.equal(live.latest!.textTruncated, true);
	});

	it('records completion spans for tools that were never announced', () => {
		const live = new LiveTurnAccumulator();
		live.applyDebugLogLine(debug('user_message', { content: 'q' }, 0));
		live.applyDebugLogLine(debug('tool_call', { args: '{}' }, 1, { name: 'grep_search', dur: 12, status: 'error' }));
		assert.deepEqual(live.latest!.tools.map(tool => [tool.name, tool.status]), [['grep_search', 'failed']]);
	});
});
