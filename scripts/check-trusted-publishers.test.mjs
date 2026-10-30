import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const PACKAGE = '@octane-xplat/tweaks'

async function fixture(t) {
	const directory = await mkdtemp(join(tmpdir(), 'trusted-publishers-'))
	t.after(() => rm(directory, { recursive: true, force: true }))
	const cache = join(directory, 'cache.json')
	const requests = join(directory, 'requests.jsonl')
	const preload = join(directory, 'fetch.mjs')
	await writeFile(
		preload,
		`
		import { appendFileSync } from 'node:fs'
		globalThis.fetch = async (url) => {
			appendFileSync(process.env.TEST_REQUESTS, JSON.stringify(String(url)) + '\\n')
			if (String(url).startsWith('https://oidc.invalid/')) {
				return Response.json({ value: 'test-oidc-secret' })
			}
			return process.env.TEST_FAIL
				? Response.json({ message: 'publisher missing' }, { status: 403 })
				: Response.json({ token: 'test-npm-secret' })
		}
	`,
	)
	return {
		cache,
		async run(packages = [PACKAGE], env = {}) {
			await writeFile(requests, '')
			const result = await execute(
				process.execPath,
				['--import', preload, resolve('scripts/check-trusted-publishers.ts'), ...packages],
				{
					env: {
						...process.env,
						ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.invalid/token',
						ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-request-secret',
						NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
						GITHUB_REPOSITORY: 'octane-xplat/tweaks',
						GITHUB_WORKFLOW_REF:
							'octane-xplat/tweaks/.github/workflows/release.yml@refs/heads/main',
						GITHUB_JOB: 'publish',
						TRUSTED_PUBLISHERS_CACHE: cache,
						TEST_REQUESTS: requests,
						TEST_FAIL: '',
						...env,
					},
				},
			)
			return {
				...result,
				requests: (await readFile(requests, 'utf8')).trim().split('\n').filter(Boolean),
			}
		},
	}
}

test('successful checks are reused per package without storing tokens or renewing their age', async (t) => {
	const f = await fixture(t)
	// One OIDC token request plus one exchange request for the package.
	assert.equal((await f.run()).requests.length, 2)
	const saved = await readFile(f.cache, 'utf8')
	assert.doesNotMatch(saved, /secret|token/)
	const hit = await f.run()
	assert.equal(hit.requests.length, 0)
	assert.match(hit.stdout, /cached/)
	assert.equal(await readFile(f.cache, 'utf8'), saved)
})

test('expired, future, malformed, and differently scoped cache entries require npm checks', async (t) => {
	const f = await fixture(t)
	await f.run()
	const saved = await readFile(f.cache, 'utf8')
	for (const at of [Date.now() - 24 * 60 * 60 * 1000, Date.now() + 60_000, 'invalid']) {
		const cache = JSON.parse(saved)
		cache.checked[PACKAGE] = at
		await writeFile(f.cache, JSON.stringify(cache))
		assert.equal((await f.run()).requests.length, 2)
	}
	for (const env of [
		{ GITHUB_REPOSITORY: 'other/repo' },
		{ GITHUB_WORKFLOW_REF: 'other-workflow' },
		{ GITHUB_JOB: 'other-job' },
		{ NPM_CONFIG_REGISTRY: 'https://registry.invalid' },
	]) {
		await writeFile(f.cache, saved)
		assert.equal((await f.run([PACKAGE], env)).requests.length, 2)
	}
	await writeFile(f.cache, '{broken')
	assert.equal((await f.run()).requests.length, 2)
})

test('failed exchanges do not save successful results, and omitting the cache forces verification', async (t) => {
	const f = await fixture(t)
	await assert.rejects(f.run([PACKAGE], { TEST_FAIL: '1' }), /publisher missing/)
	await assert.rejects(readFile(f.cache), { code: 'ENOENT' })
	await f.run()
	const saved = await readFile(f.cache, 'utf8')
	// A cached entry still answers within its 24h window — npm authorizes the
	// actual publish regardless.
	await f.run([PACKAGE], { TEST_FAIL: '1' })
	assert.equal(await readFile(f.cache, 'utf8'), saved)
	assert.equal((await f.run(undefined, { TRUSTED_PUBLISHERS_CACHE: '' })).requests.length, 2)
})

test('unknown package names match nothing', async (t) => {
	const f = await fixture(t)
	await assert.rejects(f.run(['@octane-xplat/nope']), /no matching packages/)
})
