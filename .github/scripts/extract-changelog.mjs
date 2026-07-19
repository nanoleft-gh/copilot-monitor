import fs from 'node:fs';

const [changelogPath, version, outputPath] = process.argv.slice(2);
if (!changelogPath || !version || !outputPath) {
	throw new Error('Usage: extract-changelog.mjs <changelog> <version> <output>');
}

const content = fs.readFileSync(changelogPath, 'utf8').replace(/\r\n/g, '\n');
const heading = new RegExp(`^## \\[${escapeRegex(version)}\\]\\s*$`, 'm');
const match = heading.exec(content);
if (!match) {
	throw new Error(`CHANGELOG section [${version}] was not found in ${changelogPath}.`);
}
const bodyStart = match.index + match[0].length;
const nextHeading = content.slice(bodyStart).search(/^## \[/m);
const body = content.slice(bodyStart, nextHeading < 0 ? undefined : bodyStart + nextHeading).trim();
if (!body) {
	throw new Error(`CHANGELOG section [${version}] is empty in ${changelogPath}.`);
}
fs.writeFileSync(outputPath, `${body}\n`);

function escapeRegex(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}