import assert from 'node:assert/strict'
import { test } from 'node:test'
import { socketUrl } from '../src/connection.ts'

const DEFINE = { token: 'tok', path: '/__octane_tweaks', fallbackOrigin: 'http://127.0.0.1:5173' }
const g = globalThis as Record<string, unknown>

test('socketUrl prefers __NS_HTTP_ORIGIN__ when present', () => {
	g.__NS_HTTP_ORIGIN__ = 'http://192.168.4.25:5173'
	try {
		const url = socketUrl(DEFINE, 'c1', 'native')
		assert.ok(url?.startsWith('ws://192.168.4.25:5173/__octane_tweaks?'))
		assert.ok(url?.includes('token=tok') && url.includes('role=app') && url.includes('label=native'))
	} finally {
		delete g.__NS_HTTP_ORIGIN__
	}
})

test('socketUrl falls back to fallbackOrigin without the NS origin', () => {
	delete g.__NS_HTTP_ORIGIN__
	assert.ok(socketUrl(DEFINE, 'c1', 'native')?.startsWith('ws://127.0.0.1:5173/__octane_tweaks?'))
})

test('socketUrl ignores an empty NS origin and returns null without any origin', () => {
	g.__NS_HTTP_ORIGIN__ = ''
	try {
		assert.ok(socketUrl(DEFINE, 'c1', 'native')?.startsWith('ws://127.0.0.1:5173/'))
		assert.equal(socketUrl({ ...DEFINE, fallbackOrigin: '' }, 'c1', 'native'), null)
	} finally {
		delete g.__NS_HTTP_ORIGIN__
	}
})
