// Android emulator verification for @octane-xplat/tweaks.
// Full mode: scaffold the pinned create-octane-xplat template into a temp dir,
// pack+install the tweaks packages, copy fixtures/ios-app over the template
// (the fixture sources are shared — its main.ts already covers Android's
// Application.started re-entry path), boot an octane* AVD, then drive
// `xplat dev <serial>` and assert the tweaks protocol end to end.
// --app <dir>: reuse an already-prepared app directory instead of scaffolding.
// The emulator is a shared resident device: when this script is not already
// inside a goddard resource reservation it re-execs itself under one
// (android:<AVD> exclusive + native build capacity). ANDROID_SERIAL skips
// boot entirely — the caller owns that device.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import WebSocket from 'ws'

const REPO = path.resolve(new URL('../../', import.meta.url).pathname)
const FIXTURE = path.join(REPO, 'fixtures/ios-app')
const ARTIFACTS = path.join(REPO, 'artifacts/android')
const REGISTRY = path.join(homedir(), '.octane-xplat/tweaks/servers')
const LOG_FILE = path.join(ARTIFACTS, 'dev-session.log')
const TEMPLATE_VERSION = '0.17.1'
const ANDROID_SDK =
	process.env.ANDROID_HOME ??
	process.env.ANDROID_SDK_ROOT ??
	path.join(homedir(), 'Library/Android/sdk')
const ADB = which('adb') ?? path.join(ANDROID_SDK, 'platform-tools/adb')
const EMULATOR = which('emulator') ?? path.join(ANDROID_SDK, 'emulator/emulator')
const AVD = process.env.ANDROID_AVD ?? pickAvd()

