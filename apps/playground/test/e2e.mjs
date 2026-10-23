// Playground e2e: dev server + Chromium + a Node ws "panel" client.
// Not part of CI — run with `pnpm --filter playground test:e2e`.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import WebSocket from 'ws'

const ROOT = path.resolve(import.meta.dirname, '..')
const PORT = 5210
const REGISTRY = path.join(os.homedir(), '.octane-xplat', 'tweaks', 'servers')
const APP_FILE = path.join(ROOT, 'src/App.tsrx')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, what, timeout = 20000) {
	const deadline = Date.now() + timeout
	for (;;) {
		const v = await fn()
		if (v) { return v }
		if (Date.now() > deadline) { throw new Error(`timeout: ${what}`) }
		await sleep(100)
	}
}

async function main() {
	const originalSource = fs.readFileSync(APP_FILE, 'utf8')
	const dev = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'], {
		cwd: ROOT,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const serverLog = []
	dev.stdout.on('data', (d) => serverLog.push(String(d)))
	dev.stderr.on('data', (d) => serverLog.push(String(d)))

	let browser
	const restore = () => fs.writeFileSync(APP_FILE, originalSource)
	try {
		// 1. Registry file written once the server is listening.
		const entry = await waitFor(() => {
			let files = []
			try {
				files = fs.readdirSync(REGISTRY)
			} catch {
				return null
			}
			for (const file of files) {
				try {
					const e = JSON.parse(fs.readFileSync(path.join(REGISTRY, file), 'utf8'))
					if (e.url?.includes(`:${PORT}/`) && e.root === ROOT) { return e }
				} catch {}
			}
		}, 'registry file')
		assert.equal(entry.url, `ws://127.0.0.1:${PORT}/__octane_tweaks`)
		console.log('· registry file found:', entry.name)

		// Registry = listening; the first compile can still lag behind.
		await waitFor(async () => {
			try {
				const res = await fetch(`http://localhost:${PORT}/`)
				return res.ok ? true : null
			} catch {
				return null
			}
		}, 'dev server responds')

		browser = await chromium.launch()
		const page = await browser.newPage()
		const errors = []
		page.on('pageerror', (e) => errors.push(String(e)))
		await page.goto(`http://localhost:${PORT}/`)
		await page.locator('[data-testid="card.title"]').waitFor({ timeout: 20000 })
		await page.evaluate(() => {
			globalThis.__marker = 'persisted'
		})

		// 2. Panel client from the registry entry.
		const panel = new WebSocket(
			`${entry.url}?token=${entry.token}&role=panel&clientId=panel-1&label=web`,
		)
		panel.on('error', () => {})
		const inbox = []
		const waiters = []
		panel.on('message', (data) => {
			const msg = JSON.parse(String(data))
			const i = waiters.findIndex((w) => w.type === msg.type)
			if (i >= 0) {
				waiters.splice(i, 1)[0].resolve(msg)
			} else {
				inbox.push(msg)
			}
		})
		const next = (type) =>
			new Promise((resolve, reject) => {
				const i = inbox.findIndex((m) => m.type === type)
				if (i >= 0) { return resolve(inbox.splice(i, 1)[0]) }
				const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 15000)
				waiters.push({
					type,
					resolve: (m) => {
						clearTimeout(timer)
						resolve(m)
					},
				})
			})
		await new Promise((r, j) => {
			panel.once('open', r)
			panel.once('error', j)
		})

		const state = await next('state')
		const ids = state.entries.map((e) => e.id)
		for (const want of [
			'src/App.tsrx#radius',
			'src/App.tsrx#padding',
			'src/App.tsrx#accent',
			'src/App.tsrx#showBorder',
			'src/App.tsrx#density',
			'src/App.tsrx#card/title',
			'src/App.tsrx#message',
			'src/App.tsrx#details/detailText',
		]) {
			assert.ok(ids.includes(want), `missing mounted entry ${want} (got ${ids})`)
		}
		const radiusEntry = state.entries.find((e) => e.id === 'src/App.tsrx#radius')
		assert.deepEqual(radiusEntry.input, { type: 'number', min: 0, max: 40, step: 1 })
		const messageEntry = state.entries.find((e) => e.id === 'src/App.tsrx#message')
		assert.equal(messageEntry.writable, false, 'non-literal default is read-only')
		console.log('· state lists all mounted entries; read-only inference works')

		// 3. Unmount: hide details → entry disappears from state.
		await page.locator('[data-testid="details.toggle"]').click()
		const afterUnmount = await next('state')
		assert.ok(
			!afterUnmount.entries.some((e) => e.id === 'src/App.tsrx#details/detailText'),
			'unmounted entry still in state',
		)
		await page.locator('[data-testid="details.toggle"]').click()
		await next('state')

		// 3b. Overrides survive remount: set detailText, hide, show again.
		panel.send(
			JSON.stringify({ type: 'set', id: 'src/App.tsrx#details/detailText', value: 'tweaked!' }),
		)
		await waitFor(async () => {
			const t = await page.locator('[data-testid="card.detail"]').innerText().catch(() => '')
			return t === 'tweaked!' ? true : null
		}, 'detailText override applied')
		await page.locator('[data-testid="details.toggle"]').click()
		await page.locator('[data-testid="details.toggle"]').click()
		await waitFor(async () => {
			const t = await page.locator('[data-testid="card.detail"]').innerText().catch(() => '')
			return t === 'tweaked!' ? true : null
		}, 'override survives remount')
		console.log('· unmounted entries leave the panel state; overrides survive remount')

		// 4. set changes the DOM live without reload.
		panel.send(JSON.stringify({ type: 'set', id: 'src/App.tsrx#radius', value: 30 }))
		await waitFor(async () => {
			const r = await page
				.locator('[data-testid="card.title"]')
				.evaluate((el) => el.parentElement.style.borderRadius)
			return r === '30px' ? true : null
		}, 'border-radius override applied')
		assert.equal(await page.evaluate(() => globalThis.__marker), 'persisted')
		console.log('· set applies to the DOM without reload')

		// 5. Save: counter to 3, save writes the literal, state survives.
		await page.locator('[data-testid="counter.increment"]').click()
		await page.locator('[data-testid="counter.increment"]').click()
		await page.locator('[data-testid="counter.increment"]').click()
		assert.equal(await page.locator('[data-testid="counter.value"]').innerText(), '3')
		panel.send(JSON.stringify({ type: 'save' }))
		const saveResult = await next('saveResult')
		assert.equal(saveResult.ok, true, JSON.stringify(saveResult.errors))
		assert.ok(saveResult.saved.includes('src/App.tsrx'))
		const source = fs.readFileSync(APP_FILE, 'utf8')
		assert.match(source, /useTweak\(30, \{ input: \{ type: 'number', min: 0, max: 40, step: 1 \} \}/)
		// HMR suppressed → counter state survives and the page did not reload.
		assert.equal(await page.locator('[data-testid="counter.value"]').innerText(), '3')
		assert.equal(await page.evaluate(() => globalThis.__marker), 'persisted')
		// State messages may queue behind the save broadcast — wait for the
		// post-save snapshot showing dirty cleared.
		await waitFor(async () => {
			const s = inbox.find((m) => m.type === 'state')
			if (s) { inbox.splice(inbox.indexOf(s), 1) }
			const latest = s ?? (await Promise.race([next('state'), sleep(400).then(() => null)]))
			const e = latest?.entries?.find((x) => x.id === 'src/App.tsrx#radius')
			return e && e.dirty === false ? latest : null
		}, 'radius dirty cleared after save')
		console.log('· save writes source, suppresses HMR, clears dirty')

		// 6. A manual edit still hot-updates normally.
		const manual = originalSource.replace('useTweak(8,', 'useTweak(30,').replace(
			'Tweak me',
			'Edited by hand',
		)
		fs.writeFileSync(APP_FILE, manual)
		await waitFor(async () => {
			const text = await page
				.locator('[data-testid="card.title"]')
				.innerText()
				.catch(() => '')
			return text.includes('Edited by hand') || text.includes('Tweak me') === false ? true : null
		}, 'manual edit reaches the browser')
		console.log('· manual edits still HMR')
	} finally {
		restore()
		if (browser) { await browser.close() }
		dev.kill('SIGTERM')
		await sleep(300)
		dev.kill('SIGKILL')
	}
	console.log('e2e: all assertions passed')
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
