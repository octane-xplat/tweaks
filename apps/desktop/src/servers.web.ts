import type { PanelServerInfo } from './model'

// Web build: a single server passed via ?url=…&token=… query params.
export function pollServers(callback: (servers: PanelServerInfo[]) => void): () => void {
	const params = new URLSearchParams(location.search)
	const url = params.get('url')
	const token = params.get('token')
	callback(
		url && token
			? [{ url, token, name: params.get('name') ?? url, root: '', reachable: true }]
			: [],
	)
	return () => {}
}
