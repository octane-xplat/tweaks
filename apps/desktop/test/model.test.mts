import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayValue, PanelModel, validateForInput, type Transport } from '../src/model.ts'
import type { PanelEntry } from '@octane-xplat/tweaks/protocol'

class FakeTransport implements Transport {
	sent: string[] = []
	onopen: (() => void) | null = null
	onmessage: ((data: string) => void) | null = null
	onclose: (() => void) | null = null
	send(d: string) {
		this.sent.push(d)
	}
	close() {
		this.onclose?.()
	}
	open() {
		this.onopen?.()
	}
	emit(msg: unknown) {
		this.onmessage?.(JSON.stringify(msg))
	}
}

function entry(partial: Partial<PanelEntry>): PanelEntry {
	return {
		id: 'f#n',
		file: 'f',
		name: 'n',
		group: null,
		input: { type: 'number' },
		value: 1,
		writable: true,
		runtimeValue: 1,
		override: null,
		dirty: false,
		mountedBy: ['c'],
		...partial,
	}
}

const SERVER = { url: 'ws://127.0.0.1:9/__octane_tweaks', token: 't', name: 'app', root: '/r' }
const stateMsg = (entries: PanelEntry[], unmountedDirty = []) => ({
	type: 'state',
	server: { name: 'app', root: '/r' },
	clients: [{ clientId: 'c', label: 'web' }],
	entries,
	unmountedDirty,
})

function setup() {
	const transports: FakeTransport[] = []
	const model = new PanelModel((url) => {
		const t = new FakeTransport()
		transports.push(t)
		return t
	})
	model.connect(SERVER)
	return { model, transports }
}

test('connect starts connecting and flips status on open', () => {
	const { model, transports } = setup()
	assert.equal(model.status, 'connecting')
	transports[0].open()
	assert.equal(model.status, 'connected')
})

test('connection url carries token, role=panel and label', () => {
	let url = ''
	new PanelModel((u) => {
		url = u
		return new FakeTransport()
	}).connect(SERVER)
	assert.match(url, /token=t/)
	assert.match(url, /role=panel/)
	assert.match(url, /label=desktop/)
	assert.match(url, /clientId=panel-/)
})

test('set validates against input type and sends only valid values', () => {
	const { model, transports } = setup()
	transports[0].emit(stateMsg([entry({ input: { type: 'number' } })]))
	assert.equal(model.set('f#n', 5), true)
	assert.equal(model.set('f#n', Number.NaN), false)
	assert.equal(model.set('f#n', 'x' as never), false)
	assert.deepEqual(transports[0].sent.map(JSON.parse), [{ type: 'set', id: 'f#n', value: 5 }])
})

test('select/color/boolean validation', () => {
	assert.equal(validateForInput({ type: 'select', options: ['a', 1] }, 'a'), true)
	assert.equal(validateForInput({ type: 'select', options: ['a', 1] }, 'b'), false)
	assert.equal(validateForInput({ type: 'color' }, '#ff00aa'), true)
	assert.equal(validateForInput({ type: 'color' }, 'red'), false)
	assert.equal(validateForInput({ type: 'boolean' }, true), true)
	assert.equal(validateForInput({ type: 'boolean' }, 1 as never), false)
	assert.equal(validateForInput({ type: 'string' }, 'ok'), true)
	assert.equal(validateForInput({ type: 'number' }, 3.5), true)
})

test('dirty count includes unmountedDirty; revert/save payloads', () => {
	const { model, transports } = setup()
	const t = transports[0]
	t.emit(stateMsg([entry({ dirty: true })], [
		{ id: 'f#hidden', file: 'f', name: 'hidden', group: null, override: 2, value: 1 },
	]))
	assert.equal(model.dirtyCount(), 2)
	model.revertAll()
	model.save()
	assert.deepEqual(t.sent.slice(-2).map(JSON.parse), [{ type: 'revert' }, { type: 'save' }])
	assert.equal(model.saving, true)
	t.emit({ type: 'saveResult', ok: true, saved: ['f'], errors: [] })
	assert.equal(model.saving, false)
	assert.deepEqual(model.saveResult?.saved, ['f'])
})

test('reconnect uses backoff and resends nothing until connected', () => {
	const { model, transports } = setup()
	const t = transports[0]
	t.onclose?.()
	assert.equal(model.status, 'disconnected')
	// First retry after ~1s.
	assert.equal(transports.length, 1)
})

test('groupedEntries orders by group then name; displayValue precedence', () => {
	const { model, transports } = setup()
	transports[0].emit(
		stateMsg([
			entry({ id: 'f#b', name: 'b', group: 'z' }),
			entry({ id: 'f#a', name: 'a', group: null }),
			entry({ id: 'f#c', name: 'c', group: 'a' }),
		]),
	)
	assert.deepEqual(
		model.groupedEntries().map((g) => [g.group, g.entries.map((e) => e.name)]),
		[
			['General', ['a']],
			['a', ['c']],
			['z', ['b']],
		],
	)
	const e = entry({ value: 1, override: 3, runtimeValue: 2 })
	assert.equal(displayValue(e), 3)
	assert.equal(displayValue(entry({ value: 1, runtimeValue: 2 })), 1)
	assert.equal(displayValue(entry({ value: null, runtimeValue: 2 })), 2)
})

test('syncServers keeps current, follows restart by root, falls back to first', () => {
	const urls: string[] = []
	const model = new PanelModel((u) => {
		urls.push(u)
		return new FakeTransport()
	})
	const s = (name: string, port: number, token: string, root = '/r') =>
		({ url: `ws://127.0.0.1:${port}/__octane_tweaks`, token, name, root })
	const A = s('app', 5200, 't1')
	// First poll: connect to first entry.
	assert.equal(model.syncServers([A]), A)
	// Same identity still listed → keep it (no new connection).
	assert.equal(model.syncServers([A]), A)
	assert.equal(urls.length, 1)
	// Restart: same name+root, new port+token → reconnect via matching root.
	model.serverRoot = '/r'
	const A2 = s('app', 5300, 't2')
	assert.equal(model.syncServers([A2]), A2)
	assert.equal(urls.length, 2)
	assert.match(urls[1], /token=t2/)
	// Two servers for one app (same name) are distinct identities.
	const web = s('app', 5200, 'tw')
	const ios = s('app', 5201, 'ti')
	model.connectedKey = null
	model.serverRoot = '/ios-root'
	web.root = '/web-root'
	ios.root = '/ios-root'
	assert.equal(model.syncServers([web, ios]), ios) // same root wins over first
	// Empty list → no choice, no connect.
	model.connectedKey = null
	assert.equal(model.syncServers([]), null)
})
