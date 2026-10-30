#!/usr/bin/env node
// Generated release notes for the tweaks stream. This repository keeps no
// .changelog convention — the release body is built from Conventional
// Commits on the publishable paths since the previous version tag.
//
// Usage: node scripts/release-notes.ts notes <version>
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commitBump, previousTag, RELEASES, releaseName, releaseVersion, type Release } from './release-version.ts'

const repository = 'https://github.com/octane-xplat/tweaks'

type Commit = { sha: string; message: string }

function commitsSince(root: string, release: Release, version: string): Commit[] {
	const { prefix, paths } = RELEASES[release]
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
	// Exclude the target tag: when a publish resumes after tagging, the new tag
	// is already reachable and must not become its own baseline.
	const previous = previousTag(root, release, `${prefix}${version}`)
	// NUL-separated sha/body field pairs; git output never contains NUL in %B.
	const log = git(
		'log',
		'--format=%H%x00%B%x00',
		previous ? `${previous}..HEAD` : 'HEAD',
		'--',
		...paths,
	)
	const fields = log.split('\0')
	const commits: Commit[] = []
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const sha = fields[i].trim()
		if (sha) {
			commits.push({ sha, message: fields[i + 1].trim() })
		}
	}
	return commits
}

export function renderNotes(root: string, release: Release, version: string): string {
	version = releaseVersion(version)
	const groups: { title: string; pick: (message: string) => boolean }[] = [
		{ title: 'Breaking changes', pick: (m) => commitBump(m) === 'breaking' },
		{ title: 'Features', pick: (m) => commitBump(m) === 'minor' },
		{ title: 'Fixes and improvements', pick: (m) => commitBump(m) === 'patch' },
		{ title: 'Other changes', pick: (m) => commitBump(m) === undefined },
	]
	const sections: string[] = []
	for (const { title, pick } of groups) {
		const items = commitsSince(root, release, version)
			// The bot's own release commit bumps the manifest inside the range —
			// it is noise, not a change.
			.filter(({ message }) => !/^chore\(release\):/.test(message))
			.filter(({ message }) => pick(message))
			.map(({ sha, message }) => {
				const subject = message.split('\n', 1)[0]
				return `- ${subject} ([\`${sha.slice(0, 7)}\`](${repository}/commit/${sha}))`
			})
		if (items.length) {
			sections.push(`### ${title}\n\n${items.join('\n')}`)
		}
	}
	return (sections.join('\n\n') || 'No user-facing changes in this release.') + '\n'
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [command, release, version, ...rest] = process.argv.slice(2)
		assert.ok(
			command === 'notes' && release && version && !rest.length,
			'usage: node scripts/release-notes.ts notes <tweaks> <version>',
		)
		process.stdout.write(renderNotes(process.cwd(), releaseName(release), version))
	} catch (error) {
		console.error((error as Error).message)
		process.exitCode = 1
	}
}
