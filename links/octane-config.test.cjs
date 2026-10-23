const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const createHooks = require('./octane-config.cjs')

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tweaks-octane-'))
	t.after(() => fs.rmSync(root, { recursive: true, force: true }))
	const write = (file, data) => {
		const target = path.join(root, file)
		fs.mkdirSync(path.dirname(target), { recursive: true })
		fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data))
	}
	// The Octane checkout fixture.
	write('checkout/package.json', { name: 'octane-xplat', devDependencies: { oxlint: '1.2.3' } })
	write('checkout/apps/mobile/package.json', {
		devDependencies: { '@nativescript/vite': '8.0.20' },
	})
	write('checkout/packages/ui/package.json', { name: '@octane-xplat/ui', version: '0.17.1' })
	write('checkout/packages/cli/package.json', { name: '@octane-xplat/cli', version: '0.17.1' })
	write('checkout/packages/create/compatibility.json', {
		schemaVersion: 1,
		frameworkPackages: ['@octane-xplat/ui', '@octane-xplat/cli'],
		packages: { '@octane-xplat/nativescript-masonkit': { version: '1.0.0-beta.126' } },
		overrides: { 'vite>esbuild': '0.27.7' },
	})
	const workspace = {
		catalog: { octane: '0.14.0' },
		patchedDependencies: { 'octane@0.14.0': 'patches/runtime.patch' },
		overrides: { esbuild: '0.27.7' },
		minimumReleaseAgeExclude: ['trusted-native@1.0.0'],
	}
	write('checkout/pnpm-workspace.yaml', workspace)
	write('checkout/patches/runtime.patch', 'fixture patch')
	// This repo: root + packages/* + apps/* members.
	const app = {
		name: 'playground',
		private: true,
		dependencies: {
			'@octane-xplat/ui': 'catalog:xplat',
			'@octane-xplat/tweaks': 'workspace:*',
			octane: 'catalog:xplat',
			'app-only': '1.0.0',
		},
		devDependencies: { '@nativescript/vite': '8.0.17', oxlint: '^1.2.0' },
	}
	write('package.json', { name: 'tweaks-root', private: true })
	write('packages/tweaks/package.json', {
		name: '@octane-xplat/tweaks',
		peerDependencies: { octane: '>=0.14.0 <1' },
	})
	write('apps/playground/package.json', app)
	fs.mkdirSync(path.join(root, 'checkout/node_modules'), { recursive: true })
	fs.symlinkSync(
		path.dirname(require.resolve('yaml/package.json')),
		path.join(root, 'checkout/node_modules/yaml'),
		'dir',
	)
	const logs = []
	const hooks = () =>
		createHooks(path.join(root, 'checkout'), root, (line) => logs.push(line))
	return { root, write, workspace, app, hooks, logs }
}

test('rewrites every workspace member and links declared framework packages', (t) => {
	const f = fixture(t)
	const hooks = f.hooks()
	const effective = hooks.readPackage(structuredClone(f.app))
	assert.equal(effective.dependencies.octane, '0.14.0')
	assert.equal(
		effective.dependencies['@octane-xplat/ui'],
		`link:${f.root}/checkout/packages/ui`,
	)
	// Workspace-internal deps stay untouched.
	assert.equal(effective.dependencies['@octane-xplat/tweaks'], 'workspace:*')
	assert.equal(effective.dependencies['app-only'], '1.0.0')
	assert.equal(effective.devDependencies['@nativescript/vite'], '8.0.20')
	assert.equal(effective.devDependencies.oxlint, '1.2.3')
	// A second member manifest is rewritten too.
	const tweakPkg = hooks.readPackage({ name: '@octane-xplat/tweaks', dependencies: { octane: '0.11.0' } })
	assert.equal(tweakPkg.dependencies.octane, '0.14.0')
	// Foreign manifests (link targets outside the workspace) pass through.
	const unrelated = { name: 'another-package', dependencies: { octane: '0.11.0' } }
	assert.equal(hooks.readPackage(unrelated), unrelated)
	assert.equal(unrelated.dependencies.octane, '0.11.0')
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(f.root, 'apps/playground/package.json'))).dependencies
			.octane,
		'catalog:xplat',
	)
})

test('aliases the old MasonKit name only when a member declares it', (t) => {
	const f = fixture(t)
	// No member declares the old name → no alias added.
	const without = f.hooks().readPackage(structuredClone(f.app))
	assert.equal(without.dependencies['@octane-xplat/nativescript-masonkit'], undefined)
	const withOld = {
		...f.app,
		dependencies: {
			...f.app.dependencies,
			'@triniwiz/nativescript-masonkit': '1.0.0-beta.110',
		},
	}
	f.write('apps/playground/package.json', withOld)
	const effective = f.hooks().readPackage(structuredClone(withOld))
	assert.equal(
		effective.dependencies['@triniwiz/nativescript-masonkit'],
		'npm:@octane-xplat/nativescript-masonkit@1.0.0-beta.126',
	)
	assert.equal(effective.dependencies['@octane-xplat/nativescript-masonkit'], '1.0.0-beta.126')
})

test('fails loudly on an unexpected compatibility.json schema', (t) => {
	const f = fixture(t)
	f.write('checkout/packages/create/compatibility.json', {
		schemaVersion: 2,
		frameworkPackages: {},
	})
	assert.throws(() => f.hooks(), /compatibility\.json schema/)
})

