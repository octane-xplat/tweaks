// iOS simulator verification for @octane-xplat/tweaks.
// Full mode: scaffold the pinned create-octane-xplat template into a temp dir,
// pack+install the tweaks packages, copy fixtures/ios-app over the template,
// then drive `xplat dev <UDID>` and assert the tweaks protocol end to end.
// --app <dir>: reuse an already-prepared app directory instead of scaffolding.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import WebSocket from 'ws'

const REPO = path.resolve(new URL('../../', import.meta.url).pathname)
const FIXTURE = path.join(REPO, 'fixtures/ios-app')
const ARTIFACTS = path.join(REPO, 'artifacts/ios')
const REGISTRY = path.join(homedir(), '.octane-xplat/tweaks/servers')
const LOG_FILE = path.join(ARTIFACTS, 'dev-session.log')
const TEMPLATE_VERSION = '0.17.1'
const UDID = process.env.IOS_UDID ?? pickUdid()

function pickUdid() {
	if (process.env.IOS_UDID) { return process.env.IOS_UDID }
	const out = JSON.parse(execFileSync(
		'xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' }))
	for (const list of Object.values(out.devices)) {
		for (const d of list) {
			if (d.name && d.name.includes('iPhone')) { return d.udid }
		}
	}
	throw new Error('no available iPhone simulator')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, label, deadline = 240000) {
	const end = Date.now() + deadline
	for (;;) {
		try {
			const v = await fn()
			if (v) { return v }
		} catch {}
		if (Date.now() > end) { throw new Error(`timed out: ${label}`) }
		await sleep(500)
	}
}
function run(cmd, args, cwd, env) {
	const result = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' })
	if (result.status !== 0) { throw new Error(`${cmd} ${args.join(' ')} failed (${result.status})`) }
}

const argIndex = process.argv.indexOf('--app')
let appDir = argIndex >= 0 ? path.resolve(process.argv[argIndex + 1]) : null
const appRoot = (dir) => fs.realpathSync(dir).replace(/[/\\]+$/, '')
let tempDir = null
fs.mkdirSync(ARTIFACTS, { recursive: true })

// Prepare the app: scaffold + install + fixture copy unless --app was given.
if (!appDir) {
	tempDir = fs.mkdtempSync(path.join(REPO, 'artifacts/ios/app-'))
	appDir = path.join(tempDir, 'tweaks-ios-app')
	fs.mkdirSync(appDir, { recursive: true })
	run('pnpm', ['dlx', `create-octane-xplat@${TEMPLATE_VERSION}`, appDir, '--targets=ios', '--no-install'], tempDir)
	run('pnpm', ['install'], appDir)
	// Pack the workspace tweaks packages and install the tarballs as a
	// consumer would. tweaks-vite depends on @octane-xplat/tweaks@x.y.z —
	// resolve it to the packed file through a pnpm override.
	const packDir = path.join(tempDir, 'pack')
	fs.mkdirSync(packDir, { recursive: true })
	run('pnpm', ['--filter', '@octane-xplat/tweaks', 'pack', '--pack-destination', packDir], REPO)
	run('pnpm', ['--filter', '@octane-xplat/tweaks-vite', 'pack', '--pack-destination', packDir], REPO)
	const tweaksTgz = fs.readdirSync(packDir).find((f) => f.startsWith('octane-xplat-tweaks-0'))
	const viteTgz = fs.readdirSync(packDir).find((f) => f.startsWith('octane-xplat-tweaks-vite-0'))
	run('pnpm', ['add', path.join(packDir, tweaksTgz)], appDir)
	const wsFile = path.join(appDir, 'pnpm-workspace.yaml')
	let ws = fs.readFileSync(wsFile, 'utf8')
	ws = ws.replace('overrides:', `overrides:\n  "@octane-xplat/tweaks": "file:${path.join(packDir, tweaksTgz)}"`)
	fs.writeFileSync(wsFile, ws)
	run('pnpm', ['add', '-D', path.join(packDir, viteTgz)], appDir)
}
for (const f of fs.readdirSync(FIXTURE)) {
	if (f.startsWith('vite.config')) { continue }
	fs.copyFileSync(path.join(FIXTURE, f), path.join(appDir, 'src', f))
}
// vite.config.native.mts lives at the app root, not under src/.
fs.copyFileSync(path.join(FIXTURE, 'vite.config.native.mts'), path.join(appDir, 'vite.config.native.mts'))

