import { relative, resolve } from "node:path"
import { CONSUMER_TS_COMPILER_OPTIONS, ENTRY_FILE_NAMES } from "./Constants.js"
import { stat } from "node:fs/promises"
import ts from "typescript"
import { Emitter, UnsupportedSyntaxError } from "../classes/Emitter.js"

export async function transpile(projectDir: string) {
	console.log(`Transpiling ${projectDir}...`)

	const entryFiles = (await Promise.all(
		ENTRY_FILE_NAMES.map(fileName => resolve(projectDir, fileName)).map(async candidate => {
			try {
				return (await stat(candidate)).isFile() ? candidate : undefined
			} catch {
				return undefined
			}
		})
	)).filter(x => x !== undefined)
	
	if (entryFiles.length === 0) {
		console.error(`Error: no entry file found in ${projectDir}. Expected one of: ${ENTRY_FILE_NAMES.join(", ")}`)
		return
	}
	
	try {
		const transpiled = transpileFiles(entryFiles, projectDir)
		for (const file of transpiled) {
			console.log(`\n// ${relative(projectDir, file.fileName)}`)
			console.log(file.sqf)
		}
	} catch (err) {
		if (err instanceof UnsupportedSyntaxError) {
			// Expected, user-facing — print the message, not a stack trace.
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

	// Surface parse errors (unterminated strings, stray tokens, ...) up front.
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
