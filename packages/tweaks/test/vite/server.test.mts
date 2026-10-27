import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import WebSocket from 'ws'
import type { TweakEntry, TweakValue } from '../../src/protocol.ts'
import { TweaksServer } from '../../src/vite/server.ts'
import { extract, type ExtractedTweak } from '../../src/vite/extract.ts'
import { extractStyles, type StyleSite } from '../../src/vite/styles.ts'
import type { StyleEntry } from '../../src/protocol.ts'

const TOKEN = 'test-token'

interface Harness {
	url: string
	manifest: Map<string, { entry: TweakEntry; tweak: ExtractedTweak }>
	hub: TweaksServer
	close(): Promise<void>
}

async function start(
	t: { after(fn: () => void): void },
	files: Record<string, string> = {},
	saveDelay = 0,
): Promise<Harness> {
	const manifest = new Map<string, { entry: TweakEntry; tweak: ExtractedTweak }>()
	const styleManifest = new Map<string, StyleSite>()
	for (const [file, code] of Object.entries(files)) {
		for (const site of extractStyles(code, file).sites) styleManifest.set(site.entry.id, site)
		for (const tweak of extract(code, file).tweaks) {
			manifest.set(tweak.id, {
				entry: {
					id: tweak.id,
					file,
					name: tweak.name,
					group: tweak.group,
					input: tweak.input,
					value: tweak.value,
					writable: tweak.writable,
					reason: tweak.reason,
				},
				tweak,
			})
		}
	}
	const saves: { ok: boolean; saved: string[]; errors: never[] }[] = []
	const hub = new TweaksServer({
		token: TOKEN,
		root: '/proj',
		name: 'test-app',
		getEntry: (id) => manifest.get(id)?.entry,
		getStyleEntry: (id: string) => styleManifest.get(id)?.entry,
		save: async () => {
			await new Promise((r) => setTimeout(r, saveDelay))
			const report = { ok: true, saved: ['src/a.tsx'], errors: [] }
			saves.push(report as never)
			return report
		},
		savePreview: async () => ({
			files: [{ file: 'src/a.tsx', diff: '@@ -1,1 +1,1 @@\n-const a = useTweak(8)\n+const a = useTweak(20)' }],
			truncated: false,
			errors: [],
		}),
		log: () => {},
	})
	const httpServer = http.createServer()
	httpServer.on('upgrade', hub.handleUpgrade)
	await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r))
	const port = (httpServer.address() as { port: number }).port
	t.after(async () => {
		hub.close()
		await new Promise((r) => httpServer.close(r))
	})
	return {
		url: `ws://127.0.0.1:${port}/__octane_tweaks`,
		manifest,
		hub,
		close: async () => {
			hub.close()
			await new Promise((r) => httpServer.close(r))
		},
	}
}

function connect(h: Harness, role: 'app' | 'panel', clientId: string, token = TOKEN) {
	const ws = new WebSocket(`${h.url}?token=${token}&role=${role}&clientId=${clientId}&label=web`)
	ws.on('error', () => {})
	const queue: Record<string, unknown>[] = []
	const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = []
	ws.on('message', (data) => {
		const msg = JSON.parse(String(data)) as Record<string, unknown>
		const i = waiters.findIndex((w) => w.type === msg.type)
		if (i >= 0) waiters.splice(i, 1)[0].resolve(msg)
		else queue.push(msg)
	})
	const next = (type: string, timeoutMs = 3000) =>
		new Promise<Record<string, unknown>>((resolve, reject) => {
			const queued = queue.findIndex((m) => m.type === type)
			if (queued >= 0) return resolve(queue.splice(queued, 1)[0])
			const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs)
			waiters.push({
				type,
				resolve: (m) => {
					clearTimeout(timer)
					resolve(m)
				},
			})
		})
	return { ws, next }
}

function open(ws: WebSocket) {
	return new Promise<void>((resolve, reject) => {
		ws.once('open', resolve)
		ws.once('error', reject)
	})
}



const FILE = `import { useTweak } from '@octane-xplat/tweaks'
const a = useTweak(8, { input: { type: 'number' } })
const pick = useTweak('x', { input: { type: 'select', options: ['x', 'y'] } })
`
const FILES = { 'src/a.tsx': FILE }

