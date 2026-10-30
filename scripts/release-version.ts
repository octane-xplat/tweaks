import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RELEASES = {
	tweaks: {
		label: 'Tweaks',
		prefix: 'v',
		branch: 'release/tweaks',
		manifest: 'packages/tweaks/package.json',
		paths: ['packages/tweaks/**'],
	},
} as const

export type Release = keyof typeof RELEASES

// A manifest version of 0.0.0 marks "no release has ever shipped" — the first
// release arrives through the release pull request like every later one, so
// there is nothing pending to publish.
export const UNRELEASED = '0.0.0'

export function releaseName(value: string | undefined): Release {
	assert.ok(value && Object.hasOwn(RELEASES, value), 'release must be tweaks')
	return value as Release
}

export function releaseVersion(value: string): string {
	const version = value.replace(/^v/, '')
	assert.equal(version, version.trim(), 'version cannot contain surrounding whitespace')
	assert.match(
		version,
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/,
		'invalid release version',
	)
	const [core, ...prerelease] = version.split('-')
	assert.ok(
		core.split('.').every((part) => Number.isSafeInteger(Number(part))),
		'version is too large',
	)
	assert.ok(
		!prerelease
			.join('-')
			.split('.')
			.some((part) => /^0\d+$/.test(part)),
		'numeric prerelease identifiers cannot have leading zeros',
	)
	assert.notEqual(
		version,
		UNRELEASED,
		'0.0.0 is the never-released sentinel — overrides must name a real version',
	)
	return version
}

// Keep version policy independent of whether a change merits a release note.
export function commitBump(message: string): 'minor' | 'patch' | 'breaking' | undefined {
	const header = /^([a-z]+)(?:\(([^\r\n)]+)\))?(!)?:\s+\S/.exec(message)
	if (!header || header[2] === 'ci') {
		return undefined
	}
	if (header[3] || /^BREAKING[ -]CHANGE:\s+\S/m.test(message)) {
		return 'breaking'
	}
	if (header[1] === 'feat') {
		return 'minor'
	}
	if (['fix', 'perf', 'revert', 'refactor'].includes(header[1])) {
		return 'patch'
	}
	return undefined
}

// The newest reachable version tag for the stream, excluding `exclude` so a
// just-created target tag cannot become its own baseline.
export function previousTag(root: string, release: Release, exclude = ''): string | undefined {
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
	const { prefix } = RELEASES[release]
	return git('tag', '--merged', 'HEAD', '--list', `${prefix}*`, '--sort=-version:refname')
		.split('\n')
		.find(
			(tag) =>
				tag !== exclude &&
				/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag.slice(prefix.length)),
		)
}

export function resolveRelease(root: string, release: Release, override = '') {
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
	const { prefix, paths } = RELEASES[release]
	const previous = previousTag(root, release)
	let version: string
	if (override) {
		version = releaseVersion(override)
	} else {
		const messages = git(
			'log',
			'--format=%B%x00',
			previous ? `${previous}..HEAD` : 'HEAD',
			'--',
			...paths,
		)

		const bumps = messages.split('\0').map((message) => commitBump(message.trim()))
		if (!bumps.some(Boolean)) {
			return { shouldRelease: false }
		}

		if (!previous) {
			version = '0.1.0'
		} else {
			const [major, minor, patch] = releaseVersion(previous.slice(prefix.length))
				.split('.')
				.map(Number)

			version =
				bumps.includes('breaking') && major > 0
					? `${major + 1}.0.0`
					: bumps.includes('breaking') || bumps.includes('minor')
						? `${major}.${minor + 1}.0`
						: `${major}.${minor}.${patch + 1}`
		}
	}
	const tag = `${prefix}${version}`
	return { shouldRelease: !git('tag', '--list', tag), version, tag }
}

// The GitHub Release is the completion marker: the tag is pushed before
// publish, so a tag without its release means an unfinished publication, not
// a shipped one.
function defaultReleaseExists(tag: string): boolean {
	const repo = process.env.GITHUB_REPOSITORY ?? 'octane-xplat/tweaks'
	const run = spawnSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (run.status === 0) {
		return true
	}
	if (/HTTP 404|Not Found/.test(run.stderr)) {
		return false
	}
	throw new Error(
		`could not check the GitHub release for ${tag}: ${run.stderr.trim() || `exit ${run.status}`}`,
	)
}

// A merged release commit carries the next version in the package manifest
// before publication completes. States: 'none' (the 0.0.0 sentinel — no
// release has ever shipped), 'untagged' (the version was merged but its tag
// is missing on origin), 'unpublished' (the tag exists but its GitHub Release
// does not — publication stopped partway), and 'released'. pending means the
// version still owes a publication step in either incomplete state. The tag
// check asks origin first so a not-yet-fetched tag can't read as untagged,
// and falls back to fetched tags when no remote is reachable.
export function pendingRelease(
	root: string,
	release: Release,
	{ ref, releaseExists }: { ref?: string; releaseExists?: (tag: string) => boolean } = {},
) {
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
			.trim()
	const { manifest } = RELEASES[release]
	const pkg = JSON.parse(
		ref ? git('show', `${ref}:${manifest}`) : readFileSync(join(root, manifest), 'utf8'),
	)
	const version: string = pkg.version
	if (version === UNRELEASED) {
		return { pending: false, state: 'none' as const, version, tag: '', tagSha: '' }
	}
	const tag = `${RELEASES[release].prefix}${version}`

	let tagSha = ''
	try {
		const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
		const lines = remote.split('\n').filter(Boolean)
		// Annotated tags list the tag object plus a peeled ^{commit} line.
		tagSha = (lines.find((line) => line.endsWith('^{}')) ?? lines[0] ?? '').split(/\s+/)[0] ?? ''
	} catch {
		tagSha = ''
	}
	if (!tagSha) {
		try {
			tagSha = git('rev-parse', '--verify', '--quiet', `${tag}^{commit}`)
		} catch {
			tagSha = ''
		}
	}

	if (!tagSha) {
		return { pending: true, state: 'untagged' as const, version, tag, tagSha: '' }
	}
	const state = (releaseExists ?? defaultReleaseExists)(tag) ? 'released' : 'unpublished'
	return { pending: state !== 'released', state, version, tag, tagSha }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [command, name, ...rest] = process.argv.slice(2)
		if (command === 'pending') {
			const refIndex = rest.indexOf('--ref')
			const ref = refIndex >= 0 ? rest[refIndex + 1] : undefined
			assert.equal(
				process.argv.length - (refIndex >= 0 ? 2 : 0),
				4,
				'usage: node scripts/release-version.ts pending tweaks [--ref <ref>]',
			)

			const result = pendingRelease(process.cwd(), releaseName(name), { ref })
			console.log(
				`pending=${result.pending}\nstate=${result.state}\nversion=${result.version}\ntag=${result.tag}\ntag_sha=${result.tagSha}`,
			)
		} else {
			assert.equal(process.argv.length, 3, 'usage: node scripts/release-version.ts <tweaks>')

			const result = resolveRelease(
				process.cwd(),
				releaseName(command),
				process.env.VERSION_OVERRIDE,
			)

			console.log(`should_release=${result.shouldRelease}`)
			if (result.version) {
				console.log(`version=${result.version}\ntag=${result.tag}`)
			}
		}
	} catch (error) {
		console.error((error as Error).message)
		process.exitCode = 1
	}
}
