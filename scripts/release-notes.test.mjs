import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { renderNotes } from './release-notes.ts'

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

function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'release-notes-test-'))
	t.after(() => rmSync(root, { recursive: true, force: true }))
	git(root, 'init', '-q', '--initial-branch=main')
	git(root, 'config', 'user.name', 'Notes test')
	git(root, 'config', 'user.email', 'notes-test@example.invalid')
	return root
}

function commit(root, message, path = 'packages/tweaks/src/example.ts') {
	mkdirSync(dirname(join(root, path)), { recursive: true })
	writeFileSync(join(root, path), message + '\n')
	git(root, 'add', '-A')
	git(root, 'commit', '-qm', message)
	return git(root, 'rev-parse', 'HEAD')
}

test('renderNotes groups commits since the previous tag and links them', (t) => {
	const root = fixture(t)
	commit(root, 'feat: first version')
	git(root, 'tag', 'v0.1.0')
	const feat = commit(root, 'feat: add styles section')
	const fix = commit(root, 'fix: repair dev path')
	commit(root, 'docs: consumer section')
	commit(root, 'feat: desktop-only work', 'apps/desktop/src/panel.tsx')
	const notes = renderNotes(root, 'tweaks', '0.2.0')
	assert.match(notes, /### Features\n\n- feat: add styles section/)
	assert.match(notes, /### Fixes and improvements\n\n- fix: repair dev path/)
	assert.match(notes, /### Other changes\n\n- docs: consumer section/)
	assert.match(
		notes,
		new RegExp(`\\(\\[\`${feat.slice(0, 7)}\`\\]\\(https://github\\.com/octane-xplat/tweaks/commit/${feat}\\)\\)`),
	)
	assert.match(notes, new RegExp(fix.slice(0, 7)))
	assert.doesNotMatch(notes, /desktop-only work/, 'commits outside publishable paths are excluded')
	assert.doesNotMatch(notes, /first version/, 'commits at or before the previous tag are excluded')
})

test('renderNotes lists breaking commits first', (t) => {
	const root = fixture(t)
	commit(root, 'feat!: renamed the vite subpath')
	const notes = renderNotes(root, 'tweaks', '0.1.0')
	assert.match(notes, /^### Breaking changes\n\n- feat!: renamed the vite subpath/)
})

test('renderNotes excludes the target tag from its baseline for resumed publishes', (t) => {
	const root = fixture(t)
	commit(root, 'feat: first version')
	git(root, 'tag', 'v0.1.0')
	commit(root, 'fix: real fix')
	const head = commit(root, 'chore(release): v0.2.0', MANIFEST)
	// A resumed publish already tagged the tested commit: the target tag must
	// not swallow the range that produced the notes.
	git(root, 'tag', 'v0.2.0', head)
	const notes = renderNotes(root, 'tweaks', '0.2.0')
	assert.match(notes, /fix: real fix/, 'range still covers the released commits')
	assert.doesNotMatch(notes, /chore\(release\)/, 'the bot release commit is filtered out')
	assert.doesNotMatch(notes, /first version/)
})

test('renderNotes falls back when nothing is user-facing', (t) => {
	const root = fixture(t)
	commit(root, 'docs: app page', 'apps/playground/readme.md')
	assert.equal(renderNotes(root, 'tweaks', '0.1.0'), 'No user-facing changes in this release.\n')
})
