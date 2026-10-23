import { useState } from 'octane';
import {
	Badge,
	Button,
	HStack,
	ScrollableArea,
	Selector,
	Slider,
	StatusDot,
	Switch,
	Text,
	TextInput,
	NumberInput,
	View,
	VStack,
} from '@octane-xplat/ui';
import { createStore, useStore } from '@octane-xplat/ui/data';
import type { PanelEntry, PanelStyleEntry, TweakValue } from '@octane-xplat/tweaks/protocol';
import { displayValue, HEX_COLOR_RE, PanelModel, serverKey, serverLabel, type PanelServerInfo } from './model';
import { transportFactory } from './transport';
import { pollServers } from './servers';
import { setKeepOnTop, supportsKeepOnTop } from './window';

// One module-singleton model per platform entry.
export const model = new PanelModel(transportFactory, {
	label: typeof location === 'undefined' ? 'desktop' : 'panel-web',
});
const servers$ = createStore<PanelServerInfo[]>([]);
const modelTick = createStore(0);
const keepOnTop$ = createStore(false);

pollServers((list) => {
	const prev = servers$.getSnapshot();
	servers$.set(list);
	// Auto-connect: first discovered server; reconnect if ours vanished.
	const current = prev.find((s) => model.serverName === s.name);
	if (!current && list.length) model.connect(list[0]);
});
model.subscribe(() => modelTick.set(modelTick.getSnapshot() + 1));

function Row(props: { entry: PanelEntry }) @{
	useStore(modelTick);
	const e = props.entry;
	const current = displayValue(e);
	const [text, setText] = useState<string | null>(null);
	const isColor = e.input.type === 'color';
	// Local text wins only while it isn't a sendable value (invalid color hex);
	// otherwise the live server value is shown, so Revert/remote edits appear.
	const shown = isColor && text !== null && !HEX_COLOR_RE.test(text) ? text : String(current);
	const colorValid = !isColor || HEX_COLOR_RE.test(shown);

	return (
		<VStack testID={`row-${e.id}`} style={{ gap: 4, paddingTop: 4, paddingBottom: 4 }}>
			<HStack style={{ gap: 8, alignItems: 'center' }}>
				<Text>{e.name}</Text>
				{e.dirty ? <Badge><Text>modified</Text></Badge> : null}
				{e.dirty ? (
					<Button
						label="Revert"
						clickAction={() => {
							setText(null);
							model.revert(e.id);
						}}
					/>
				) : null}
			</HStack>
			<HStack testID={`control-${e.id}`} style={{ gap: 8, alignItems: 'center' }}>
				{e.input.type === 'number' && e.input.min !== undefined && e.input.max !== undefined ? (
					<>
						<Slider
							style={{ width: 160, height: 20 }}
							value={Number(current)}
							minValue={e.input.min}
							maxValue={e.input.max}
							onValueChange={(v: number) => model.set(e.id, v)}
						/>
						<Text testID={`value-${e.id}`}>{String(current)}</Text>
					</>
				) : e.input.type === 'number' ? (
					<NumberInput
						style={{ width: 100 }}
						value={Number(current)}
						onValueChange={(v: number | null) => {
							if (v !== null && Number.isFinite(v)) model.set(e.id, v);
						}}
					/>
				) : e.input.type === 'boolean' ? (
					<Switch
						testID={`control-${e.id}`}
						checked={Boolean(current)}
						onCheckedChange={(v: boolean) => model.set(e.id, v)}
					/>
				) : e.input.type === 'select' ? (
					<Selector
						style={{ width: 120 }}
						value={String(current)}
						options={(e.input.options as readonly (string | number)[]).map((o) => ({
							value: String(o),
						}))}
						onValueChange={(v: string | null) => {
							if (v !== null) model.set(e.id, v);
						}}
					/>
				) : (
					<>
						<TextInput
							testID={`control-${e.id}`}
							value={shown}
							onChange={(v: string) => {
								setText(v);
								if (model.set(e.id, v)) setText(null);
							}}
						/>
						{isColor ? (
							<View
								testID={`swatch-${e.id}`}
								style={{
									width: 16,
									height: 16,
									borderRadius: 4,
									backgroundColor: colorValid ? shown : 'transparent',
								}}
							/>
						) : null}
						{isColor && !colorValid ? <Text>invalid hex</Text> : null}
					</>
				)}
			</HStack>
			{!e.writable ? <Text>Live only — {e.reason ?? 'not a literal'}</Text> : null}
		</VStack>
	);
}

