import * as vscode from 'vscode';

export const liveExportScheme = 'copilot-monitor-live';
/** Large enough for long chats; the approval probe needs only the newest request of it. */
const maximumLiveExportBytes = 96 * 1024 * 1024;

export class LiveExportFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	private data: Uint8Array = new Uint8Array();
	private modifiedAt = Date.now();

	readonly onDidChangeFile = this.changeEmitter.event;

	watch(): vscode.Disposable {
		return { dispose() {} };
	}

	stat(): vscode.FileStat {
		return {
			type: vscode.FileType.File,
			ctime: this.modifiedAt,
			mtime: this.modifiedAt,
			size: this.data.byteLength,
		};
	}

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(): void {}

	readFile(): Uint8Array {
		return this.data;
	}

	reset(): void {
		this.data = new Uint8Array();
		this.modifiedAt = Date.now();
	}

	writeFile(uri: vscode.Uri, content: Uint8Array): void {
		this.data = content.byteLength <= maximumLiveExportBytes ? content : new Uint8Array();
		this.modifiedAt = Date.now();
		this.changeEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
	}

	delete(uri: vscode.Uri): void {
		this.data = new Uint8Array();
		this.modifiedAt = Date.now();
		this.changeEmitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
	}

	rename(): void {
		throw vscode.FileSystemError.NoPermissions('Rename is not supported.');
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}
}