import fs from 'node:fs/promises'
import path from 'node:path'
import type { TweakEntry, TweakValue } from '@octane-xplat/tweaks/protocol'
import { extract, type ExtractedTweak } from './extract.ts'
import { serializeLiteral } from './serialize.ts'

export interface SaveError {
	id?: string
	file: string
	message: string
}

export interface SaveResult {
	ok: boolean
	saved: string[]
	errors: SaveError[]
	/** file → new content, for manifest refresh + HMR suppression. */
	writes: Map<string, string>
}

interface Edit {
	start: number
	end: number
	text: string
}

/**
 * Re-parse every touched file from disk (writeback ranges are true source
 * offsets — earlier transforms may have rewritten the served module), find each
 * dirty entry by id, and splice the serialized override over its value literal.
 * On any write failure, already-written files are restored from their original
 * content so a failed Save never leaves a half-applied set.
 */
export async function saveOverrides(opts: {
	root: string
	manifest: Map<string, { entry: TweakEntry; tweak: ExtractedTweak }>
	overrides: Map<string, TweakValue>
	isDirty(id: string): boolean
}): Promise<SaveResult> {
	const errors: SaveError[] = []
	const editsByFile = new Map<string, Edit[]>()
	const fileContents = new Map<string, string>()

	for (const [id, override] of opts.overrides) {
		if (!opts.isDirty(id)) continue
		const found = opts.manifest.get(id)
		const file = found?.entry.file ?? id.split('#')[0]
		if (!found) {
			errors.push({ id, file, message: 'entry not in manifest' })
			continue
		}
		if (!found.tweak.writable) {
			errors.push({
				id,
				file,
				message: found.tweak.reason ?? 'entry is not writable',
			})
			continue
		}
		const abs = path.join(opts.root, file)
		let code = fileContents.get(file)
		if (code === undefined) {
			try {
				code = await fs.readFile(abs, 'utf8')
				fileContents.set(file, code)
			} catch (error) {
				errors.push({ id, file, message: `cannot read file: ${(error as Error).message}` })
				continue
			}
		}
		const fresh = extract(code, file).tweaks.find((t) => t.id === id)
		if (!fresh || !fresh.valueRange) {
			errors.push({ id, file, message: 'entry no longer found in file (file changed?)' })
			continue
		}
		let edits = editsByFile.get(file)
		if (!edits) editsByFile.set(file, (edits = []))
		edits.push({
			start: fresh.valueRange.start,
			end: fresh.valueRange.end,
			text: serializeLiteral(override, fresh.quote === "'" ? "'" : '"'),
		})
	}

	// Apply edits per file in descending offset order.
	const contents = new Map<string, string>()
	for (const [file, edits] of editsByFile) {
		let code = fileContents.get(file)!
		edits.sort((a, b) => b.start - a.start)
		for (const edit of edits) {
			code = code.slice(0, edit.start) + edit.text + code.slice(edit.end)
		}
		contents.set(file, code)
	}

	const saved: string[] = []
	const written = new Map<string, string>()
	try {
		for (const [file, code] of contents) {
			const abs = path.join(opts.root, file)
			written.set(file, await fs.readFile(abs, 'utf8'))
			await fs.writeFile(abs, code)
			saved.push(file)
		}
	} catch (error) {
		// Roll back already-written files to their pre-save content.
		for (const [file, original] of written) {
			try {
				await fs.writeFile(path.join(opts.root, file), original)
			} catch {
				errors.push({ file, message: 'rollback failed — file left in saved state' })
			}
		}
		errors.push({ file: '', message: `write failed: ${(error as Error).message}` })
		return { ok: false, saved: [], errors, writes: new Map() }
	}

	return { ok: errors.length === 0, saved, errors, writes: contents }
}
