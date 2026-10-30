#!/usr/bin/env node
// Version bump for the release workflow: sets every publishable package to
// the same version. Package versions use text-level edits to preserve
// manifest formatting.
//
// Usage: node scripts/bump-versions.ts <version>

import { readFileSync, writeFileSync } from 'node:fs'
import { publishablePackages } from './publishable.ts'

const version = process.argv[2]?.replace(/^v/, '')
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
	console.error('usage: node scripts/bump-versions.ts <semver>')
	process.exit(1)
}

const setKey = (raw: string, key: string, value: string) => {
	const next = raw.replace(new RegExp(`"${key}":\\s*"[^"]*"`), `"${key}": "${value}"`)
	if (next === raw) {
		throw new Error(`"${key}" not found`)
	}

	return next
}

for (const { name, dir } of publishablePackages()) {
	const file = `${dir}/package.json`
	writeFileSync(file, setKey(readFileSync(file, 'utf8'), 'version', version as string))
	console.log(`${name} -> ${version}`)
}
