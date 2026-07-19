import fs from 'node:fs';

const [buildJsonPath, outputPath] = process.argv.slice(2);
if (!buildJsonPath) {
	throw new Error('Usage: eas-artifact.mjs <build-json> [github-output]');
}

const parsed = JSON.parse(fs.readFileSync(buildJsonPath, 'utf8'));
const build = Array.isArray(parsed) ? parsed[0] : parsed;
const artifactUrl = build?.artifacts?.applicationArchiveUrl ?? build?.artifacts?.buildUrl;
if (!build?.id || !artifactUrl) {
	throw new Error('EAS build JSON did not contain a build ID and application artifact URL.');
}

const values = { build_id: build.id, artifact_url: artifactUrl };
console.log(`build_id=${build.id}`);
if (outputPath) {
	fs.appendFileSync(outputPath, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
}