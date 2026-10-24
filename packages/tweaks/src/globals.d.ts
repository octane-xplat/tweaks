// Dev-only connection config. @octane-xplat/tweaks/vite substitutes this marker
// in served modules (and injects it via config.define for builds). Never
// defined in production.
declare const __OCTANE_TWEAKS__:
	| { token: string; path: string; fallbackOrigin: string }
	| undefined
