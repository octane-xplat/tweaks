import { defineConfig, type Plugin } from 'vite'
import { octane } from '@octanejs/vite-plugin'
import { xplatCss, xplatBoundary, xplatDevBridge, xplatNodeEnvDefine } from '@octane-xplat/cli/vite'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Serve the local server registry to the web panel — browsers can't read
// ~/.octane-xplat/tweaks/servers/*.json directly, so the AppKit app's polling
// path is mirrored here as an endpoint the panel's dev server answers.
function tweaksServers(): Plugin {
	const dir = join(homedir(), '.octane-xplat/tweaks/servers')
	return {
		name: 'tweaks-servers',
		configureServer(server) {
			server.middlewares.use('/__tweaks_servers', (_req, res) => {
				const out: unknown[] = []
				try {
					for (const name of readdirSync(dir)) {
						if (!name.endsWith('.json')) continue
						try {
							const entry = JSON.parse(readFileSync(join(dir, name), 'utf8'))
							if (entry?.url && entry?.token) out.push(entry)
						} catch {
							// skip malformed entry
						}
					}
				} catch {
					// no registry dir yet
				}
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify(out))
			})
		},
	}
}

export default defineConfig(({ mode }) => ({
	plugins: [xplatCss('web'), ...octane(), xplatBoundary('web'), xplatDevBridge(), tweaksServers()],
	define: xplatNodeEnvDefine(mode),
	server: { port: 5211 },
	resolve: {
		conditions: ['web'],
		extensions: [
			'.web.tsrx', '.tsrx', '.web.tsx', '.tsx', '.web.ts', '.mjs', '.mts',
			'.ts', '.jsx', '.js', '.json',
		],
	},
}))
