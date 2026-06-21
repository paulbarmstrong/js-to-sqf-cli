import ts from "typescript"
import { createHash } from "node:crypto"
import { dirname, relative, resolve, sep } from "node:path"
import { MISSION_HANDLER_NAMES } from "../utils/Constants.js"
import { UnsupportedSyntaxError } from "./UnsupportedSyntaxError.js"

/** A user-defined function discovered anywhere under `src/`. Each becomes its own
 * `sqf/fn_<globalName>.sqf` file, registered in `CfgFunctions.hpp` as `JS_fnc_<globalName>`. */
export interface FunctionDef {
	/** The declared (JS) function name. */
	name: string
	/** Unique, deterministic global name (`<name>_<hash>`); the CfgFunctions class name
	 * and `JS_fnc_` suffix. The hash makes same-named functions in different files unique. */
	globalName: string
	sourceFileName: string
	node: ts.FunctionDeclaration
}

/** A module-level (outside-function) const. SQF has no module system, so it is
 * materialized as a global variable (`<localName>_<hash>`) defined once in
 * `sqf/constants.sqf`. Its initializer must be an immutable literal. */
export interface ConstGlobal {
	localName: string
	/** Unique, deterministic global SQF variable name, e.g. `num_a1b2c3d4`. */
	globalName: string
	sourceFileName: string
	node: ts.VariableDeclaration
}

/** A `defineMission` handler (`init`/`initServer`/`initPlayerLocal`), emitted to a
 * root `<name>.sqf` init script. */
export interface MissionHandler {
	name: string
	node: ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration
}

/** SQF command call shape, declared on each `js-to-sqf` command via the
 * `@sqfsyntaxtype` JSDoc tag. */
export type SqfSyntaxType = "nullary" | "unary" | "binary"

const SQF_SYNTAX_TYPE_TAG = /@sqfsyntaxtype\s+(nullary|unary|binary)\b/

/** A project-wide registry, built once before emission, that gives each `Emitter`
 * the cross-file knowledge it needs to resolve identifiers. */
export interface ProjectModel {
	/** `${sourceFileName}#${name}` -> definition. Keyed by file so two files may
	 * declare a same-named function (each gets a distinct hashed global name). */
	functions: Map<string, FunctionDef>
	/** `${sourceFileName}#${localName}` -> module-const global. */
	consts: Map<string, ConstGlobal>
	/** Absolute paths of every user source file, for relative-import resolution. */
	files: Set<string>
	/** SQF command name -> its call shape, from `@sqfsyntaxtype` tags on `js-to-sqf`. */
	commandSyntax: Map<string, SqfSyntaxType>
}

/** A model with no cross-file knowledge. Used by unit tests that emit a single
 * in-memory source file. */
export const EMPTY_PROJECT_MODEL: ProjectModel = {
	functions: new Map(),
	consts: new Map(),
	files: new Set(),
	commandSyntax: new Map(),
}

/** Read the `@sqfsyntaxtype` JSDoc tag off every command declaration (e.g. in the
 * `js-to-sqf` types) to learn whether each command is nullary/unary/binary. The tag
 * is read from the raw leading comment text, which is reliable regardless of whether
 * the parser structured the JSDoc tags. */
export function buildCommandSyntax(sourceFiles: readonly ts.SourceFile[]): Map<string, SqfSyntaxType> {
	const commandSyntax = new Map<string, SqfSyntaxType>()
	for (const sourceFile of sourceFiles) {
		for (const statement of sourceFile.statements) {
			if (!ts.isFunctionDeclaration(statement) || statement.name === undefined) continue
			const ranges = ts.getLeadingCommentRanges(sourceFile.text, statement.getFullStart()) ?? []
			for (const range of ranges) {
				const match = SQF_SYNTAX_TYPE_TAG.exec(sourceFile.text.slice(range.pos, range.end))
				if (match !== null) {
					commandSyntax.set(statement.name.text, match[1] as SqfSyntaxType)
					break
				}
			}
		}
	}
	return commandSyntax
}

/** Key used for `ProjectModel.consts`. */
export function constKey(sourceFileName: string, localName: string): string {
	return `${sourceFileName}#${localName}`
}

/** Resolve a relative import specifier to the absolute path of a known user file. */
export function resolveRelativeImport(importingFile: string, spec: string, files: Set<string>): string | undefined {
	const base = resolve(dirname(importingFile), spec)
	const candidates = [base, `${base}.ts`, `${base}.js`, resolve(base, "index.ts"), resolve(base, "index.js")]
	return candidates.find((candidate) => files.has(candidate))
}

