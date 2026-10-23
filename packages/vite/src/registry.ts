import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function contentHash(content: string): string {
	return createHash('sha256').update(content).digest('hex')
}

// Discovery registry: the (future) desktop panel scans this directory for
// running dev servers. Directory 0700, files 0600 — entries contain tokens.
export function registryDir(): string {
	return path.join(os.homedir(), '.octane-xplat', 'tweaks', 'servers')
}

export interface RegistryEntry {
	version: 1
	pid: number
	url: string
	token: string
	name: string
	root: string
	startedAt: string
}

export function writeRegistry(entry: RegistryEntry): string {
	const dir = registryDir()
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
	const file = path.join(dir, `${process.pid}.json`)
	fs.writeFileSync(file, JSON.stringify(entry, null, 2), { mode: 0o600 })
	return file
}

export function removeRegistry(): void {
	try {
		fs.rmSync(path.join(registryDir(), `${process.pid}.json`), { force: true })
	} catch {
		// Best-effort cleanup only.
	}
}

// Drop entries whose pid is dead — stale files from crashed dev servers.
export function sweepRegistry(): void {
	let files: string[]
	try {
		files = fs.readdirSync(registryDir())
	} catch {
		return
	}
	for (const file of files) {
		const pid = Number(path.basename(file, '.json'))
		if (!Number.isInteger(pid) || pid === process.pid) continue
		try {
			process.kill(pid, 0)
		} catch {
			try {
				fs.rmSync(path.join(registryDir(), file), { force: true })
			} catch {
				// ignore
			}
		}
	}
}

export function newToken(): string {
	return randomUUID()
}
