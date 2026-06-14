#!/usr/bin/env node

import { watch } from "chokidar"
import { Command } from "commander"
import { existsSync, readFileSync, statSync } from "node:fs"
import { stat } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import ignore, { Ignore } from "ignore"
import { loadAndValidate, UnsupportedSyntaxError } from "./program.js"

const ENTRY_BASENAMES = ["initPlayerLocal", "initPlayerServer"]
const ENTRY_EXTENSIONS = [".js", ".ts"]

const command = new Command()

command
	.name("js-to-sqf")
	.description("Watch a directory and transpile JS to SQF")
	.argument("[dir]", "directory to watch", ".")
	.action(async (dir: string) => {
		const projectDir: string  = resolve(process.cwd(), dir)
		if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
			console.error(`Error: not a directory: ${projectDir}`)
			process.exit(1)
		}
		console.log(`Watching ${projectDir}...`)

		const ignoreInstance: Ignore = ignore().add(".git")
		const gitignorePath = resolve(projectDir, ".gitignore")
		if (existsSync(gitignorePath)) {
			ignoreInstance.add(readFileSync(gitignorePath, "utf8"))
		}
		const isIgnored = (path: string) => {
			const rel = relative(projectDir, path)
			// The watch root itself has an empty relative path; never ignore it.
			if (rel === "" || rel.startsWith("..")) return false
			return ignoreInstance.ignores(rel.split(sep).join("/"))
		}

		watch(projectDir, {ignoreInitial: true, ignored: (path) => isIgnored(path)}).on('all', async (event, path) => {
			try {
				await transpile(projectDir)
			} catch (err) {
				console.error(`Failed to transpile ${path}:`, err)
			}
		})

		// Initial transpile
		await transpile(projectDir)
	})

await command.parseAsync()

async function findEntryFiles(projectDir: string): Promise<string[]> {
	const candidates = ENTRY_BASENAMES.flatMap((base) =>
		ENTRY_EXTENSIONS.map((ext) => resolve(projectDir, `${base}${ext}`)),
	)
	return (await Promise.all(
		candidates.map(async (candidate) => {
			try {
				console.log(candidate, (await stat(candidate)).isFile())
				return (await stat(candidate)).isFile() ? candidate : undefined
			} catch {
				return undefined
			}
		})
	)).filter(x => x !== undefined)
}

async function transpile(projectDir: string) {
	console.log(`Transpiling ${projectDir}...`)

	const entryFiles = await findEntryFiles(projectDir)
	if (entryFiles.length === 0) {
		console.error(
			`Error: no entry file found in ${projectDir}. Expected one of: ` +
				ENTRY_BASENAMES.flatMap((base) =>
					ENTRY_EXTENSIONS.map((ext) => `${base}${ext}`),
				).join(", "),
		)
		return
	}
	
	try {
		const sourceFiles = loadAndValidate(entryFiles, projectDir)
		console.log(`Module graph (${sourceFiles.length} file(s)):`)
		for (const sourceFile of sourceFiles) {
			console.log(`  ${relative(projectDir, sourceFile.fileName)}`)
		}
	} catch (err) {
		if (err instanceof UnsupportedSyntaxError) {
			// Expected, user-facing — print the message, not a stack trace.
			console.error(`Cannot transpile: ${err.message}`)
			return
		}
		throw err
	}
}
