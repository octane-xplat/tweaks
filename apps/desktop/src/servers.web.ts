import type { PanelServerInfo } from './model'

// Web build: ?url=…&token=… pins a single server (used by the e2e). Without
// params, poll the dev server's /__tweaks_servers endpoint, which serves the
// local registry (~/.octane-xplat/tweaks/servers/*.json) that browsers can't
// read directly — same 2s cadence as the AppKit leaf.
export function pollServers(callback: (servers: PanelServerInfo[]) => void): () => void {
	const params = new URLSearchParams(location.search)
	const url = params.get('url')
	const token = params.get('token')
	if (url && token) {
		callback([
			{ url, token, name: params.get('name') ?? url, root: '', reachable: true },
		])
		return () => {}
	}
	let dead = false
	const tick = async () => {
		try {
			const res = await fetch('/__tweaks_servers')
			const list = (await res.json()) as PanelServerInfo[]
			if (!dead) callback(list.map((e) => ({ ...e, reachable: true })))
		} catch {
			if (!dead) callback([])
		}
	}
	tick()
	const timer = setInterval(tick, 2000)
	return () => {
		dead = true
		clearInterval(timer)
	}
}