test('rejects missing and wrong tokens with 401', async (t) => {
	const h = await start(t)
	const port = Number(new URL(h.url).port)
	for (const query of ['', '?token=wrong&role=app']) {
		const statusCode = await new Promise((resolve, reject) => {
			const req = http.request({
				port,
				host: '127.0.0.1',
				path: `/__octane_tweaks${query}`,
				headers: {
					Connection: 'Upgrade',
					Upgrade: 'websocket',
					'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
					'Sec-WebSocket-Version': '13',
				},
			})
			req.on('response', (res) => resolve(res.statusCode ?? 0))
			req.on('upgrade', () => resolve(101))
			req.on('error', reject)
			req.end()
		})
		assert.equal(statusCode, 401)
	}
})

test('mount registers entries; state lists only mounted; disconnect removes', async (t) => {
	const h = await start(t, FILES)
	const app = connect(h, 'app', 'c1')
	await open(app.ws)
	const values = await app.next( 'values')
	assert.deepEqual(values.values, {})
	app.ws.send(JSON.stringify({ type: 'mount', mounts: [{ id: 'src/a.tsx#a', value: 8 }] }))
	const panel = connect(h, 'panel', 'p1')
	await open(panel.ws)
	const state = (await panel.next( 'state')) as {
		entries: { id: string; mountedBy: string[]; runtimeValue: TweakValue }[]
		clients: { clientId: string }[]
	}
	assert.deepEqual(state.entries.map((e) => e.id), ['src/a.tsx#a'])
	assert.deepEqual(state.entries[0].mountedBy, ['c1'])
	assert.equal(state.entries[0].runtimeValue, 8)
	assert.deepEqual(state.clients.map((c) => c.clientId), ['c1'])
	// Unmount removes the entry from state.
	const gone = panel.next( 'state')
	app.ws.send(JSON.stringify({ type: 'unmount', ids: ['src/a.tsx#a'] }))
	assert.deepEqual(((await gone).entries as unknown[]).length, 0)
	assert.deepEqual((await gone).unmountedDirty, [])
	// Disconnect removes mounts too.
	app.ws.send(JSON.stringify({ type: 'mount', mounts: [{ id: 'src/a.tsx#a', value: 8 }] }))
	await panel.next( 'state')
	const empty = panel.next( 'state')
	app.ws.close()
	assert.deepEqual(((await empty).entries as unknown[]).length, 0)
})

test('set validates type and broadcasts values + state', async (t) => {
	const h = await start(t, FILES)
	const app = connect(h, 'app', 'c1')
	await open(app.ws)
	await app.next( 'values')
	app.ws.send(JSON.stringify({ type: 'mount', mounts: [{ id: 'src/a.tsx#pick', value: 'x' }] }))
	const panel = connect(h, 'panel', 'p1')
	await open(panel.ws)
	await panel.next( 'state')
	// Invalid: not in options → ignored, no broadcast.
	panel.ws.send(JSON.stringify({ type: 'set', id: 'src/a.tsx#pick', value: 'zzz' }))
	await new Promise((r) => setTimeout(r, 150))
	// Valid: broadcast values to the app.
	const msg = app.next( 'values')
	panel.ws.send(JSON.stringify({ type: 'set', id: 'src/a.tsx#pick', value: 'y' }))
	assert.deepEqual((await msg).values, { 'src/a.tsx#pick': 'y' })
	const state = (await panel.next( 'state')) as { entries: { override: TweakValue | null; dirty: boolean }[] }
	assert.equal(state.entries[0].override, 'y')
	assert.equal(state.entries[0].dirty, true)
	// Revert sets the override to the source value (deliberately not deleted).
	const reverted = app.next( 'values')
	panel.ws.send(JSON.stringify({ type: 'revert', ids: ['src/a.tsx#pick'] }))
	assert.deepEqual((await reverted).values, { 'src/a.tsx#pick': 'x' })
	const clean = (await panel.next( 'state')) as { entries: { dirty: boolean }[] }
	assert.equal(clean.entries[0].dirty, false)
})

