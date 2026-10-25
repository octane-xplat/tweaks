import { defineConfig } from 'vite'
import { xplatMacOS } from '@octane-xplat/cli/macos/vite'

// `xplat dev macos` watches this config. The entry owns window + root itself
// (src/main.macos.ts), so no dev shell is needed — the bundle uses the same
// self-contained cjs shape as `xplat build`, emitted under dist/dev so dev
// rebuilds never touch dist/package-build. JS edits restart the host process
// (no HMR; the framework's dev-shell seam expects a component export).
export default defineConfig((env) =>
	xplatMacOS(env, { entry: 'src/main.macos.ts', outDir: 'dist/dev' }),
)
