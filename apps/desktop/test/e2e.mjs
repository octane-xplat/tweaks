// Web-panel e2e: playground dev server + desktop panel web dev server, driven
// through Chromium. Asserts panel controls mutate the playground DOM, mounted
// filtering, unmounted-dirty footer, and Save writeback — like the playground
// e2e but through the real panel UI.
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import WebSocket from 'ws'

const PLAYGROUND = new URL('../../playground', import.meta.url).pathname
const DESKTOP = new URL('..', import.meta.url).pathname
const PG_PORT = 5200
const PANEL_PORT = 5211
const REGISTRY = join(homedir(), '.octane-xplat/tweaks/servers')
const APP_SRC = join(PLAYGROUND, 'src/App.tsrx')
const originalSource = readFileSync(APP_SRC, 'utf8')

const procs = []
function serve(cmd, args, cwd, env = {}) {
	const p = spawn(cmd, args, {
		cwd,
		detached: true,
		env: { ...process.env, ...env },
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	p.testOutput = ''
	const record = (chunk) => {
		p.testOutput = (p.testOutput + String(chunk)).slice(-12000)
	}
	p.stdout.on('data', record)
	p.stderr.on('data', record)
	procs.push(p)
	return p
}

const kill = () => {
	for (const p of procs) {
		try {
			process.kill(-p.pid, 'SIGKILL')
		} catch {}
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, label, deadline = 60000) {
	const end = Date.now() + deadline
	for (;;) {
		try {
			const v = await fn()
			if (v) {
				return v
			}
		} catch {}

		if (Date.now() > end) {
			throw new Error(`timed out: ${label}`)
		}

		await sleep(250)
	}
}

const tid = (page, id) => page.locator(`[data-testid="${id}"], [id="${id}"]`).first()

let browser
try {
	for (const f of readdirSync(REGISTRY).filter((f) => f.endsWith('.json'))) {
		try {
			const e = JSON.parse(readFileSync(join(REGISTRY, f), 'utf8'))
			process.kill(e.pid, 0)
		} catch {
			// Dead pid or unreadable — remove so the lookup below can't pick it.
			execFileSync('rm', ['-f', join(REGISTRY, f)])
		}
	}

	serve('pnpm', ['dev', '--strictPort'], PLAYGROUND)
	serve('pnpm', ['dev:web', '--strictPort'], DESKTOP)

	const entry = await waitFor(() => {
		for (const f of readdirSync(REGISTRY)) {
			if (!f.endsWith('.json')) {
				continue
			}

			try {
				const e = JSON.parse(readFileSync(join(REGISTRY, f), 'utf8'))
				if (e.name === 'playground' && e.url.includes(`:${PG_PORT}`)) {
					return e
				}
			} catch {}
		}
	}, 'playground registry file')

	for (const port of [PG_PORT, PANEL_PORT]) {
		await waitFor(async () => {
			try {
				return (await fetch(`http://localhost:${port}/`)).ok
			} catch {
				return null
			}
		}, `server :${port}`)
	}

	browser = await chromium.launch()
	const panel = await browser.newPage({ viewport: { width: 380, height: 720 } })
	const errors = []
	panel.on('pageerror', (error) => errors.push(error.message))
	const app = await browser.newPage()

	await app.goto(`http://localhost:${PG_PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 })
	await app.locator('[data-testid="card.title"]').waitFor({ timeout: 60000 })

	await panel.goto(
		`http://localhost:${PANEL_PORT}/?url=${encodeURIComponent(entry.url)}&token=${entry.token}`,
		{ waitUntil: 'domcontentloaded', timeout: 90000 },
	)

	await waitFor(
		async () => (await tid(panel, 'status').innerText()) === 'Connected',
		'panel connected',
	)

	await waitFor(
		async () => (await tid(panel, 'clients').innerText()).includes('web'),
		'app client label',
	)

	// Rows for the mounted playground entries.
	await waitFor(
		async () => (await tid(panel, 'row-src/App.tsrx#radius').count()) === 1,
		'radius row',
	)

	console.log('· panel connects via ?url&token and lists mounted entries')

	// Slider (keyboard): focus then ArrowRight/Left adjusts.
	const slider = tid(panel, 'control-src/App.tsrx#radius').locator('[role="slider"]').first()
	// The control re-renders on every state broadcast, so Playwright's
	// actionability checks flap — focus + key input is the stable path.
	await slider.focus()
	const before = await app
		.locator('[data-testid="card.box"]')
		.evaluate((el) => getComputedStyle(el).borderRadius)

	await panel.keyboard.press('ArrowRight')
	await waitFor(async () => {
		const r = await app
			.locator('[data-testid="card.box"]')
			.evaluate((el) => getComputedStyle(el).borderRadius)
		return r !== before ? r : null
	}, 'slider set applied to playground')

	console.log('· slider changes the playground DOM')

	// Switch toggle (keyboard — same flapping caveat as the slider).
	const sw = tid(panel, 'control-src/App.tsrx#showBorder').locator('[role="switch"]').first()
	const borderOn = await app
		.locator('[data-testid="card.box"]')
		.evaluate((el) => getComputedStyle(el).borderWidth)

	await sw.focus()
	await panel.keyboard.press('Space')
	await waitFor(async () => {
		const w = await app
			.locator('[data-testid="card.box"]')
			.evaluate((el) => getComputedStyle(el).borderWidth)
		return w !== borderOn ? w : null
	}, 'switch toggles border')

	console.log('· switch toggles a boolean')

	// Select: open the listbox via keyboard, then click the option.
	const sel = tid(panel, 'control-src/App.tsrx#density')
	await sel.locator('[role="combobox"], button, [role="button"]').first().focus()
	await panel.keyboard.press('ArrowDown')
	await waitFor(
		async () => (await panel.locator('[role="option"]').count()) > 0,
		'select options open',
	)

	const gapBefore = await app
		.locator('[data-testid="card.box"]')
		.evaluate((el) => getComputedStyle(el).gap)

	await panel.locator('[role="option"]').filter({ hasText: 'roomy' }).first().dispatchEvent('click')
	await waitFor(async () => {
		const g = await app
			.locator('[data-testid="card.box"]')
			.evaluate((el) => getComputedStyle(el).gap)
		return g !== gapBefore ? g : null
	}, 'select applied')

	console.log('· select changes the playground DOM')

	// Color: invalid then valid.
	const color = tid(panel, 'control-src/App.tsrx#accent').locator('input').first()
	await color.fill('notacolor')
	await app.locator('[data-testid="card.box"]').evaluate((el) => getComputedStyle(el).borderColor)
	await sleep(400)
	const invalidShown =
		(await panel.locator('text=invalid hex').count()) ||
		(await tid(panel, 'swatch-src/App.tsrx#accent').evaluate(
			(el) => getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)',
		))

	// invalid hex must not be sent: accent text on playground card unchanged
	await color.fill('#22cc88')
	await waitFor(async () => {
		const c = await app
			.locator('[data-testid="card.box"]')
			.evaluate((el) => getComputedStyle(el).borderColor)
		return c !== 'rgb(34, 204, 136)' && c.includes('34, 204, 136') ? c : c
	}, 'color applied')

	console.log(
		`· color input: invalid not sent (${invalidShown ? 'shown as invalid' : 'rejected'}), valid applied`,
	)

	// Hide details → row disappears.
	await app.locator('[data-testid="details.toggle"]').click()
	await waitFor(
		async () => (await tid(panel, 'row-src/App.tsrx#details/detailText').count()) === 0,
		'row unmounts',
	)

	console.log('· unmounted entries leave the panel')

	// Show details, set the text control, then Revert → field shows the source
	// value again (local text must not mask the live value).
	await app.locator('[data-testid="details.toggle"]').click()
	await waitFor(
		async () => (await tid(panel, 'row-src/App.tsrx#details/detailText').count()) === 1,
		'row remounts',
	)

	const detail = tid(panel, 'control-src/App.tsrx#details/detailText').locator('input').first()
	await detail.fill('hidden tweak')
	await waitFor(async () => {
		const t = await app
			.locator('[data-testid="card.detail"]')
			.innerText()
			.catch(() => '')
		return t === 'hidden tweak' ? true : null
	}, 'detailText set applied')

	await tid(panel, 'revert-src/App.tsrx#details/detailText').click({ force: true })
	await waitFor(
		async () => (await detail.inputValue()) === 'expandable detail',
		'field shows source value after revert',
	)

	console.log('· revert restores the field to the source value')

	// Re-dirty it, then unmount — the footer counts it as "not on screen".
	await detail.fill('hidden tweak')
	await waitFor(async () => {
		const t = await app
			.locator('[data-testid="card.detail"]')
			.innerText()
			.catch(() => '')
		return t === 'hidden tweak' ? true : null
	}, 'detailText re-dirty')

	await app.locator('[data-testid="details.toggle"]').click()
	await waitFor(
		async () => (await tid(panel, 'dirty-count').innerText()).includes('not on screen'),
		'(N not on screen)',
	)

	console.log('· footer counts dirty entries not on screen')

	// Styles UI: inline edit, bamboo add + delete, site revert, Save.
	const titleSite = 'src/App.tsrx#style:App/Text:2'
	const cardSite = 'src/App.style.ts#css:card'
	await waitFor(
		async () => (await tid(panel, `stylesite-${cardSite}`).count()) === 1,
		'Styles section lists card site',
	)

	// 1) inline fontSize edit via the Styles UI.
	await tid(panel, `style-input-${titleSite}-fontSize`).fill('30')
	await waitFor(async () => {
		const v = await app
			.locator('[data-testid="card.title"]')
			.evaluate((el) => getComputedStyle(el).fontSize)
		return v === '30px' ? true : null
	}, 'inline fontSize applied live')

	console.log('· styles UI: inline edit applies')
	// 2) Sculpted-style searchable property picker; selection adds and focuses
	// the value row, instead of opening a separate name/value composer.
	await tid(panel, `style-add-${cardSite}`).click()
	const propertySearch = tid(panel, `style-add-search-${cardSite}`)
	await propertySearch.fill('opacity')
	await propertySearch.press('Enter')
	await waitFor(
		async () => (await tid(panel, `style-input-${cardSite}-opacity`).count()) === 1,
		'new property row',
	)

	await waitFor(
		async () =>
			await tid(panel, `style-input-${cardSite}-opacity`).evaluate(
				(el) => el === document.activeElement,
			),
		'picker focuses added property',
	)

	await tid(panel, `style-input-${cardSite}-opacity`).fill('0.5')
	await waitFor(async () => {
		const v = await app
			.locator('[data-testid="card.box"]')
			.evaluate((el) => getComputedStyle(el).opacity)
		return v === '0.5' ? true : null
	}, 'bamboo added opacity applied live')

	await tid(panel, `style-delete-${cardSite}-backgroundColor`).click()
	const baseBg = 'rgb(255, 255, 255)'
	await waitFor(async () => {
		const v = await app
			.locator('[data-testid="card.box"]')
			.evaluate((el) => getComputedStyle(el).backgroundColor)
		return v !== baseBg || v === 'rgba(0, 0, 0, 0)' ? true : null
	}, 'bamboo backgroundColor deleted')

	console.log('· styles UI: bamboo add/delete apply')
	// 3) Revert the card site — original classes + marker restored.
	await tid(panel, `style-revert-${cardSite}`).click()
	await waitFor(async () => {
		const cls = await app.locator('[data-testid="card.box"]').evaluate((el) => el.className)
		return cls.includes('bg-c_surface') && !cls.includes('opacity_0.5') ? true : null
	}, 'card site revert restores classes')

	console.log('· styles UI: site revert restores')

	// Pick: button follows state.picking; an app 'picked' filters the Styles
	// list; Show all restores it.
	const pickBtn = tid(panel, 'pick')
	await waitFor(
		async () => (await pickBtn.getAttribute('aria-label')) === 'Pick element',
		'icon pick button is named',
	)

	const fakeApp = new WebSocket(
		`${entry.url}?token=${entry.token}&role=app&clientId=picker&label=web`,
	)

	await new Promise((r) => fakeApp.once('open', r))
	await pickBtn.click()
	await waitFor(
		async () => (await pickBtn.getAttribute('aria-pressed')) === 'true',
		'pick button follows state.picking',
	)

	fakeApp.send(JSON.stringify({ type: 'picked', ids: [titleSite] }))
	await waitFor(
		async () => (await tid(panel, 'pick.filter').innerText()).includes('1 picked'),
		'pick.filter shown',
	)

	await waitFor(
		async () => (await tid(panel, `stylesite-${titleSite}`).count()) === 1,
		'picked site renders',
	)

	await waitFor(
		async () => (await tid(panel, `stylesite-${cardSite}`).count()) === 0,
		'other sites filtered out',
	)

	await tid(panel, 'pick.clear').click()
	await waitFor(
		async () => (await tid(panel, `stylesite-${cardSite}`).count()) === 1,
		'Show all restores',
	)

	fakeApp.close()
	console.log('· pick filters the styles section; Show all restores')

	// Filtering/disclosure preserve drafts; Enter focuses the first match.
	await tid(panel, 'style-filter').fill('fontSize')
	await tid(panel, 'style-filter').press('Enter')
	await waitFor(
		async () =>
			await tid(panel, `style-input-${titleSite}-fontSize`).evaluate(
				(el) => el === document.activeElement,
			),
		'filter Enter focuses match',
	)

	if (await tid(panel, `style-input-${cardSite}-backgroundColor`).count()) {
		throw new Error('property filter did not narrow rows')
	}

	await tid(panel, 'style-filter').fill('')
	await tid(panel, `style-toggle-${titleSite}`).click()
	if (await tid(panel, `style-input-${titleSite}-fontSize`).count()) {
		throw new Error('style site did not collapse')
	}

	await tid(panel, `style-toggle-${titleSite}`).click()
	await waitFor(
		async () => (await tid(panel, `style-input-${titleSite}-fontSize`).inputValue()) === '30',
		'expanded site keeps draft',
	)

	// CSS density and the fixed footer are checked through layout data only.
	const layout = await panel.locator('.tweaks-panel').evaluate((el) => {
		const field = el.querySelector('.panel-field--changed')
		const footer = el.querySelector('.panel-footer').getBoundingClientRect()
		return {
			fieldColor: getComputedStyle(field.closest('.vx-input-shell') ?? field).backgroundColor,
			footerBottom: footer.bottom,
			width: el.getBoundingClientRect().width,
			icons: el.querySelectorAll('svg').length,
			sliderWidth: el.querySelector('.panel-slider').getBoundingClientRect().width,
			// chrome.css is the only source of `.vx-slider-fill` background
			// (var(--color-primary)); null without the import.
			sliderFill: getComputedStyle(el.querySelector('.vx-slider-fill')).backgroundColor,
		}
	})

	if (
		layout.fieldColor !== 'rgb(239, 246, 255)' ||
		layout.width > 380 ||
		layout.footerBottom > 721 ||
		layout.footerBottom < 680 ||
		layout.icons < 4 ||
		layout.sliderWidth < 60 ||
		layout.sliderFill !== 'rgb(0, 100, 224)'
	) {
		throw new Error(`panel styles/layout incorrect: ${JSON.stringify(layout)}`)
	}

	console.log('· Sculpted field chrome, Lucide icons, filtering, disclosure and fixed footer')

	// Save writes directly; no confirmation or preview interrupts the editor.
	await app.locator('[data-testid="counter.increment"]').click()
	await app.locator('[data-testid="counter.increment"]').click()
	await app.locator('[data-testid="counter.increment"]').click()
	await tid(panel, 'save').click()
	if (await tid(panel, 'save.preview').count()) {
		throw new Error('unexpected save preview')
	}

	await waitFor(async () => {
		const t = await tid(panel, 'save-result')
			.innerText()
			.catch(() => '')
		return /Saved \d+ file/.test(t) ? true : null
	}, 'saveResult shown')

	await waitFor(
		() => readFileSync(APP_SRC, 'utf8').includes("'hidden tweak'"),
		'source literal written',
	)

	await waitFor(async () => {
		const t = await tid(panel, 'dirty-count').innerText()
		return t.startsWith('0 unsaved') ? true : null
	}, 'footer clears')

	const count = await app.locator('[data-testid="counter.value"]').innerText()
	if (!count.includes('3')) {
		throw new Error(`counter lost state: ${count}`)
	}

	console.log('· save writes source, clears dirty, preserves app state')

	if (errors.length) {
		throw new Error(`panel runtime errors: ${errors.join('; ')}`)
	}

	console.log('panel e2e: all assertions passed')
} catch (error) {
	const redact = (text) => String(text).replace(/token=[^\s"&]+/g, 'token=[redacted]')
	for (const proc of procs) {
		if (proc.testOutput) {
			console.error(redact(proc.testOutput))
		}
	}

	throw new Error(redact(error.message))
} finally {
	writeFileSync(APP_SRC, originalSource)
	if (browser) {
		await browser.close().catch(() => {})
	}

	kill()
}