test('concurrent save reports busy; save resolves with result', async (t) => {
	const h = await start(t, FILES, 200)
	const panel1 = connect(h, 'panel', 'p1')
	const panel2 = connect(h, 'panel', 'p2')
	await open(panel1.ws)
	await open(panel2.ws)
	await panel1.next( 'state')
	await panel2.next( 'state')
	const r1 = panel1.next( 'saveResult')
	const r2 = panel2.next( 'saveResult')
	panel1.ws.send(JSON.stringify({ type: 'save' }))
	panel2.ws.send(JSON.stringify({ type: 'save' }))
	const [first, second] = await Promise.all([r1, r2]) as { ok: boolean; saved: string[]; errors: { message: string }[] }[]
	assert.equal(first.ok, true)
	assert.deepEqual(first.saved, ['src/a.tsx'])
	assert.equal(second.ok, false)
	assert.match(second.errors[0].message, /busy/)
})

test('savePreview request returns the per-file diff report; busy during save', async (t) => {
	const h = await start(t, FILES, 150)
	const panel1 = connect(h, 'panel', 'p1')
	const panel2 = connect(h, 'panel', 'p2')
	await open(panel1.ws)
	await open(panel2.ws)
	await panel1.next('state')
	await panel2.next('state')

	const preview = panel1.next('savePreview')
	panel1.ws.send(JSON.stringify({ type: 'savePreview' }))
	const report = (await preview) as {
		files: { file: string; diff: string }[]
		truncated: boolean
		errors: { message: string }[]
	}
	assert.equal(report.files.length, 1)
	assert.equal(report.files[0].file, 'src/a.tsx')
	assert.match(report.files[0].diff, /^\+const a = useTweak\(20\)$/m)
	assert.equal(report.truncated, false)

	// While a save is in flight a preview answers busy instead of racing it.
	const saving = panel1.next('saveResult')
	panel1.ws.send(JSON.stringify({ type: 'save' }))
	await new Promise((r) => setTimeout(r, 60)) // < saveDelay: the save is still running
	const busy = panel2.next('savePreview')
	panel2.ws.send(JSON.stringify({ type: 'savePreview' }))
	await saving
	assert.match((await busy).errors[0].message, /busy/)
})

test('unmountedDirty lists dirty overrides with no mounting client; bare revert covers them', async (t) => {
	const h = await start(t, FILES)
	const app = connect(h, 'app', 'c1')
	const panel = connect(h, 'panel', 'p1')
	await open(app.ws)
	await open(panel.ws)
	await app.next('values')
	await panel.next('state')
	app.ws.send(JSON.stringify({ type: 'mount', mounts: [{ id: 'src/a.tsx#a', value: 8 }] }))
	await panel.next('state')
	// Override while mounted, then unmount → dirty with no client.
	const v = app.next('values')
	panel.ws.send(JSON.stringify({ type: 'set', id: 'src/a.tsx#a', value: 42 }))
	await v
	app.ws.send(JSON.stringify({ type: 'unmount', ids: ['src/a.tsx#a'] }))
	// Wait for the post-unmount state (earlier broadcasts may still be queued).
	let s: {
		entries: unknown[]
		unmountedDirty: { id: string; override: TweakValue; value: TweakValue | null }[]
	}
	for (;;) {
		s = (await panel.next('state')) as typeof s
		if (s.entries.length === 0) break
	}
	assert.deepEqual(s.unmountedDirty, [
		{ id: 'src/a.tsx#a', kind: 'tweak', file: 'src/a.tsx', name: 'a', group: null, override: 42, value: 8 },
	])
	// Bare revert reverts unmounted dirty overrides too.
	const reverted = app.next('values')
	panel.ws.send(JSON.stringify({ type: 'revert' }))
	assert.deepEqual((await reverted).values, { 'src/a.tsx#a': 8 })
	let clean: { unmountedDirty: unknown[]; entries: { id: string; dirty: boolean }[] }
	for (;;) {
		clean = (await panel.next('state')) as typeof clean
		if (clean.unmountedDirty.length === 0 && clean.entries.every((e) => !e.dirty)) break
	}
})

