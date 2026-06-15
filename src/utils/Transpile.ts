import { basename, dirname, extname, relative, resolve } from "node:path"
import { CONSUMER_TS_COMPILER_OPTIONS, ENTRY_FILE_NAMES, SRC_DIR } from "./Constants.js"
import { mkdir, stat, writeFile } from "node:fs/promises"
import ts from "typescript"
import { Emitter, UnsupportedSyntaxError } from "../classes/Emitter.js"

export async function transpile(projectDir: string) {
	console.log(`Transpiling ${projectDir}...`)

	const entryFiles = (await Promise.all(
		ENTRY_FILE_NAMES.map(fileName => resolve(projectDir, SRC_DIR, fileName)).map(async candidate => {
			try {
				return (await stat(candidate)).isFile() ? candidate : undefined
			} catch {
				return undefined
			}
		})
	)).filter(x => x !== undefined)

	if (entryFiles.length === 0) {
		console.error(`Error: no entry file found in ${resolve(projectDir, SRC_DIR)}. Expected one of: ${ENTRY_FILE_NAMES.join(", ")}`)
		return
	}
	
	try {
		const transpiled = transpileFiles(entryFiles, projectDir)
		await Promise.all(transpiled.map(async (file) => {
			const outPath = sqfOutputPath(file.fileName, projectDir)
			await mkdir(dirname(outPath), { recursive: true })
			await writeFile(outPath, file.sqf)
			console.log(`Wrote ${relative(projectDir, outPath)}`)
		}))
	} catch (err) {
		if (err instanceof UnsupportedSyntaxError) {
			console.error(`Unsupported syntax: ${err.message}`)
			return
		}
		throw err
	}
}

export interface TranspiledFile {
	fileName: string
	sqf: string
}

/** Output path for a transpiled source file. Sources live under `src/`; their layout
 * is mirrored into the project root with a `.sqf` extension.
 * e.g. `<dir>/src/sub/x.ts` -> `<dir>/sub/x.sqf`. */
export function sqfOutputPath(sourceFileName: string, projectDir: string): string {
	const relFromSrc = relative(resolve(projectDir, SRC_DIR), sourceFileName)
	const base = basename(relFromSrc, extname(relFromSrc))
	return resolve(projectDir, dirname(relFromSrc), `${base}.sqf`)
}

export function loadProgram(entryFiles: string[]): ts.Program {
	const options: ts.CompilerOptions = {
		allowJs: true,
		checkJs: false,
		noLib: true,
		noEmit: true,
		target: ts.ScriptTarget.Latest,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
	}
	return ts.createProgram(entryFiles, options)
}

export function transpileFiles(entryFiles: string[], rootDir: string): TranspiledFile[] {

	const program = ts.createProgram(entryFiles, CONSUMER_TS_COMPILER_OPTIONS)

	const syntactic = program.getSyntacticDiagnostics()
	if (syntactic.length > 0) {
		const formatted = ts.formatDiagnosticsWithColorAndContext(syntactic, {
			getCurrentDirectory: () => rootDir,
			getCanonicalFileName: (f) => f,
			getNewLine: () => "\n",
		})
		throw new Error(`Parse error: ${formatted}`)
	}

	const userFiles = program
		.getSourceFiles()
		.filter(sf => !program.isSourceFileFromExternalLibrary(sf) && !program.isSourceFileDefaultLibrary(sf))
	
	return userFiles.map(sourceFile => {
		return {
			fileName: sourceFile.fileName,
			sqf: new Emitter(sourceFile).emitFile(),
		}
	})
}