function StylePropRow(props: { site: PanelStyleEntry; path: string[] }) @{
	useStore(modelTick);
	const site = props.site;
	const key = props.path.join('.');
	const prop = site.properties.find((p) => p.path.join('.') === key);
	const added = !prop; // draft-added path
	const value = model.stylePropValue(site, props.path);
	const deleted = model.stylePropDeleted(site, props.path);
	const editable = (prop?.editable ?? added) && site.writable && !deleted;

	return (
		<HStack style={{ gap: 8, alignItems: 'center', paddingLeft: 8 }}>
			<Text testID={`style-path-${site.id}-${key}`}>{deleted ? `~${key}~` : key}</Text>
			{!prop?.editable && !added ? (
				<Text>dynamic</Text>
			) : (
				<>
					<TextInput
						testID={`style-input-${site.id}-${key}`}
						value={value == null ? '' : String(value)}
						onChange={(v: string) => model.styleSet(site.id, props.path, v)}
					/>
					{deleted ? (
						<Button
							testID={`style-undo-${site.id}-${key}`}
							label="Undo"
							clickAction={() => model.styleRestore(site.id, props.path)}
						/>
					) : editable ? (
						<Button
							testID={`style-delete-${site.id}-${key}`}
							label="Delete"
							clickAction={() => model.styleDelete(site.id, props.path)}
						/>
					) : null}
				</>
			)}
		</HStack>
	);
}

function StyleSiteCard(props: { site: PanelStyleEntry }) @{
	useStore(modelTick);
	const site = props.site;
	const [name, setName] = useState('');
	const [val, setVal] = useState('');
	const canAdd = model.styleAddNameValid(site, name);
	const paths = site.properties.map((p) => p.path);
	for (const k of model.styleAddedPaths(site)) paths.push(k.split('.'));

	return (
		<VStack testID={`stylesite-${site.id}`} style={{ gap: 4, paddingLeft: 8 }}>
			<HStack style={{ gap: 8, alignItems: 'center' }}>
				<Text>{site.label}</Text>
				<Text>{`${site.file}:${site.line}`}</Text>
				{site.dirty ? <Badge><Text>modified</Text></Badge> : null}
				{site.dirty ? (
					<Button label="Revert" clickAction={() => model.revert(site.id)} />
				) : null}
			</HStack>
			{site.preview === 'unavailable' ? <Text>Preview unavailable</Text> : null}
			{!site.writable ? <Text>{site.reason ?? 'read-only'}</Text> : null}
			{paths.map((p) => (
				<StylePropRow key={p.join('.')} site={site} path={p} />
			))}
			{site.writable ? (
				<HStack style={{ gap: 8, alignItems: 'center', paddingLeft: 8 }}>
					<TextInput
						testID={`style-add-name-${site.id}`}
						value={name}
						placeholder="property"
						onChange={(v: string) => setName(v)}
					/>
					<TextInput
						testID={`style-add-value-${site.id}`}
						value={val}
						placeholder="value"
						onChange={(v: string) => setVal(v)}
					/>
					<Button
						testID={`style-add-${site.id}`}
						label="Add"
						isDisabled={!canAdd}
						clickAction={() => {
							if (model.styleAdd(site, name, val)) {
								setName('');
								setVal('');
							}
						}}
					/>
				</HStack>
			) : null}
		</VStack>
	);
}

