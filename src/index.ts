#!/usr/bin/env node

import { watch } from "chokidar"
import { Command } from "commander"
import { existsSync, readFileSync, statSync } from "node:fs"
import { relative, resolve, sep } from "node:path"
import ignore, { Ignore } from "ignore"
import { transpile } from "./utils/Transpile.js"

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
