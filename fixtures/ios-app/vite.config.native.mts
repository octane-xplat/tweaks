import { defineConfig } from 'vite'
import { xplatNative } from '@octane-xplat/cli/vite'
import { tweaks } from '@octane-xplat/tweaks-vite'

// tweaks() must transform BEFORE the Octane compiler; `extra.plugins` merges
// after, so it is prepended to the resolved preset instead.
export default defineConfig(async ({ mode }) => {
	const config = await xplatNative(mode)
	config.plugins = [tweaks(), ...config.plugins]
	return config
})
