// Installs only JNote files onto an existing Fly machine; never runs a data reset.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [app, machine, stage] = process.argv.slice(2);
if (
	!/^[a-z0-9-]+$/.test(app || '') ||
	!/^[a-f0-9]+$/.test(machine || '') ||
	!['guards', 'ready'].includes(stage)
) {
	throw new Error('Usage: node scripts/deploy-jnote-hooks.mjs <app> <machine-id> <guards|ready>');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const installed = resolve(homedir(), '.fly/bin/fly');
const fly = process.env.FLY_BIN || (existsSync(installed) ? installed : 'fly');
const files = ['main.pb.js', 'jnote.js', 'schema.js', 'cutover.js'].map((name) => [
	`/app/pb_hooks/${name}`,
	resolve(root, 'backend/pb_hooks', name)
]);
if (stage === 'ready')
	files.push([
		'/app/pb_migrations/1790899200_jnote_v2.js',
		resolve(root, 'backend/pb_migrations/1790899200_jnote_v2.js')
	]);
const args = ['machine', 'update', machine, '--app', app, '--env', `JNOTE_INSTANCE=${app}`];
for (const [guest, local] of files) args.push('--file-local', `${guest}=${local}`);
args.push('--yes');
const result = spawnSync(fly, args, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