export function App() @{
	useStore(modelTick);
	const servers = useStore(servers$);
	const onTop = useStore(keepOnTop$);
	const snap = model.snapshot();
	const groups = model.groupedEntries();
	const styleGroups = model.groupedStyles();
	const dirty = model.dirtyCount();
	const unmounted = snap.unmountedDirty.length;

	return (
		<VStack style={{ gap: 8, padding: 12, height: 720 }}>
			
			{servers.length === 0 ? (
				<Text testID="servers.empty">
					No dev servers found. Start a Vite dev server that uses tweaks().
				</Text>
			) : servers.length === 1 ? (
				<Text testID="servers.name">{servers[0].name}</Text>
			) : (
				<Selector
					value={serverLabel(servers.find((s) => serverKey(s) === model.connectedKey) ?? servers[0])}
					options={servers.map((s) => ({ value: serverLabel(s) }))}
					onValueChange={(name: string | null) => {
						const s = servers.find((x) => serverLabel(x) === name);
						if (s) model.connect(s);
					}}
				/>
			)}
			<HStack style={{ gap: 8, alignItems: 'center' }}>
				<StatusDot
					variant={snap.status === 'connected' ? 'success' : snap.status === 'connecting' ? 'warning' : 'error'}
					label={snap.status}
				/>
				<Text testID="status">
					{snap.status === 'connected'
						? 'Connected'
						: snap.status === 'connecting'
							? 'Connecting…'
							: 'Disconnected'}
				</Text>
				{snap.clients.length ? (
					<Text testID="clients">{snap.clients.map((c) => c.label).join(', ')}</Text>
				) : null}
				{supportsKeepOnTop ? (
					<HStack style={{ gap: 4, alignItems: 'center' }}>
						<Text>Keep on top</Text>
						<Switch
							testID="keep-on-top"
							checked={onTop}
							onCheckedChange={(v: boolean) => {
								keepOnTop$.set(v);
								setKeepOnTop(v);
							}}
						/>
					</HStack>
				) : null}
			</HStack>
			<ScrollableArea style={{ height: 460 }}>
				{snap.status === 'connected' && snap.entries.length === 0 ? (
					<Text testID="entries.empty">No tweaks on screen. Open a screen that calls useTweak.</Text>
				) : (
					<VStack style={{ flexDirection: 'column' }}>
						{groups.map((g) => (
							<VStack key={g.group} style={{ gap: 4, paddingTop: 8 }}>
								<Text style={{ fontWeight: 'bold' }}>{g.group}</Text>
								{g.entries.map((e) => (
									<Row key={e.id} entry={e} />
								))}
							</VStack>
						))}
						{styleGroups.length ? (
							<VStack testID="styles.section" style={{ gap: 4, paddingTop: 8 }}>
								<Text style={{ fontWeight: 'bold' }}>Styles</Text>
								{styleGroups.map((g) => (
									<VStack key={g.file} style={{ gap: 4, paddingLeft: 4 }}>
										<Text style={{ fontWeight: 'bold' }}>{g.file}</Text>
										{g.sites.map((site) => (
											<StyleSiteCard key={site.id} site={site} />
										))}
									</VStack>
								))}
							</VStack>
						) : null}
					</VStack>
				)}
			</ScrollableArea>
			<HStack style={{ gap: 8, alignItems: 'center' }}>
				<Text testID="dirty-count">
					{dirty} unsaved{unmounted ? ` (${unmounted} not on screen)` : ''}
				</Text>
				<Button testID="revert-all" label="Revert all" clickAction={() => model.revertAll()} />
				<Button
					testID="save"
					label="Save"
					isDisabled={dirty === 0 || snap.saving}
					clickAction={() => model.save()}
				/>
				{snap.saveResult ? (
					<Text testID="save-result">
						{snap.saveResult.ok
							? `Saved ${snap.saveResult.saved.length} file(s)`
							: snap.saveResult.errors.map((x) => `${x.file}: ${x.message}`).join('; ')}
					</Text>
				) : null}
			</HStack>
		</VStack>
	);
}
