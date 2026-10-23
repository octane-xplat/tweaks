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
import type { PanelEntry, TweakValue } from '@octane-xplat/tweaks/protocol';
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

export function App() @{
	useStore(modelTick);
	const servers = useStore(servers$);
	const onTop = useStore(keepOnTop$);
	const snap = model.snapshot();
	const groups = model.groupedEntries();
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
			<ScrollableArea style={{ height: 520 }}>
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