const logStream = fs.createWriteStream(LOG_FILE)
// `ns` boots devices via `open <Developer>/Applications/Simulator.app`, which
// fails under a partial Xcode xcode-select; a booted device is found directly.
// The only simulator is shared with other tasks — shut down at the end only
// when this harness is the one that booted it.
const wasBooted = (() => {
	try {
		const out = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' }))
		for (const list of Object.values(out.devices)) {
			for (const d of list) {
				if (d.udid === UDID) { return d.state === 'Booted' }
			}
		}
	} catch {}
	return false
})()
try {
	execFileSync('xcrun', ['simctl', 'boot', UDID])
} catch {}
// Wait for full device readiness — installing on a still-booting device
// fails with 'Unable to get application path on device'.
try {
	execFileSync('xcrun', ['simctl', 'bootstatus', UDID], { timeout: 120000 })
} catch {}

// Killed dev sessions leave `target_busy` — end stale sessions on this target
// from the app cwd before starting ours.
try {
	const out = execFileSync('pnpm', ['exec', 'xplat', 'session', 'list'], {
		cwd: appDir,
		env: { ...process.env, DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer' },
		encoding: 'utf8',
	})
	for (const line of out.split('\n')) {
		const m = line.match(/^(sess_[a-f0-9-]+).*on\s+(\S+)/)
		if (m && m[2] === UDID) {
			try {
				execFileSync('pnpm', ['exec', 'xplat', 'session', 'end', m[1]], { cwd: appDir })
			} catch {}
		}
	}
} catch {}
for (const f of (fs.existsSync(REGISTRY) ? fs.readdirSync(REGISTRY) : [])) {
	try {
		const e = JSON.parse(fs.readFileSync(path.join(REGISTRY, f), 'utf8'))
		if (e.root === appDir || e.root === appDir + path.sep) { fs.unlinkSync(path.join(REGISTRY, f)) }
	} catch {}
}

// The published ui package ships src/ whose extensionless imports the vendor
// esbuild cannot resolve; sourceOnlyDeps misses it (exports has a "." key), so
// exclude it (and the tweaks runtime) from the vendor bundle for per-module
// serving, which the octane transform does cover.
const dev = spawn('pnpm', ['exec', 'xplat', 'dev', UDID], {
	cwd: appDir,
	env: {
		...process.env,
		DEVELOPER_DIR: process.env.DEVELOPER_DIR ?? '/Applications/Xcode.app/Contents/Developer',
		NS_VENDOR_EXCLUDE:
			[process.env.NS_VENDOR_EXCLUDE, '@octane-xplat/ui', '@octane-xplat/tweaks'].filter(Boolean).join(','),
	},
	stdio: ['ignore', 'pipe', 'pipe'],
})
dev.stdout.on('data', (d) => { logStream.write(d); process.stdout.write(d) })
dev.stderr.on('data', (d) => { logStream.write(d); process.stderr.write(d) })
// Read the log incrementally: byte offsets stay valid as the file grows
// (a fixed-size tail slice would drift and miss earlier lines).
let logPos = 0
// Overlap reads so a line split across two writes is still matched — a pure
// byte-offset read loses the boundary half on each side.
const newLog = () => {
	const content = fs.readFileSync(LOG_FILE, 'utf8')
	const chunk = content.slice(Math.max(0, logPos - 256))
	logPos = content.length
	return chunk
}
const devLog = () => fs.readFileSync(LOG_FILE, 'utf8').slice(-4000)

try {
	const entry = await waitFor(() => {
		for (const f of fs.readdirSync(REGISTRY)) {
			try {
				const e = JSON.parse(fs.readFileSync(path.join(REGISTRY, f), 'utf8'))
				if (appRoot(e.root) === appRoot(appDir)) { return e }
			} catch {}
		}
	}, 'tweaks registry entry', 420000)
	console.log('· registry:', entry.url)
	const panel = new WebSocket(`${entry.url}?token=${entry.token}&role=panel&clientId=ios-e2e&label=panel`)
	panel.on('error', () => {})
	const inbox = []
	const waiters = []
	let state = null
	panel.on('message', (d) => {
		const m = JSON.parse(String(d))
		// Keep the latest state snapshot: clients/entries/styles update on
		// every broadcast, and assertions poll this rather than a stale copy.
		if (m.type === 'state') { state = m }
		const i = waiters.findIndex((w) => w.type === m.type)
		if (i >= 0) { waiters.splice(i, 1)[0].resolve(m) } else { inbox.push(m) }
	})
	const next = (type, ms = 20000) =>
		new Promise((resolve, reject) => {
			const buffered = inbox.findIndex((m) => m.type === type)
			if (buffered >= 0) { return resolve(inbox.splice(buffered, 1)[0]) }
			const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms)
			waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m) } })
		})
	await new Promise((r, j) => { panel.once('open', r); panel.once('error', j) })
	await next('state')
	if (!state) { throw new Error('no initial state message') }

	// The app client mounts tweaks and inline style sites.
	await waitFor(() => {
		const c = state.clients.find((x) => x.label === 'native' || x.label === 'ios')
		return c && state.entries.length ? true : null
	}, 'native client mounts entries')
	const ids = state.entries.map((e) => e.id)
	if (!ids.some((id) => id.endsWith('/title') || id.endsWith('#title'))) { throw new Error(`title tweak missing: ${ids}`) }
	const titleTweak = ids.find((id) => id.endsWith('/title') || id.endsWith('#title'))
	const styleIds = state.styles.map((s) => s.id)
	if (!styleIds.some((id) => id.includes('#style:'))) { throw new Error(`no inline style sites: ${styleIds}`) }
	const titleStyle = state.styles.find((s) => s.id.includes('#style:'))
	console.log(`· native client: ${state.entries.length} tweaks, ${state.styles.length} style sites`)

	// set title → the device re-renders (asserted via the native render log).
	newLog()
	panel.send(JSON.stringify({ type: 'set', id: titleTweak, value: 'iOS tweaked' }))
	await waitFor(() => newLog().includes('[tweaks-render] iOS tweaked') ? true : null,
		'device renders new title', 600000)
	console.log('· set renders on the simulator')

	// styleSet on the inline fontSize → draft broadcast to panel (the shared
	// __tw merge path is the same code the web e2e proves on DOM).
	panel.send(JSON.stringify({ type: 'styleSet', id: titleStyle.id, path: ['fontSize'], value: 30 }))
	await waitFor(() => {
		const site = state && state.styles.find((s) => s.id === titleStyle.id)
		return site && site.dirty ? true : null
	}, 'style site dirty')
	console.log('· styleSet accepted and broadcast')

	// Revert restores the literal title on the device.
	newLog()
	panel.send(JSON.stringify({ type: 'revert' }))
	await waitFor(() => newLog().includes('[tweaks-render] Tweak me') ? true : null,
		'revert restores the literal title', 600000)
	console.log('· revert restores on the simulator')
	console.log('ios e2e: all assertions passed')
} catch (error) {
	console.error(error)
	console.error('dev log tail:\n' + devLog())
	process.exitCode = 1
} finally {
	dev.kill('SIGTERM')
	await sleep(300)
	dev.kill('SIGKILL')
	logStream.end()
	if (!wasBooted) {
		try {
			execFileSync('xcrun', ['simctl', 'shutdown', UDID])
		} catch {}
	}
	// Keep the scaffolded app on failure so `--app` can rerun cheaply; on
	// success clean it up unless KEEP_IOS_APP is set.
	if (tempDir && (process.exitCode !== 1 || process.env.KEEP_IOS_APP === '1')) {
		fs.rmSync(tempDir, { recursive: true, force: true })
	} else if (tempDir) {
		console.log(`kept app for debugging: ${appDir}`)
	}
}