function which(cmd) {
	try {
		return execFileSync('which', [cmd], { encoding: 'utf8' }).trim() || null
	} catch {
		return null
	}
}
function pickAvd() {
	if (process.env.ANDROID_AVD) { return process.env.ANDROID_AVD }
	const out = execFileSync(EMULATOR, ['-list-avds'], { encoding: 'utf8' })
	const avds = out.split('\n').map((l) => l.trim()).filter(Boolean)
	// octane* AVDs are the shared verification devices on this host.
	return avds.find((a) => a.startsWith('octane')) ?? avds[0] ?? fail('no AVDs — create one with avdmanager')
}
function fail(msg) {
	console.error(msg)
	process.exit(1)
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
function adb(args, opts = {}) {
	return execFileSync(ADB, args, { encoding: 'utf8', ...opts }).trim()
}
// Serials of online emulators plus the AVD each one runs (`emu avd name`).
function emulatorSerials() {
	const out = adb(['devices'])
	const serials = []
	for (const line of out.split('\n').slice(1)) {
		const [serial, state] = line.split(/\s+/)
		if (!serial?.startsWith('emulator-') || state !== 'device') { continue }
		try {
			const name = adb(['-s', serial, 'emu', 'avd', 'name']).split('\n')[0].trim()
			serials.push({ serial, name })
		} catch {}
	}
	return serials
}

// Re-exec under a goddard reservation when this run will boot/touch the
// emulator and no reservation is active — other tasks share these AVDs.
// Skipped when ANDROID_SERIAL names a device the caller already owns.
if (
	!process.env.GODDARD_RESOURCE_RESERVATION &&
	!process.env.ANDROID_SERIAL &&
	which('goddard-agent')
) {
	const req = JSON.stringify({
		resources: {
			exclusive: [`android:${AVD}`],
			resident_devices: 1,
			native_builds: 1,
		},
		purpose: 'tweaks android verification',
		wait_seconds: 3600,
	})
	const result = spawnSync(
		'goddard-agent',
		['resource', 'run', '--json', req, '--', process.execPath, ...process.argv.slice(1)],
		{ stdio: 'inherit', env: process.env },
	)
	process.exit(result.status ?? 1)
}

const argIndex = process.argv.indexOf('--app')
let appDir = argIndex >= 0 ? path.resolve(process.argv[argIndex + 1]) : null
const appRoot = (dir) => fs.realpathSync(dir).replace(/[/\\]+$/, '')
let tempDir = null
fs.mkdirSync(ARTIFACTS, { recursive: true })

// Prepare the app: scaffold + install + fixture copy unless --app was given.
if (!appDir) {
	tempDir = fs.mkdtempSync(path.join(REPO, 'artifacts/android/app-'))
	appDir = path.join(tempDir, 'tweaks-android-app')
	fs.mkdirSync(appDir, { recursive: true })
	run('pnpm', ['dlx', `create-octane-xplat@${TEMPLATE_VERSION}`, appDir, '--targets=android', '--no-install'], tempDir)
	run('pnpm', ['install'], appDir)
	// Pack the tweaks package and install the tarball as a consumer would —
	// the fixture's plugin import is the ./vite subpath of the same tarball
	// (prepack emits dist/vite).
	const packDir = path.join(tempDir, 'pack')
	fs.mkdirSync(packDir, { recursive: true })
	run('pnpm', ['--filter', '@octane-xplat/tweaks', 'pack', '--pack-destination', packDir], REPO)
	const tweaksTgz = fs.readdirSync(packDir).find((f) => f.startsWith('octane-xplat-tweaks-0'))
	run('pnpm', ['add', path.join(packDir, tweaksTgz)], appDir)
}
for (const f of fs.readdirSync(FIXTURE)) {
	if (f.startsWith('vite.config')) { continue }
	fs.copyFileSync(path.join(FIXTURE, f), path.join(appDir, 'src', f))
}
// vite.config.native.mts lives at the app root, not under src/.
fs.copyFileSync(path.join(FIXTURE, 'vite.config.native.mts'), path.join(appDir, 'vite.config.native.mts'))

const logStream = fs.createWriteStream(LOG_FILE)
// Device selection: ANDROID_SERIAL wins; then an already-booted emulator
// running the chosen AVD; otherwise boot it ourselves and shut it down after.
const { serial: SERIAL, wasBooted } = await (async () => {
	if (process.env.ANDROID_SERIAL) {
		return { serial: process.env.ANDROID_SERIAL, wasBooted: true }
	}
	const booted = emulatorSerials().find((e) => e.name === AVD)
	if (booted) {
		console.log(`· emulator already booted: ${booted.serial} (${AVD})`)
		return { serial: booted.serial, wasBooted: true }
	}
	console.log(`· booting AVD ${AVD}`)
	const before = new Set(emulatorSerials().map((e) => e.serial))
	const emu = spawn(EMULATOR, ['-avd', AVD, '-no-snapshot-save', '-no-audio', '-gpu', 'swiftshader_indirect'], {
		stdio: 'ignore',
	})
	emu.unref()
	try {
		const found = await waitFor(() => {
			const e = emulatorSerials().find((x) => x.name === AVD && !before.has(x.serial))
			return e ? e.serial : null
		}, `emulator for ${AVD} to appear in adb devices`, 300000)
		adb(['-s', found, 'wait-for-device'])
		await waitFor(
			() => adb(['-s', found, 'shell', 'getprop', 'sys.boot_completed']) === '1',
			'sys.boot_completed',
			300000,
		)
		// Package manager settles after boot_completed; installing too early
		// loses the app or hangs the gradle deploy step.
		await sleep(10000)
		return { serial: found, wasBooted: false }
	} catch (error) {
		// Failed mid-boot — kill whatever partially came up before bailing.
		for (const e of emulatorSerials()) {
			if (e.name === AVD && !before.has(e.serial)) {
				try { adb(['-s', e.serial, 'emu', 'kill']) } catch {}
			}
		}
		throw error
	}
})()
console.log(`· device: ${SERIAL}`)

// Killed dev sessions leave `target_busy` — end stale sessions on this target
// from the app cwd before starting ours.
try {
	const out = execFileSync('pnpm', ['exec', 'xplat', 'session', 'list'], {
		cwd: appDir,
		encoding: 'utf8',
	})
	for (const line of out.split('\n')) {
		const m = line.match(/^(sess_[a-f0-9-]+).*on\s+(\S+)/)
		if (m && (m[2] === SERIAL || m[2] === AVD)) {
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
// serving, which the octane transform does cover. Same template bug as iOS.
const dev = spawn('pnpm', ['exec', 'xplat', 'dev', SERIAL], {
	cwd: appDir,
	env: {
		...process.env,
		ANDROID_HOME: ANDROID_SDK,
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
	const panel = new WebSocket(`${entry.url}?token=${entry.token}&role=panel&clientId=android-e2e&label=panel`)
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
		const c = state.clients.find((x) => x.label === 'native' || x.label === 'android')
		return c && state.entries.length ? true : null
	}, 'native client mounts entries', 900000)
	const ids = state.entries.map((e) => e.id)
	if (!ids.some((id) => id.endsWith('/title') || id.endsWith('#title'))) { throw new Error(`title tweak missing: ${ids}`) }
	const titleTweak = ids.find((id) => id.endsWith('/title') || id.endsWith('#title'))
	const styleIds = state.styles.map((s) => s.id)
	if (!styleIds.some((id) => id.includes('#style:'))) { throw new Error(`no inline style sites: ${styleIds}`) }
	const titleStyle = state.styles.find((s) => s.id.includes('#style:'))
	console.log(`· native client: ${state.entries.length} tweaks, ${state.styles.length} style sites`)

	// set title → the device re-renders (asserted via the native render log
	// streamed by `ns run`; the first wait absorbs the cold gradle build).
	newLog()
	panel.send(JSON.stringify({ type: 'set', id: titleTweak, value: 'Android tweaked' }))
	await waitFor(() => newLog().includes('[tweaks-render] Android tweaked') ? true : null,
		'device renders new title', 900000)
	console.log('· set renders on the emulator')

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
		'revert restores the literal title', 900000)
	console.log('· revert restores on the emulator')
	console.log('android e2e: all assertions passed')
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
			adb(['-s', SERIAL, 'emu', 'kill'])
		} catch {}
	}
	// Keep the scaffolded app on failure so `--app` can rerun cheaply; on
	// success clean it up unless KEEP_ANDROID_APP is set.
	if (tempDir && (process.exitCode !== 1 || process.env.KEEP_ANDROID_APP === '1')) {
		fs.rmSync(tempDir, { recursive: true, force: true })
	} else if (tempDir) {
		console.log(`kept app for debugging: ${appDir}`)
	}
}
