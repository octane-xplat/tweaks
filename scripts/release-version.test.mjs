import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
	commitBump,
	pendingRelease,
	releaseVersion,
	resolveRelease,
} from './release-version.ts'

const MANIFEST = 'packages/tweaks/package.json'

function git(root, ...args) {
	return execFileSync(
		'git',
		['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
		{
			cwd: root,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	).trim()
}

function fixture(t, version = '0.0.0') {
	const root = mkdtempSync(join(tmpdir(), 'release-version-test-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	git(root, 'init', '-q', '--initial-branch=main')
	git(root, 'config', 'user.name', 'Release test')
	git(root, 'config', 'user.email', 'release-test@example.invalid')
	mkdirSync(dirname(join(root, MANIFEST)), { recursive: true })
	writeFileSync(
		join(root, MANIFEST),
		JSON.stringify({ name: '@octane-xplat/tweaks', version }, null, '\t') + '\n',
	)
	return root
}

function commit(root, message, path = 'packages/tweaks/src/example.ts') {
	mkdirSync(dirname(join(root, path)), { recursive: true })
	writeFileSync(join(root, path), message + '\n')
	git(root, 'add', '-A')
	git(root, 'commit', '-qm', message)
	return git(root, 'rev-parse', 'HEAD')
}

test('commitBump classifies Conventional Commits', () => {
	assert.equal(commitBump('feat: add panel'), 'minor')
	assert.equal(commitBump('feat(panel)!: redo'), 'breaking')
	assert.equal(commitBump('fix: crash'), 'patch')
	assert.equal(commitBump('perf: faster'), 'patch')
	assert.equal(commitBump('refactor: cleanup'), 'patch')
	assert.equal(commitBump('revert: feat: x'), 'patch')
	assert.equal(commitBump('docs: readme'), undefined)
	assert.equal(commitBump('test: more'), undefined)
	assert.equal(commitBump('chore: deps'), undefined)
	assert.equal(commitBump('ci: workflow'), undefined)
	assert.equal(commitBump('feat(ci): scoped out'), undefined)
	assert.equal(commitBump('not conventional'), undefined)
	assert.equal(commitBump('fix: x\n\nBREAKING CHANGE: y'), 'breaking')
})

test('releaseVersion validates semver', () => {
	assert.equal(releaseVersion('v1.2.3'), '1.2.3')
	assert.equal(releaseVersion('0.1.0-nightly.gabc1234'), '0.1.0-nightly.gabc1234')
	assert.throws(() => releaseVersion('soon'))
	assert.throws(() => releaseVersion('1.02.0'))
	assert.throws(() => releaseVersion('1.0.0-01'))
})

test('resolveRelease infers the first version from bump-eligible commits', (t) => {
	const root = fixture(t)
	commit(root, 'chore: manifest')
	assert.equal(resolveRelease(root, 'tweaks').shouldRelease, false, 'no eligible commits')

	commit(root, 'docs: app only', 'apps/desktop/readme.md')
	assert.equal(resolveRelease(root, 'tweaks').shouldRelease, false, 'docs outside package paths')

	commit(root, 'feat: add hook')
	const result = resolveRelease(root, 'tweaks')
	assert.equal(result.shouldRelease, true)
	assert.equal(result.version, '0.1.0')
	assert.equal(result.tag, 'v0.1.0')
})

test('resolveRelease bumps from the previous tag', (t) => {
	const root = fixture(t)
	commit(root, 'feat: first')
	git(root, 'tag', 'v0.1.0')
	commit(root, 'fix: bug')
	assert.equal(resolveRelease(root, 'tweaks').version, '0.1.1')
	commit(root, 'feat: new')
	assert.equal(resolveRelease(root, 'tweaks').version, '0.2.0')
	commit(root, 'fix!: breaking fix')
	assert.equal(resolveRelease(root, 'tweaks').version, '0.2.0', 'breaking bumps minor below 1.0')
	git(root, 'tag', 'v1.0.0')
	commit(root, 'fix!: break again')
	assert.equal(resolveRelease(root, 'tweaks').version, '2.0.0', 'breaking bumps major from 1.0.0')
	assert.equal(
		resolveRelease(root, 'tweaks', '1.0.0-rc.1').version,
		'1.0.0-rc.1',
		'override wins',
	)
})

test('resolveRelease skips a version whose tag exists', (t) => {
	const root = fixture(t)
	commit(root, 'feat: first')
	git(root, 'tag', 'v0.1.0')
	commit(root, 'fix: bug')
	assert.equal(
		resolveRelease(root, 'tweaks', '0.1.0').shouldRelease,
		false,
		'an override naming an existing tag is skipped',
	)
	assert.equal(resolveRelease(root, 'tweaks', '0.1.1').shouldRelease, true)
})

test('pendingRelease treats the 0.0.0 sentinel as no release ever shipped', (t) => {
	const root = fixture(t, '0.0.0')
	commit(root, 'feat: first')
	const result = pendingRelease(root, 'tweaks', { releaseExists: () => false })
	assert.equal(result.pending, false)
	assert.equal(result.state, 'none')
})

test('pendingRelease reports untagged, unpublished, and released states', (t) => {
	const root = fixture(t, '0.1.0')
	commit(root, 'chore(release): v0.1.0')

	const untagged = pendingRelease(root, 'tweaks', { releaseExists: () => false })
	assert.equal(untagged.pending, true)
	assert.equal(untagged.state, 'untagged')
	assert.equal(untagged.tag, 'v0.1.0')

	const head = git(root, 'rev-parse', 'HEAD')
	git(root, 'tag', 'v0.1.0', head)
	const unpublished = pendingRelease(root, 'tweaks', { releaseExists: () => false })
	assert.equal(unpublished.pending, true)
	assert.equal(unpublished.state, 'unpublished')
	assert.equal(unpublished.tagSha, head)

	const released = pendingRelease(root, 'tweaks', { releaseExists: () => true })
	assert.equal(released.pending, false)
	assert.equal(released.state, 'released')
})
