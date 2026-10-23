import { defineConfig } from 'vite'
import { octane } from '@octanejs/vite-plugin'
import { xplatCss, xplatBoundary, xplatDevBridge, xplatNodeEnvDefine } from '@octane-xplat/cli/vite'

export default defineConfig(({ mode }) => ({
	plugins: [xplatCss('web'), ...octane(), xplatBoundary('web'), xplatDevBridge()],
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