test('styleSet/styleDelete drafts, validation, mounted styles in state, revert', async (t) => {
	const { url, close } = await start(t, {
		'src/App.tsx': `export function App() {
	return <View style={{ borderRadius: 8, padding: 16 }}><Text style={{ color: 'red' }} /></View>
}`,
	})
	const siteId = 'src/App.tsx#style:App/View:1'
	const app = new WebSocket(`${url}?token=${TOKEN}&role=app&clientId=a1&label=web`)
	const valuesMsgs: any[] = []
	// Listen before open: the server emits an async connect-time values
	// broadcast that must be captured rather than raced.
	app.on('message', (d) => {
		const m = JSON.parse(String(d))
		if (m.type === 'values') valuesMsgs.push(m)
	})
	await new Promise((r) => app.once('open', r))
	app.send(JSON.stringify({ type: 'mount', mounts: [{ id: siteId, value: 0 }] }))
	const panel = new WebSocket(`${url}?token=${TOKEN}&role=panel&clientId=p1&label=p`)
	const states: any[] = []
	panel.on('message', (d) => {
		const m = JSON.parse(String(d))
		if (m.type === 'state') states.push(m)
	})
	await new Promise((r) => panel.once('open', r))
	await new Promise((r) => setTimeout(r, 60))
	const state = states.at(-1)
	const entry = state.styles.find((s: { id: string }) => s.id === siteId)
	assert.ok(entry, 'mounted inline site in state.styles')
	assert.equal(entry.dirty, false)

	// Invalid: bad path + read-only kind length>1 for inline. The async
	// connect-time values broadcast may still be in flight, so compare
	// against a baseline count rather than zero.
	const baseline = valuesMsgs.length
	panel.send(JSON.stringify({ type: 'styleSet', id: siteId, path: ['a', 'b'], value: 1 }))
	panel.send(JSON.stringify({ type: 'styleSet', id: siteId, path: [''], value: 1 }))
	await new Promise((r) => setTimeout(r, 60))
	assert.equal(valuesMsgs.length, baseline)

	// Valid set + delete.
	panel.send(JSON.stringify({ type: 'styleSet', id: siteId, path: ['padding'], value: 24 }))
	panel.send(JSON.stringify({ type: 'styleDelete', id: siteId, path: ['borderRadius'] }))
	await new Promise((r) => setTimeout(r, 80))
	const vals = valuesMsgs.at(-1)
	assert.deepEqual(vals.styles[siteId], {
		kind: 'inline',
		set: { padding: 24 },
		delete: ['borderRadius'],
	})
	assert.equal(states.at(-1).styles.find((s: { id: string }) => s.id === siteId).dirty, true)

	// Delete after editing must remove the property, not merely undo the edit.
	panel.send(JSON.stringify({ type: 'styleDelete', id: siteId, path: ['padding'] }))
	await new Promise((r) => setTimeout(r, 60))
	assert.ok(valuesMsgs.at(-1).styles[siteId].delete.includes('padding'))
	assert.equal(valuesMsgs.at(-1).styles[siteId].set.padding, undefined)

	// Restore is a styleSet of the source literal; it must clear deletion too.
	panel.send(JSON.stringify({ type: 'styleSet', id: siteId, path: ['padding'], value: 16 }))
	panel.send(JSON.stringify({ type: 'styleSet', id: siteId, path: ['borderRadius'], value: 8 }))
	await new Promise((r) => setTimeout(r, 60))
	assert.equal(states.at(-1).styles.find((s: { id: string }) => s.id === siteId).dirty, false)

	// Restoring a draft addition drops it without deleting a source property.
	panel.send(JSON.stringify({ type: 'styleSet', id: siteId, path: ['opacity'], value: '0.5' }))
	panel.send(JSON.stringify({ type: 'styleDelete', id: siteId, path: ['opacity'] }))
	await new Promise((r) => setTimeout(r, 60))
	assert.equal(states.at(-1).styles.find((s: { id: string }) => s.id === siteId).dirty, false)
	panel.send(JSON.stringify({ type: 'styleSet', id: siteId, path: ['padding'], value: 24 }))

	// Revert the site.
	panel.send(JSON.stringify({ type: 'revert', ids: [siteId] }))
	await new Promise((r) => setTimeout(r, 60))
	assert.equal(states.at(-1).styles.find((s: { id: string }) => s.id === siteId).dirty, false)
	assert.equal(valuesMsgs.at(-1).styles[siteId], undefined)
	app.close(); panel.close(); await close()
})

