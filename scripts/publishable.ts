import { readdirSync, readFileSync } from 'node:fs'

export type PublishablePackage = { name: string; version: string; dir: string }

// Packages that ship to npm: every direct child of packages/ whose manifest
// is not private.
export function publishablePackages(root = '.'): PublishablePackage[] {
	const out: PublishablePackage[] = []
	for (const dir of readdirSync(`${root}/packages`)) {
		const file = `${root}/packages/${dir}/package.json`
		let pkg: { name?: string; version?: string; private?: boolean }
		try {
			pkg = JSON.parse(readFileSync(file, 'utf8'))
		} catch {
			continue
		}

		if (pkg.private || !pkg.name || !pkg.version) {
			continue
		}

		out.push({ name: pkg.name, version: pkg.version, dir: `packages/${dir}` })
	}

	return out
}
