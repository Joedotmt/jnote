import { createHash } from 'node:crypto';
import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const version = '0.40.3';
const digests = {
	'linux-x64': '8d81b6b79add0e219373e922ebe1dddbee7f57fcff602e3585e0d2c654b983ce',
	'linux-arm64': 'd5092815259f5bc2dffabf6a71da2168851c8d75c04d6e56f6e7a38c48941c70',
	'darwin-x64': 'b0458ea41c85143ee6e0849772e453a0befa59832848757ca71ce155f9c45e9e',
	'darwin-arm64': '858dad7a3aeed243a162604f706bc18e52058fb4ddcb1c1552d863b446b09799'
};
const digest = digests[`${process.platform}-${process.arch}`];
if (!digest)
	throw new Error('Download the pinned official PocketBase release for this platform manually.');
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const url = `https://github.com/pocketbase/pocketbase/releases/download/v${version}/pocketbase_${version}_${process.platform}_${arch}.zip`;
const response = await fetch(url);
if (!response.ok) throw new Error('PocketBase download failed.');
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== digest)
	throw new Error('PocketBase release checksum mismatch.');
const dir = resolve('backend/.bin');
await mkdir(dir, { recursive: true });
const archive = resolve(dir, 'release.zip');
await writeFile(archive, bytes);
execFileSync('unzip', ['-o', archive, 'pocketbase', '-d', dir], { stdio: 'ignore' });
await rm(archive);
await chmod(resolve(dir, 'pocketbase'), 0o755);
if (
	!execFileSync(resolve(dir, 'pocketbase'), ['--version'], { encoding: 'utf8' }).includes(version)
)
	throw new Error('Unexpected binary version.');
console.log(`Installed verified PocketBase ${version} at backend/.bin/pocketbase`);