/** A deterministic, collision-resistant global name (`<localName>_<hash>`) so two
 * same-named symbols (consts or functions) in different files don't clash. Derived
 * from the project-relative path + name, so it is stable across re-runs (no churn
 * under `--watch`) and across machines. */
function hashedGlobalName(sourceFileName: string, localName: string, projectDir: string): string {
	const relPath = relative(projectDir, sourceFileName).split(sep).join("/")
	const hash = createHash("sha1").update(`${relPath}#${localName}`).digest("hex").slice(0, 8)
	return `${localName}_${hash}`
}

/** A top-level `const` declaration (exported or not). */
function isModuleConstStatement(statement: ts.Statement): statement is ts.VariableStatement {
	return ts.isVariableStatement(statement)
		&& (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
}

/** Discover all functions and all module-level consts, each assigned a unique
 * deterministic global name. Const initializers may be any supported expression
 * (literal, command call, etc.); they are evaluated once when `constants.sqf` loads. */
export function buildProjectModel(userFiles: readonly ts.SourceFile[], projectDir: string): ProjectModel {
	const files = new Set(userFiles.map((sf) => sf.fileName))
	const functions = new Map<string, FunctionDef>()
	const consts = new Map<string, ConstGlobal>()

	for (const sourceFile of userFiles) {
		for (const statement of sourceFile.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
				const name = statement.name.text
				functions.set(constKey(sourceFile.fileName, name), {
					name,
					globalName: hashedGlobalName(sourceFile.fileName, name, projectDir),
					sourceFileName: sourceFile.fileName,
					node: statement,
				})
			} else if (isModuleConstStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					if (!ts.isIdentifier(declaration.name)) continue
					if (declaration.initializer === undefined) {
						throw new UnsupportedSyntaxError(declaration, sourceFile,
							`const "${declaration.name.text}" must have an initializer`)
					}
					const name = declaration.name.text
					consts.set(constKey(sourceFile.fileName, name), {
						localName: name,
						globalName: hashedGlobalName(sourceFile.fileName, name, projectDir),
						sourceFileName: sourceFile.fileName,
						node: declaration,
					})
				}
			}
		}
	}

	return { functions, consts, files, commandSyntax: new Map() }
}

/** Read the `init`/`initServer`/`initPlayerLocal` handlers from a default-exported
 * `defineMission({...})` (or a bare default-exported object literal). */
export function extractMissionHandlers(indexSourceFile: ts.SourceFile): MissionHandler[] {
	const exportAssignment = indexSourceFile.statements.find(
		(statement): statement is ts.ExportAssignment =>
			ts.isExportAssignment(statement) && statement.isExportEquals !== true,
	)
	if (exportAssignment === undefined) {
		throw new UnsupportedSyntaxError(indexSourceFile, indexSourceFile,
			`${relativeName(indexSourceFile)} must "export default defineMission({ ... })"`)
	}

	const object = unwrapMissionObject(exportAssignment.expression)
	if (object === undefined) {
		throw new UnsupportedSyntaxError(exportAssignment, indexSourceFile,
			"default export must be defineMission({ ... }) or an object literal")
	}

	const handlers: MissionHandler[] = []
	for (const property of object.properties) {
		const name = handlerName(property)
		if (name === undefined || !MISSION_HANDLER_NAMES.includes(name)) {
			throw new UnsupportedSyntaxError(property, indexSourceFile,
				`unsupported mission handler; expected one of: ${MISSION_HANDLER_NAMES.join(", ")}`)
		}
		const fn = handlerFunction(property)
		if (fn === undefined) {
			throw new UnsupportedSyntaxError(property, indexSourceFile,
				`mission handler "${name}" must be a function`)
		}
		handlers.push({ name, node: fn })
	}
	return handlers
}

function unwrapMissionObject(expr: ts.Expression): ts.ObjectLiteralExpression | undefined {
	if (ts.isObjectLiteralExpression(expr)) return expr
	if (ts.isCallExpression(expr) && expr.arguments.length === 1 && ts.isObjectLiteralExpression(expr.arguments[0]!)) {
		return expr.arguments[0] as ts.ObjectLiteralExpression
	}
	return undefined
}

function handlerName(property: ts.ObjectLiteralElementLike): string | undefined {
	if ((ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)) && ts.isIdentifier(property.name)) {
		return property.name.text
	}
	return undefined
}

function handlerFunction(
	property: ts.ObjectLiteralElementLike,
): ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration | undefined {
	if (ts.isMethodDeclaration(property)) return property
	if (ts.isPropertyAssignment(property)
		&& (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))) {
		return property.initializer
	}
	return undefined
}

function relativeName(sourceFile: ts.SourceFile): string {
	const parts = sourceFile.fileName.split("/")
	return parts[parts.length - 1] ?? sourceFile.fileName
}
