const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

const sections = ['dependencies', 'devDependencies', 'optionalDependencies']
const oldMason = '@triniwiz/nativescript-masonkit'
const newMason = '@octane-xplat/nativescript-masonkit'

// checkout: path to a local octane-xplat clone (links/octane-xplat symlink).
// repoRoot: this workspace's root. Every workspace member manifest is rewritten.
module.exports = function createHooks(checkout, repoRoot, log = console.log) {
	const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
	const { parseDocument } = createRequire(path.join(checkout, 'package.json'))('yaml')
	const document = parseDocument(
		fs.readFileSync(path.join(checkout, 'pnpm-workspace.yaml'), 'utf8'),
	)
	if (document.errors.length) {
		throw new Error(`Invalid Octane workspace: ${document.errors[0].message}`)
	}
	const workspace = document.toJS()
	const compatibility = readJson(path.join(checkout, 'packages/create/compatibility.json'))
	// Schema guard: the hook reads frameworkPackages/packages/overrides. Fail
	// loudly rather than silently mis-mirroring a renamed schema.
	if (
		compatibility.schemaVersion !== 1 ||
		!Array.isArray(compatibility.frameworkPackages) ||
		typeof compatibility.packages !== 'object' ||
		compatibility.packages === null
	) {
		throw new Error(
			'Unsupported Octane compatibility.json schema: expected schemaVersion 1 with frameworkPackages[] and packages{}',
		)
	}

	// All workspace member manifests (root + packages/* + apps/*).
	const memberFiles = [path.join(repoRoot, 'package.json')]
	for (const dir of ['packages', 'apps']) {
		const parent = path.join(repoRoot, dir)
		if (!fs.existsSync(parent)) {
			continue
		}
		for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
			const file = path.join(parent, entry.name, 'package.json')
			if (entry.isDirectory() && fs.existsSync(file)) {
				memberFiles.push(file)
			}
		}
	}
	const members = memberFiles.map((file) => ({ file, pkg: readJson(file) }))
	const memberNames = new Set(members.map(({ pkg }) => pkg.name))
	// Whether any member still uses the old MasonKit name (native discovery).
	const usesOldMason = members.some(({ pkg }) =>
		sections.some((section) => pkg[section]?.[oldMason]),
	)

	// Manifests consulted for external version pins: the checkout root, its
	// mobile app, and every linked framework package.
	const manifests = [
		readJson(path.join(checkout, 'package.json')),
		readJson(path.join(checkout, 'apps/mobile/package.json')),
	]
	const linked = new Map()
	for (const { pkg } of members) {
		for (const section of sections) {
			for (const name of Object.keys(pkg[section] || {})) {
				// workspace:* members of this repo stay internal — never linked to the checkout.
				if (
					!name.startsWith('@octane-xplat/') ||
					compatibility.packages[name] ||
					linked.has(name) ||
					pkg[section][name].startsWith('workspace:')
				) {
					continue
				}
				const directory = path.join(checkout, 'packages', name.slice('@octane-xplat/'.length))
				const manifest = readJson(path.join(directory, 'package.json'))
				if (manifest.name !== name) {
					throw new Error(`Expected ${name} in ${directory}`)
				}
				linked.set(name, directory)
				manifests.push(manifest)
			}
		}
	}

	function resolveCatalog(name, spec) {
		if (!spec.startsWith('catalog:')) {
			return spec
		}
		const catalog = spec.slice('catalog:'.length)
		const resolved = (catalog ? workspace.catalogs?.[catalog] : workspace.catalog)?.[name]
		if (typeof resolved !== 'string' || resolved.startsWith('catalog:')) {
			throw new Error(`Missing Octane catalog entry for ${name} (${spec})`)
		}
		return resolved
	}

	function externalSpecifier(name) {
		if (workspace.catalog?.[name]) {
			return resolveCatalog(name, workspace.catalog[name])
		}
		const specs = new Set()
		for (const manifest of manifests) {
			for (const section of sections) {
				const spec = manifest[section]?.[name]
				if (spec && !spec.startsWith('workspace:')) {
					specs.add(resolveCatalog(name, spec))
				}
			}
		}
		if (specs.size > 1) {
			throw new Error(`Conflicting Octane versions for ${name}: ${[...specs].join(', ')}`)
		}
		const managed = compatibility.packages[name]
		return [...specs][0] || managed?.specifier || managed?.version
	}

	function rewrite(pkg) {
		for (const section of sections) {
			const deps = pkg[section]
			if (!deps) {
				continue
			}

			if (usesOldMason && deps[oldMason]) {
				const spec = externalSpecifier(newMason)
				if (!spec) {
					throw new Error(`Octane checkout does not declare ${newMason}`)
				}
				if (deps[newMason] && deps[newMason] !== spec) {
					throw new Error(`Conflicting MasonKit declarations in ${section}`)
				}
				// NativeScript discovers plugins from the unchanged app manifest.
				// Keep that name resolvable to the same native binary used by new imports.
				deps[oldMason] = `npm:${newMason}@${spec}`
				deps[newMason] = spec
			}

			for (const name of Object.keys(deps)) {
				if (name === oldMason || deps[name].startsWith('workspace:')) {
					continue
				}
				if (linked.has(name)) {
					deps[name] = `link:${linked.get(name)}`
				} else {
					const spec = externalSpecifier(name)
					if (spec) {
						deps[name] = spec
					}
				}
			}
		}
		return pkg
	}

	function readPackage(pkg) {
		// pnpmfile readPackage runs for every workspace member; only rewrite
		// manifests that belong to this repo (leave e.g. link: targets alone).
		if (!memberNames.has(pkg.name)) {
			return pkg
		}
		return rewrite(pkg)
	}

	function effectiveMembers() {
		return members.map(({ pkg }) => rewrite(structuredClone(pkg)))
	}

	return {
		readPackage,
		updateConfig(config) {
			const patchedDependencies = {}
			for (const [specifier, file] of Object.entries(config.patchedDependencies || {})) {
				// Only replace framework-owned entries; app patches remain explicit.
				if (!file.replaceAll('\\', '/').includes('.pnpm-config/@octane-xplat/patches/patches/')) {
					patchedDependencies[specifier] = file
				}
			}
			for (const [specifier, file] of Object.entries(workspace.patchedDependencies || {})) {
				if (patchedDependencies[specifier]) {
					throw new Error(`App patch conflicts with Octane patch: ${specifier}`)
				}
				const absolute = path.resolve(checkout, file)
				if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
					throw new Error(`Missing Octane patch: ${absolute}`)
				}
				patchedDependencies[specifier] = absolute
			}
			const effective = effectiveMembers()
			const sharedOverrides = {}
			for (const member of effective) {
				for (const section of sections) {
					for (const name of Object.keys(member[section] || {})) {
						if (!linked.has(name)) {
							const spec =
								name === oldMason ? member[section][name] : externalSpecifier(name)
							if (spec) {
								sharedOverrides[name] = spec
							}
						}
					}
				}
			}
			// Pin shared transitive copies too. These settings also invalidate pnpm's
			// cached resolution when only the checkout's catalog changes.
			const overrides = { ...config.overrides }
			for (const entries of [workspace.overrides, compatibility.overrides, sharedOverrides]) {
				for (const [name, spec] of Object.entries(entries || {})) {
					if (overrides[name] && overrides[name] !== spec) {
						throw new Error(
							`Conflicting dependency override for ${name}: ${overrides[name]} vs ${spec}`,
						)
					}
					overrides[name] = spec
				}
			}
			log('[dev:octane] Effective dependency changes:')
			for (let i = 0; i < effective.length; i++) {
				const original = members[i].pkg
				for (const section of sections) {
					for (const [name, spec] of Object.entries(effective[i][section] || {})) {
						if (spec !== original[section]?.[name]) {
							log(`  ${effective[i].name}: ${name}: ${original[section]?.[name] || '(added)'} → ${spec}`)
						}
					}
				}
			}
			log(
				`[dev:octane] ${Object.keys(workspace.patchedDependencies || {}).length} checkout patches; ${Object.keys(overrides).length} overrides`,
			)
			return {
				...config,
				patchedDependencies,
				overrides,
				allowUnusedPatches: true,
				// Keep the checkout's explicit trusted-version exceptions in memory;
				// pnpm otherwise persists newly selected native pins to the app YAML.
				minimumReleaseAgeExclude: [
					...new Set([
						...(config.minimumReleaseAgeExclude || []),
						...(workspace.minimumReleaseAgeExclude || []),
					]),
				],
			}
		},
	}
}
