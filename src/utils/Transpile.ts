import { dirname, relative, resolve } from "node:path"
import { CFG_FUNCTIONS_FILE_NAME, CONSTANTS_FILE_NAME, CONSUMER_TS_COMPILER_OPTIONS, functionFileName, INDEX_FILE_NAMES, SQF_OUTPUT_DIR, SRC_DIR } from "./Constants.js"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import ts from "typescript"
import { Emitter } from "../classes/Emitter.js"
import { UnsupportedSyntaxError } from "../classes/UnsupportedSyntaxError.js"
import { buildCommandSyntax, buildProjectModel, extractMissionHandlers, FunctionDef, ProjectModel } from "../classes/ProjectModel.js"

export async function transpile(projectDir: string) {
	console.log(`Transpiling ${projectDir}...`)

	const indexFile = (await Promise.all(
		INDEX_FILE_NAMES.map(fileName => resolve(projectDir, SRC_DIR, fileName)).map(async candidate => {
			try {
				return (await stat(candidate)).isFile() ? candidate : undefined
			} catch {
				return undefined
			}
		})
	)).find(x => x !== undefined)

	if (indexFile === undefined) {
		console.error(`Error: no entry point found. Expected one of: ${INDEX_FILE_NAMES.map(n => `${SRC_DIR}/${n}`).join(", ")}`)
		return
	}

	let transpiled: TranspiledFile[]
	try {
		transpiled = transpileProject(indexFile, projectDir)
	} catch (err) {
		if (err instanceof UnsupportedSyntaxError) {
			console.error(`Unsupported syntax: ${err.message}`)
			return
		}
		throw err
	}

	await cleanStaleFunctionFiles(projectDir, transpiled)
	await Promise.all(transpiled.map(async (file) => {
		await mkdir(dirname(file.outPath), { recursive: true })
		await writeFile(file.outPath, file.sqf)
		console.log(`Wrote ${relative(projectDir, file.outPath)}`)
	}))

	// CfgFunctions only takes effect if description.ext includes it, so wire it up.
	if (transpiled.some((file) => file.outPath === resolve(projectDir, CFG_FUNCTIONS_FILE_NAME))) {
		await ensureCfgFunctionsInclude(projectDir)
	}
}

/** Ensure the mission's `description.ext` includes the generated `CfgFunctions.hpp`.
 * Creates the file if absent, appends the include if missing, and is a no-op if it's
 * already present. */
async function ensureCfgFunctionsInclude(projectDir: string): Promise<void> {
	const descriptionPath = resolve(projectDir, "description.ext")
	const include = `#include "${CFG_FUNCTIONS_FILE_NAME}"`
	let existing = ""
	try {
		existing = await readFile(descriptionPath, "utf8")
	} catch {
		// description.ext doesn't exist yet — we'll create it.
	}
	if (new RegExp(`#include\\s+"${CFG_FUNCTIONS_FILE_NAME}"`).test(existing)) return

	if (existing.length === 0) {
		await writeFile(descriptionPath, `${include}\n`)
		console.log("Created description.ext")
	} else {
		await writeFile(descriptionPath, `${existing}${existing.endsWith("\n") ? "" : "\n"}${include}\n`)
		console.log("Added #include to description.ext")
	}
}

export interface TranspiledFile {
	/** Absolute path the SQF should be written to. */
	outPath: string
	sqf: string
}

/** Output path for a mission init script: the project root, e.g. `<dir>/initServer.sqf`. */
export function initScriptOutputPath(handlerName: string, projectDir: string): string {
	return resolve(projectDir, `${handlerName}.sqf`)
}

/** Output path for a user function: flat in the `sqf/` directory, with the BI
 * `fn_` discovery prefix, e.g. `<dir>/sqf/fn_getCrewCount_a1b2c3d4.sqf`. */
export function functionOutputPath(functionGlobalName: string, projectDir: string): string {
	return resolve(projectDir, SQF_OUTPUT_DIR, functionFileName(functionGlobalName))
}

/** The line each init script runs to define every static const global before use. */
function constantsLoadLine(): string {
	return `call compile preprocessFileLineNumbers "${SQF_OUTPUT_DIR}\\${CONSTANTS_FILE_NAME}";`
}

/** Remove orphaned `sqf/*.sqf` files left over from previously-transpiled functions
 * that no longer exist (e.g. a function was renamed or deleted in watch mode). */
