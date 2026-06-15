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
	.argument("[dir]", "project directory", ".")
	.option("--watch", "watch project for changes and keep transpiling")
	.action(async (dir: string, options) => {
		const projectDir: string  = resolve(process.cwd(), dir)
		if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
			console.error(`Error: not a directory: ${projectDir}`)
			process.exit(1)
		}

		if (options.watch) {
			console.log(`Watching ${projectDir}...`)

			const ignoreInstance: Ignore = ignore().add(".git").add("*.sqf")
			const gitignorePath = resolve(projectDir, ".gitignore")
			if (existsSync(gitignorePath)) {
				ignoreInstance.add(readFileSync(gitignorePath, "utf8"))
			}
			const isIgnored = (path: string) => {
				const rel = relative(projectDir, path)
				if (rel === "" || rel.startsWith("..")) return false
				return ignoreInstance.ignores(rel.split(sep).join("/"))
			}

			watch(projectDir, {ignoreInitial: true, ignored: (path) => isIgnored(path)}).on('all', async () => {
				try {
					await transpile(projectDir)
				} catch (err) {
					console.error("Failed to transpile:", err)
				}
			})
		}

		await transpile(projectDir)
	})

await command.parseAsync()
