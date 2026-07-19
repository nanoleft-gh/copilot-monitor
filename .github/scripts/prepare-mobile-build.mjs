import fs from 'node:fs';

const appPath = 'app.json';
const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const app = JSON.parse(fs.readFileSync(appPath, 'utf8'));
if (app.expo?.version !== packageVersion) {
	throw new Error(`Mobile version mismatch: package.json=${packageVersion}, app.json=${app.expo?.version}.`);
}
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(packageVersion);
if (!match) {
	throw new Error(`Mobile version must use stable x.y.z SemVer; received ${packageVersion}.`);
}
const [, major, minor, patch] = match.map(Number);
if (minor > 999 || patch > 999) {
	throw new Error('Mobile minor and patch versions must remain below 1000.');
}
const buildVersion = major * 1_000_000 + minor * 1_000 + patch;
app.expo.android = { ...app.expo.android, versionCode: Math.max(1, buildVersion) };
app.expo.ios = { ...app.expo.ios, buildNumber: String(Math.max(1, buildVersion)) };
fs.writeFileSync(appPath, `${JSON.stringify(app, null, 2)}\n`);
console.log(`Prepared mobile ${packageVersion} with build number ${Math.max(1, buildVersion)}.`);