async function cleanStaleFunctionFiles(projectDir: string, outputs: TranspiledFile[]): Promise<void> {
	const sqfDir = resolve(projectDir, SQF_OUTPUT_DIR)
	const keep = new Set(outputs.map((file) => file.outPath))
	let entries: string[]
	try {
		entries = await readdir(sqfDir)
	} catch {
		return // no sqf/ directory yet
	}
	await Promise.all(entries
		.filter((entry) => entry.endsWith(".sqf"))
		.map((entry) => resolve(sqfDir, entry))
		.filter((path) => !keep.has(path))
		.map((path) => rm(path)))
}

export function transpileProject(indexFile: string, projectDir: string): TranspiledFile[] {

	const program = ts.createProgram([indexFile], CONSUMER_TS_COMPILER_OPTIONS)

	const syntactic = program.getSyntacticDiagnostics()
	if (syntactic.length > 0) {
		const formatted = ts.formatDiagnosticsWithColorAndContext(syntactic, {
			getCurrentDirectory: () => projectDir,
			getCanonicalFileName: (f) => f,
			getNewLine: () => "\n",
		})
		throw new Error(`Parse error: ${formatted}`)
	}

	const userFiles = program
		.getSourceFiles()
		.filter(sf => !program.isSourceFileFromExternalLibrary(sf) && !program.isSourceFileDefaultLibrary(sf))

	const project = buildProjectModel(userFiles, projectDir)
	// Command call shapes come from `@sqfsyntaxtype` tags on the js-to-sqf declarations.
	for (const [command, syntax] of buildCommandSyntax(program.getSourceFiles())) {
		project.commandSyntax.set(command, syntax)
	}
	const indexSourceFile = program.getSourceFile(resolve(indexFile))!
	const handlers = extractMissionHandlers(indexSourceFile)

	const outputs: TranspiledFile[] = []

	// All module-level consts -> a single sqf/constants.sqf (defined once, order-free).
	const hasConstants = project.consts.size > 0
	if (hasConstants) {
		const defs = [...project.consts.values()]
			.sort((a, b) => (a.globalName < b.globalName ? -1 : a.globalName > b.globalName ? 1 : 0))
			.map((c) => new Emitter(program.getSourceFile(c.sourceFileName)!, project).emitConstDefinition(c))
			.join("\n")
		outputs.push({
			outPath: resolve(projectDir, SQF_OUTPUT_DIR, CONSTANTS_FILE_NAME),
			sqf: `${defs}\n`,
		})
	}

	// Mission handlers -> root init scripts. Each loads the constants first.
	for (const handler of handlers) {
		const body = new Emitter(indexSourceFile, project).emitFunctionBody(handler.node)
		const parts = [hasConstants ? constantsLoadLine() : "", body].filter((part) => part.length > 0)
		outputs.push({
			outPath: initScriptOutputPath(handler.name, projectDir),
			sqf: parts.join("\n") + (parts.length > 0 ? "\n" : ""),
		})
	}

	// User functions (from any file) -> sqf/fn_<name>.sqf.
	for (const fn of project.functions.values()) {
		const sourceFile = program.getSourceFile(fn.sourceFileName)!
		const body = new Emitter(sourceFile, project).emitFunctionBody(fn.node)
		outputs.push({
			outPath: functionOutputPath(fn.globalName, projectDir),
			sqf: body + (body.length > 0 ? "\n" : ""),
		})
	}

	// CfgFunctions.hpp registers each function file as JS_fnc_<name>.
	if (project.functions.size > 0) {
		outputs.push({
			outPath: resolve(projectDir, CFG_FUNCTIONS_FILE_NAME),
			sqf: generateCfgFunctions(project),
		})
	}

	return outputs
}

/** Build the `CfgFunctions.hpp` config that auto-registers each function file under
 * the `JS` tag, so Arma exposes them as `JS_fnc_<name>`. Entries are sorted for
 * deterministic output (no churn across re-runs). */
export function generateCfgFunctions(project: ProjectModel): string {
	const entries = [...project.functions.values()]
		.sort((a: FunctionDef, b: FunctionDef) => (a.globalName < b.globalName ? -1 : a.globalName > b.globalName ? 1 : 0))
		.map((fn) => `\t\t\tclass ${fn.globalName} { file = "${SQF_OUTPUT_DIR}"; };`)
		.join("\n")
	return `class CfgFunctions {\n\tclass JS {\n\t\tclass functions {\n${entries}\n\t\t};\n\t};\n};\n`
}
