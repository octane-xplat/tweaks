#!/usr/bin/env node
// Packed-artifact smoke for the stable qualification lane: pack
// @octane-xplat/tweaks, install the tarball into a clean consumer directory
// (peer dependencies resolve from the registry, like a real install), then
// exercise the Node entry point and check the shipped surface.
//
// The package ships TypeScript source for the runtime entry points — Node
// refuses type stripping inside node_modules, so only the compiled ./vite
// subpath is imported here; src/ and types/ are checked for presence.
//
// Usage: node scripts/pack-smoke.mjs
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const tmp = mkdtempSync(join(tmpdir(), 'tweaks-pack-smoke-'))
const pkgDir = join(root, 'packages', 'tweaks')
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

// pnpm pack runs the package's prepack (typegen + build) against the real
// manifest, including publishConfig remapping.
execFileSync('pnpm', ['pack', '--pack-destination', tmp], { cwd: pkgDir, stdio: 'inherit' })
const tarball = readdirSync(tmp).find((file) => file.endsWith('.tgz'))
assert.ok(tarball, 'pnpm pack produced no tarball')
const packed = join(tmp, tarball)

const listing = execFileSync('tar', ['-tzf', packed], { encoding: 'utf8' })
for (const file of [
	'package/dist/vite/index.js',
	'package/dist/vite/index.d.ts',
	'package/dist/protocol.js',
	'package/src/index.ts',
	'package/src/protocol.ts',
	'package/types/index.d.ts',
	'package/types/protocol.d.ts',
]) {
	assert.ok(listing.includes(file), `tarball is missing ${file}`)
}

// Consumer install: npm resolves the package's own deps plus its octane/vite
// peers from the registry, the same as a real project install.
const consumer = join(tmp, 'consumer')
mkdirSync(consumer)
writeFileSync(
	join(consumer, 'package.json'),
	JSON.stringify({ name: 'pack-smoke-consumer', private: true, type: 'module' }) + '\n',
)
execFileSync('npm', ['install', '--no-audit', '--no-fund', packed], {
	cwd: consumer,
	stdio: 'inherit',
})

// The ./vite entry point is emitted JavaScript and loads in plain Node.
const check = execFileSync(
	'node',
	[
		'--input-type=module',
		'-e',
		`const m = await import(${JSON.stringify(manifest.name)} + '/vite');
		if (typeof m.tweaks !== 'function' || typeof m.default !== 'function') throw new Error('tweaks export missing');
		const plugin = m.tweaks();
		if (!plugin || typeof plugin.name !== 'string') throw new Error('plugin factory returned no plugin');
		console.log('packed plugin:', plugin.name);`,
	],
	{ cwd: consumer, encoding: 'utf8' },
)
console.log(check.trim())
console.log(`pack smoke ok: ${manifest.name}@${manifest.version}`)
