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
const files = ['main.pb.js', 'jnote.js', 'schema.js', 'cutover.js', 'maintenance.js'].map(
	(name) => [`/app/pb_hooks/${name}`, resolve(root, 'backend/pb_hooks', name)]
);
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
if (result.status !== 0) process.exit(result.status ?? 1);
if (stage === 'ready') {
	// PocketBase's generic health endpoint does not verify JNote's dataset control.
	for (const command of [
		['machine', 'start', machine, '--app', app],
		[
			'ssh',
			'console',
			'--app',
			app,
			'--machine',
			machine,
			'-C',
			'/app/pocketbase jnote-check --dir=/app/pb_data --hooksDir=/app/pb_hooks --automigrate=false'
		]
	]) {
		const check = spawnSync(fly, command, { cwd: root, stdio: 'inherit' });
		if (check.error) throw check.error;
		if (check.status !== 0) process.exit(check.status ?? 1);
	}
}
