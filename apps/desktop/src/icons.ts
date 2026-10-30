import { registerIcons } from '@octane-xplat/ui'

// Selected Heroicons 2.2.0 outlines, shared by web SVG and AppKit image leaves.
// MIT license and attribution: ../HEROICONS-LICENSE.
// The `xplat-*` entries restyle framework-built affordances (SelectView caret
// and clear, InputNumber steppers) so panel chrome matches the app set.
registerIcons({
	'panel-pin': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0" />\n  <path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0" /></g>',
	},
	'panel-square-mouse-pointer': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15.042 21.672 13.684 16.6m0 0-2.51 2.225.569-9.47 5.227 7.917zM12 2.25V4.5m5.834.166-1.591 1.591M20.25 10.5H18M7.757 14.743l-1.59 1.59M6 10.5H3.75m4.007-4.243-1.59-1.59" /></g>',
	},
	'panel-save': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3" /></g>',
	},
	'panel-undo-2': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></g>',
	},
	'panel-rotate-ccw': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" /></g>',
	},
	'panel-chevron-down': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m19.5 8.25-7.5 7.5-7.5-7.5" /></g>',
	},
	'panel-chevron-right': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m8.25 4.5 7.5 7.5-7.5 7.5" /></g>',
	},
	'panel-plus': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v15m7.5-7.5h-15" /></g>',
	},
	'panel-x': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 18 6M6 6l12 12" /></g>',
	},
	'panel-trash-2': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21q.512.078 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48 48 0 0 0-3.478-.397m-12 .562q.51-.088 1.022-.165m0 0a48 48 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a52 52 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a49 49 0 0 0-7.5 0" /></g>',
	},
	'xplat-chevron-down': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m19.5 8.25-7.5 7.5-7.5-7.5" /></g>',
	},
	'xplat-clear': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18 18 6M6 6l12 12" /></g>',
	},
	'xplat-minus': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /></g>',
	},
	'xplat-plus': {
		markup:
			'<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v15m7.5-7.5h-15" /></g>',
	},
})
