import { defineConfig } from 'vite'
import { xplatMacOS } from '@octane-xplat/cli/macos/vite'

export default defineConfig((env) => xplatMacOS(env, { entry: 'src/main.macos.ts' }))
