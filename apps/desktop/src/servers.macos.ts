// Discover dev servers from ~/.octane-xplat/tweaks/servers/*.json, polled every
// 2s. Unreadable dirs or malformed entries are skipped; connectivity failures
// are handled by the model's status/retry, not here.
import { NSFileManager, NSHomeDirectory, NSString } from '@octane-xplat/platform/macos'
import type { PanelServerInfo } from './model'

function readEntries(): PanelServerInfo[] {
	const dir = `${NSHomeDirectory()}/.octane-xplat/tweaks/servers`
	const manager = NSFileManager.defaultManager
	let names: any
	try {
		names = manager.contentsOfDirectoryAtPathError(dir, null)
	} catch {
		return []
	}
	if (!names) return []
	const out: PanelServerInfo[] = []
	for (let i = 0; i < names.count; i++) {
		const name = String(names.objectAtIndex(i))
		if (!name.endsWith('.json')) continue
		try {
			const text = NSString.stringWithContentsOfFileEncodingError(
				`${dir}/${name}`,
				4, // NSUTF8StringEncoding
				null,
			)
			const entry = JSON.parse(String(text))
			if (entry?.url && entry?.token) {
				out.push({
					url: entry.url,
					token: entry.token,
					name: entry.name ?? name,
					root: entry.root ?? '',
					pid: entry.pid,
					reachable: true,
				})
			}
		} catch {
			// skip malformed entry
		}
	}
	return out
}

export function pollServers(callback: (servers: PanelServerInfo[]) => void): () => void {
	const tick = () => callback(readEntries())
	tick()
	const timer = setInterval(tick, 2000)
	return () => clearInterval(timer)
}
