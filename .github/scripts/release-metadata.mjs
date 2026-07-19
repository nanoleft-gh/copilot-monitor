import fs from 'node:fs';
import path from 'node:path';

const component = process.argv[2];
const root = process.cwd();
const definitions = {
	extension: {
		version: readExtensionVersion,
		tagPrefix: 'extension-v',
		name: 'Copilot Monitor Extension',
		changelog: 'extension/CHANGELOG.md',
	},
	android: {
		version: readMobileVersion,
		tagPrefix: 'android-v',
		name: 'Copilot Monitor Android',
		changelog: 'mobile/CHANGELOG.md',
	},
	ios: {
		version: readMobileVersion,
		tagPrefix: 'ios-v',
		name: 'Copilot Monitor iOS',
		changelog: 'mobile/CHANGELOG.md',
	},
};

const definition = definitions[component];
if (!definition) {
	throw new Error(`Unknown release component: ${component ?? '(missing)'}`);
}

const version = definition.version();
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
	throw new Error(`${component} version must use stable x.y.z SemVer; received ${JSON.stringify(version)}.`);
}

const metadata = {
	component,
	version,
	tag: `${definition.tagPrefix}${version}`,
	releaseName: `${definition.name} v${version}`,
	changelog: definition.changelog,
};

for (const [key, value] of Object.entries(metadata)) {
	console.log(`${key}=${value}`);
}
if (process.env.GITHUB_OUTPUT) {
	fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(metadata).map(([key, value]) => `${key}=${value}\n`).join(''));
}

function readMobileVersion() {
	const packageVersion = readJson('mobile/package.json').version;
	const app = readJson('mobile/app.json');
	const appVersion = app.expo?.version;
	if (packageVersion !== appVersion) {
		throw new Error(`Mobile version mismatch: package.json=${packageVersion}, app.json=${appVersion}.`);
	}
	if (!app.expo?.extra?.eas?.projectId) {
		throw new Error('Mobile app is not linked to an EAS project. Run eas init from mobile/.');
	}
	return packageVersion;
}

function readExtensionVersion() {
	const packageVersion = readJson('extension/package.json').version;
	const lockfile = readJson('extension/package-lock.json');
	const lockVersions = [lockfile.version, lockfile.packages?.['']?.version];
	if (lockVersions.some((version) => version !== packageVersion)) {
		throw new Error(`Extension version mismatch: package.json=${packageVersion}, package-lock.json=${lockVersions.join('/')}.`);
	}
	return packageVersion;
}

function readJson(relativePath) {
	return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}