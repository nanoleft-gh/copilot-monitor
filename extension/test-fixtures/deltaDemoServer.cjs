// Manual/e2e harness: serves the real dashboard from a GatewayServer over a scripted backend
// that streams changes, so the v2 client path can be exercised in a browser.
const fs = require('node:fs');
const path = require('node:path');
const { GatewayServer } = require(path.join(__dirname, '..', 'out', 'gatewayServer.js'));

const html = fs.readFileSync(path.join(__dirname, '..', 'media', 'dashboard.html'), 'utf8');
const mermaidScript = fs.readFileSync(path.join(__dirname, '..', 'media', 'vendor', 'mermaid-11.16.0.min.js'), 'utf8');

let listener;
let tick = 0;
let nextTurnNumber = 1;
const turns = [];
function makeTurn() {
	const index = nextTurnNumber++;
	return {
		id: `request-${index}`,
		editable: true,
		timestamp: Date.now(),
		userText: `Question number ${index}`,
		thinking: '',
		thinkingTitle: '',
		assistantText: '',
		activities: [],
		blocks: [],
		status: 'working',
	};
}
turns.push(makeTurn());

function state() {
	const session = {
		resource: 'vscode-chat-session://local/abc',
		sessionId: 'abc',
		title: 'Delta demo chat',
		status: turns[turns.length - 1].status === 'working' ? 'working' : 'idle',
		revision: `rev-${turns.length}`,
		updatedAt: Date.now(),
		turns,
		turnCount: turns.length,
		permissionLevel: 'default',
	};
	return {
		version: 2,
		gatewayStartedAt: 1,
		windows: [{
			version: 1,
			windowId: 'window-demo',
			workspaceName: 'Demo workspace',
			workspaceFolders: ['C:\\demo'],
			startedAt: 1,
			models: [],
			sessions: [session],
			activeSessionResource: session.resource,
			outboundMessages: [],
			connected: true,
			heartbeatAt: 1,
		}],
	};
}

const backend = {
	getState: state,
	onDidChange(fn) { listener = fn; return { dispose() { listener = undefined; } }; },
	async sendMessage(r) { turns.push({ ...makeTurn(), userText: r.text }); listener?.(state()); return { id: r.id, accepted: true }; },
	async editTurn(r) { return { id: r.id, accepted: true }; },
	async selectSession() {}, async syncSession() {}, async loadHistory() { return { turns: [], totalCount: turns.length, start: 0, end: 0, hasEarlier: false, revision: 'r' }; },
	async selectModel() {}, async configureModel() {}, async renameSession() {}, async createSession() { return { sessionResource: 'x' }; },
	async setPermissionLevel() {}, async decideTool() {},
	setEventClientCount(count) { console.log('viewers', count); },
};

const server = new GatewayServer(backend, { host: '127.0.0.1', advertisedHost: '127.0.0.1', port: Number(process.env.PORT || 43999), registryId: 'demo', html, mermaidScript });
server.start().then(address => {
	console.log('listening', address.url);
	setInterval(() => {
		tick++;
		const last = turns[turns.length - 1];
		if (last.status === 'working') {
			last.assistantText += `Streamed chunk ${tick}. `;
			last.blocks = [{ kind: 'text', text: last.assistantText }];
			if (tick % 6 === 0) { last.status = 'completed'; last.completedAt = Date.now(); }
		} else if (tick % 9 === 0) {
			turns.push(makeTurn());
			if (turns.length > 5) { turns.shift(); }
		}
		listener?.(state());
	}, 1000);
});
