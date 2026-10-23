import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractStyles } from '../src/styles.ts'
import { applySplices, planStyleEdit } from '../src/stylewrite.ts'
import { saveOverrides } from '../src/save.ts'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BAMBOO = `import { css } from './styled-system/css'
export default {
	card: css({ padding: '20', gap: '12', _hover: { color: 'red' } }),
	badge: css({ fontSize: '12' }),
	multi: css({ a: '1' }, { b: '2' }),
}
`
const INLINE = `import { useState } from 'octane'
export function App() {
	return (
		<View style={{ borderRadius: 8, padding: 16 }}>
			<Text style={{ color: 'red' }}>hi</Text>
		</View>
	)
}
`

test('extraction: bamboo labels, nested paths, read-only cases', () => {
	const { sites } = extractStyles(BAMBOO, 'App.style.ts')
	assert.equal(sites.length, 3)
	const card = sites[0]
	assert.equal(card.entry.id, 'App.style.ts#css:card')
	assert.equal(card.entry.label, 'card')
	assert.ok(card.entry.writable)
	const paths = card.entry.properties.map((p) => p.path.join('.'))
	assert.deepEqual(paths, ['padding', 'gap', '_hover.color'])
	assert.equal(card.entry.properties[2].value, 'red')
	const multi = sites.find((s) => s.entry.label === 'css #3')
	assert.ok(multi)
	assert.equal(multi.entry.writable, false)
	assert.match(multi.entry.reason ?? '', /multiple arguments/)
})

test('extraction: inline sites, component scoping, spread read-only', () => {
	const src = `export function A() { return <View style={{ a: 1 }}><X style={{ b: 'x' }} /></View> }
export function B() { return <View style={{ ...rest, c: 2 }} /> }`
	const { sites } = extractStyles(src, 'f.tsx')
	assert.equal(sites.length, 3)
	assert.equal(sites[0].entry.id, 'f.tsx#style:A/View:1')
	assert.equal(sites[0].entry.label, 'View in A')
	assert.equal(sites[1].entry.id, 'f.tsx#style:A/X:2')
	assert.equal(sites[2].entry.writable, false)
	assert.ok(sites[0].componentBody)
})

const FILE = `export function App() {
	return <View style={{ borderRadius: 8, padding: 16, borderColor: 'red' }} />
}
`

test('writeback: set existing literal preserves structure', () => {
	const { sites } = extractStyles(FILE, 'f.tsx')
	const site = sites[0]
	const splices = planStyleEdit(FILE, site, { set: { padding: 32 }, delete: [] })
	const out = applySplices(FILE, splices)
	assert.ok(out.includes('padding: 32'))
})

test('writeback: add into one-line object', () => {
	const { sites } = extractStyles(FILE, 'f.tsx')
	const out = applySplices(FILE, planStyleEdit(FILE, sites[0], { set: { gap: 4 }, delete: [] }))
	assert.ok(out.includes('{ borderRadius: 8, padding: 16, borderColor: \'red\', gap: 4 }'))
})

test('writeback: multiline add matches indent + trailing comma', () => {
	const src = `const o = css({
	padding: '20',
	gap: '12'
})`
	const { sites } = extractStyles(`import { css } from './styled-system/css'\n${src}`, 's.ts')
	const out = applySplices(`import { css } from './styled-system/css'\n${src}`, planStyleEdit(`import { css } from './styled-system/css'\n${src}`, sites[0], { set: { margin: 5 }, delete: [] }))
	assert.match(out, /gap: '12',\n\tmargin: 5,/)
})

test('writeback: nested add creates _hover parent; delete drops line', () => {
	const src = `import { css } from './styled-system/css'
const o = css({
	padding: '20',
	color: 'red'
})`
	const { sites } = extractStyles(src, 's.ts')
	const out = applySplices(src, planStyleEdit(src, sites[0], { set: { '_hover.color': 'blue' }, delete: ['color'] }))
	assert.ok(!out.includes("\tcolor: 'red'"))
	assert.ok(out.includes('_hover'))
	const re = extractStyles(out, 's.ts').sites[0]
	const paths = re.entry.properties.map((p) => p.path.join('.'))
	assert.ok(paths.includes('_hover.color'))
})

test('writeback: delete inline property removes it', () => {
	const { sites } = extractStyles(FILE, 'f.tsx')
	const out = applySplices(FILE, planStyleEdit(FILE, sites[0], { set: {}, delete: ['padding'] }))
	assert.ok(!out.includes('padding: 16'))
})

test('save: style draft writes source; mismatch aborts whole save', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-save-'))
	fs.writeFileSync(path.join(dir, 'f.tsx'), FILE)
	const { sites } = extractStyles(FILE, 'f.tsx')
	const site = sites[0]
	const styleManifest = new Map([[site.entry.id, site]])
	const styleDrafts = new Map([[site.entry.id, { set: { padding: 32 }, delete: ['borderRadius'] }]])
	const res = await saveOverrides({
		root: dir, manifest: new Map(), styleManifest, styleDrafts,
		overrides: new Map(), isDirty: () => false, isStyleDirty: () => true,
	})
	assert.equal(res.ok, true)
	const written = fs.readFileSync(path.join(dir, 'f.tsx'), 'utf8')
	assert.ok(written.includes('padding: 32') && !written.includes('borderRadius'))
	// Mismatch: manifest claims site exists but file changed on disk.
	fs.writeFileSync(path.join(dir, 'g.tsx'), FILE)
	fs.writeFileSync(path.join(dir, 'f.tsx'), `export function App() { return <View /> }`)
	const res2 = await saveOverrides({
		root: dir, manifest: new Map(), styleManifest, styleDrafts,
		overrides: new Map(), isDirty: () => false, isStyleDirty: () => true,
	})
	assert.equal(res2.ok, false)
	assert.match(res2.errors[0].message, /no longer found/)
})