test('replaces obsolete framework patches while preserving app patches and settings', (t) => {
	const f = fixture(t)
	const config = {
		nodeLinker: 'hoisted',
		patchedDependencies: {
			'octane@0.11.0': 'node_modules/.pnpm-config/@octane-xplat/patches/patches/old.patch',
			'app-only@1.0.0': 'xplat-patches/app.patch',
		},
		overrides: { 'app-only': '1.0.0' },
	}
	const result = f.hooks().updateConfig(config)
	assert.equal(result.nodeLinker, 'hoisted')
	assert.deepEqual(result.minimumReleaseAgeExclude, ['trusted-native@1.0.0'])
	assert.deepEqual(result.patchedDependencies, {
		'app-only@1.0.0': 'xplat-patches/app.patch',
		'octane@0.14.0': path.join(f.root, 'checkout/patches/runtime.patch'),
	})
	assert.equal(result.overrides['app-only'], '1.0.0')
	assert.equal(result.overrides.esbuild, '0.27.7')
	assert.equal(result.overrides['vite>esbuild'], '0.27.7')
	assert.equal(result.overrides.octane, '0.14.0')
	assert.ok(config.patchedDependencies['octane@0.11.0'])
	assert.ok(f.logs.some((line) => line.includes('octane: catalog:xplat → 0.14.0')))
})

test('rejects missing patches, app patch collisions, and package name mismatches', (t) => {
	const f = fixture(t)
	assert.throws(
		() =>
			f
				.hooks()
				.updateConfig({ patchedDependencies: { 'octane@0.14.0': 'xplat-patches/custom.patch' } }),
		/App patch conflicts/,
	)
	fs.unlinkSync(path.join(f.root, 'checkout/patches/runtime.patch'))
	assert.throws(() => f.hooks().updateConfig({}), /Missing Octane patch/)
	f.write('checkout/patches/runtime.patch', 'fixture patch')
	f.write('checkout/packages/ui/package.json', { name: 'wrong-name' })
	assert.throws(() => f.hooks(), /Expected @octane-xplat\/ui/)
})

test('resolves named catalogs and rejects conflicting or missing external versions', (t) => {
	const f = fixture(t)
	f.write('checkout/apps/mobile/package.json', {
		devDependencies: { '@nativescript/vite': 'catalog:tools' },
	})
	f.workspace.catalogs = { tools: { '@nativescript/vite': '8.0.21' } }
	f.write('checkout/pnpm-workspace.yaml', f.workspace)
	assert.equal(
		f.hooks().readPackage(structuredClone(f.app)).devDependencies['@nativescript/vite'],
		'8.0.21',
	)
	f.write('checkout/packages/ui/package.json', {
		name: '@octane-xplat/ui',
		devDependencies: { '@nativescript/vite': '8.0.20' },
	})
	assert.throws(() => f.hooks().readPackage(structuredClone(f.app)), /Conflicting Octane versions/)
	f.workspace.catalogs = {}
	f.write('checkout/pnpm-workspace.yaml', f.workspace)
	assert.throws(() => f.hooks().readPackage(structuredClone(f.app)), /Missing Octane catalog entry/)
})

test('rejects conflicting dependency overrides before installing', (t) => {
	const f = fixture(t)
	assert.throws(
		() => f.hooks().updateConfig({ overrides: { esbuild: '0.28.0' } }),
		/Conflicting dependency override for esbuild/,
	)
})

test('a checkout-only catalog change refreshes an installed dependency', (t) => {
	const { spawnSync } = require('node:child_process')
	const f = fixture(t)
	f.write('checkout/runtime-a/package.json', { name: 'fixture-runtime', version: '1.0.0' })
	f.write('checkout/runtime-b/package.json', { name: 'fixture-runtime', version: '2.0.0' })
	f.write('consumer/package.json', {
		name: 'playground',
		private: true,
		dependencies: { 'fixture-runtime': `file:${f.root}/checkout/runtime-a` },
	})
	f.write('consumer/pnpm-workspace.yaml', { packages: ['.'] })
	f.workspace.catalog = { 'fixture-runtime': `file:${f.root}/checkout/runtime-a` }
	f.workspace.patchedDependencies = {}
	f.workspace.overrides = {}
	f.write('checkout/pnpm-workspace.yaml', f.workspace)
	// The consumer is a workspace member named like a member of this repo so the
	// hook rewrites it; here we exercise readPackage+updateConfig through pnpm by
	// treating the consumer dir as its own repo root.
	f.write(
		'consumer/hook.cjs',
		`module.exports = { hooks: require(${JSON.stringify(require.resolve('./octane-config.cjs'))})(${JSON.stringify(path.join(f.root, 'checkout'))}, ${JSON.stringify(path.join(f.root, 'consumer'))}, () => {}) }`,
	)
	const install = () => {
		const result = spawnSync(
			'pnpm',
			['install', '--ignore-scripts', '--lockfile=false', '--config.pnpmfile=./hook.cjs'],
			{ cwd: path.join(f.root, 'consumer'), encoding: 'utf8' },
		)
		assert.equal(result.status, 0, result.stdout + result.stderr)
		return JSON.parse(
			fs.readFileSync(path.join(f.root, 'consumer/node_modules/fixture-runtime/package.json')),
		).version
	}
	assert.equal(install(), '1.0.0')
	f.workspace.catalog['fixture-runtime'] = `file:${f.root}/checkout/runtime-b`
	f.write('checkout/pnpm-workspace.yaml', f.workspace)
	assert.equal(install(), '2.0.0')
	assert.equal(
		JSON.parse(fs.readFileSync(path.join(f.root, 'consumer/package.json'))).dependencies[
			'fixture-runtime'
		],
		`file:${f.root}/checkout/runtime-a`,
	)
})