test('pick broadcast, picked relay, disconnect + reconnect handling', async (t) => {
	const { url, close } = await start(t, {
		'src/App.tsx': `export function App() {
	return <View style={{ padding: 16 }} />
}`,
	})
	const siteId = 'src/App.tsx#style:App/View:1'
	const app = new WebSocket(`${url}?token=${TOKEN}&role=app&clientId=a1&label=web`)
	const appMsgs: any[] = []
	app.on('message', (d) => appMsgs.push(JSON.parse(String(d))))
	await new Promise((r) => app.once('open', r))
	app.send(JSON.stringify({ type: 'mount', mounts: [{ id: siteId, value: 0 }] }))
	const panel = new WebSocket(`${url}?token=${TOKEN}&role=panel&clientId=p1&label=panel`)
	const states: any[] = []
	const pickedMsgs: any[] = []
	panel.on('message', (d) => {
		const m = JSON.parse(String(d))
		if (m.type === 'state') states.push(m)
		if (m.type === 'picked') pickedMsgs.push(m)
	})
	await new Promise((r) => panel.once('open', r))
	const until = (fn: () => boolean, label: string) =>
		new Promise<void>((resolve, reject) => {
			const end = Date.now() + 4000
			const poll = () =>
				fn() ? resolve() : Date.now() > end ? reject(new Error(`timeout ${label}`)) : setTimeout(poll, 10)
			poll()
		})
	await until(() => states.at(-1)?.styles.length === 1, 'mount state')

	// pick active → state.picking + apps get pick active.
	panel.send(JSON.stringify({ type: 'pick', active: true }))
	await until(() => states.at(-1)?.picking === true, 'picking true')
	await until(() => appMsgs.some((m) => m.type === 'pick' && m.active === true), 'app pick on')

	// picked ignored when not picking.
	panel.send(JSON.stringify({ type: 'pick', active: false }))
	await until(() => states.at(-1)?.picking === false, 'picking false')
	app.send(JSON.stringify({ type: 'picked', ids: [siteId] }))
	await new Promise((r) => setTimeout(r, 60))
	assert.equal(pickedMsgs.length, 0)

	// picking again, picked relays ids filtered to mounted sites.
	panel.send(JSON.stringify({ type: 'pick', active: true }))
	await until(() => states.at(-1)?.picking === true, 'picking again')
	app.send(JSON.stringify({ type: 'picked', ids: [siteId, 'bogus#style:X/Y:9'] }))
	await until(() => pickedMsgs.length === 1, 'picked relayed')
	assert.deepEqual(pickedMsgs[0].ids, [siteId])
	assert.equal(pickedMsgs[0].clientId, 'a1')
	await until(() => states.at(-1)?.picking === false, 'pick ended')
	await until(() => appMsgs.filter((m) => m.type === 'pick' && m.active === false).length >= 1, 'app pick off')

	// New app while picking receives pick after connect-time values.
	panel.send(JSON.stringify({ type: 'pick', active: true }))
	await until(() => states.at(-1)?.picking === true, 'picking before reconnect')
	const app2 = new WebSocket(`${url}?token=${TOKEN}&role=app&clientId=a2&label=web`)
	const app2Msgs: any[] = []
	app2.on('message', (d) => app2Msgs.push(JSON.parse(String(d))))
	await new Promise((r) => app2.once('open', r))
	await until(
		() => app2Msgs.findIndex((m) => m.type === 'values') !== -1 &&
			app2Msgs.findIndex((m) => m.type === 'pick' && m.active === true) >
				app2Msgs.findIndex((m) => m.type === 'values'),
		'app2 pick after values',
	)

	// Last panel disconnect ends the pick.
	panel.close()
	await until(() => appMsgs.filter((m) => m.type === 'pick' && m.active === false).length >= 2, 'pick ends on panel disconnect')
	app.close()
	app2.close()
	close()
})
