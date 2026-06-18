import ts from "typescript"
import { createHash } from "node:crypto"
import { dirname, relative, resolve, sep } from "node:path"
import { MISSION_HANDLER_NAMES } from "../utils/Constants.js"
import { UnsupportedSyntaxError } from "./UnsupportedSyntaxError.js"

/** A user-defined function discovered anywhere under `src/`. Each becomes its own
 * `sqf/<name>.sqf` file, registered in `CfgFunctions.hpp` as `JS_fnc_<name>`. */
export interface FunctionDef {
	/** Global function name; also the SQF file base name and `JS_fnc_` suffix. */
	name: string
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

/** A project-wide registry, built once before emission, that gives each `Emitter`
 * the cross-file knowledge it needs to resolve identifiers. */
export interface ProjectModel {
	/** functionName -> definition. The function namespace is global to the project. */
	functions: Map<string, FunctionDef>
	/** `${sourceFileName}#${localName}` -> module-const global. */
	consts: Map<string, ConstGlobal>
	/** Absolute paths of every user source file, for relative-import resolution. */
	files: Set<string>
}

/** A model with no cross-file knowledge. Used by unit tests that emit a single
 * in-memory source file. */
export const EMPTY_PROJECT_MODEL: ProjectModel = {
	functions: new Map(),
	consts: new Map(),
	files: new Set(),
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

/** A deterministic, collision-resistant suffix so two same-named consts in different
 * files don't clash. Derived from the project-relative path + name so it is stable
 * across re-runs (no churn under `--watch`) and across machines. */
function globalConstName(sourceFileName: string, localName: string, projectDir: string): string {
	const relPath = relative(projectDir, sourceFileName).split(sep).join("/")
	const hash = createHash("sha1").update(`${relPath}#${localName}`).digest("hex").slice(0, 8)
	return `${localName}_${hash}`
}

/** A top-level `const` declaration (exported or not). */
function isModuleConstStatement(statement: ts.Statement): statement is ts.VariableStatement {
	return ts.isVariableStatement(statement)
		&& (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
}

/** Outside-function consts must be immutable literal values: number, string, boolean,
 * or an array of such (nested arrays allowed). */
function isLiteralInitializer(expr: ts.Expression): boolean {
	switch (expr.kind) {
		case ts.SyntaxKind.NumericLiteral:
		case ts.SyntaxKind.StringLiteral:
		case ts.SyntaxKind.TrueKeyword:
		case ts.SyntaxKind.FalseKeyword:
			return true
		case ts.SyntaxKind.PrefixUnaryExpression: {
			const unary = expr as ts.PrefixUnaryExpression
			return (unary.operator === ts.SyntaxKind.MinusToken || unary.operator === ts.SyntaxKind.PlusToken)
				&& unary.operand.kind === ts.SyntaxKind.NumericLiteral
		}
		case ts.SyntaxKind.ArrayLiteralExpression:
			return (expr as ts.ArrayLiteralExpression).elements.every(isLiteralInitializer)
		default:
			return false
	}
}

/** Discover all functions (globally named) and all module-level consts (materialized
 * as global SQF variables). Function name collisions and non-literal module consts
 * are errors. */
export function buildProjectModel(userFiles: readonly ts.SourceFile[], projectDir: string): ProjectModel {
	const files = new Set(userFiles.map((sf) => sf.fileName))
	const functions = new Map<string, FunctionDef>()
	const consts = new Map<string, ConstGlobal>()

	for (const sourceFile of userFiles) {
		for (const statement of sourceFile.statements) {
			if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
				const name = statement.name.text
				const existing = functions.get(name)
				if (existing !== undefined) {
					throw new UnsupportedSyntaxError(statement, sourceFile,
						`function "${name}" is already defined in ${relative(projectDir, existing.sourceFileName)}; ` +
						"function names must be unique across the project")
				}
				functions.set(name, { name, sourceFileName: sourceFile.fileName, node: statement })
			} else if (isModuleConstStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					if (!ts.isIdentifier(declaration.name)) continue
					if (declaration.initializer === undefined || !isLiteralInitializer(declaration.initializer)) {
						throw new UnsupportedSyntaxError(declaration, sourceFile,
							`const "${declaration.name.text}" outside a function must be an immutable literal value`)
					}
					const name = declaration.name.text
					consts.set(constKey(sourceFile.fileName, name), {
						localName: name,
						globalName: globalConstName(sourceFile.fileName, name, projectDir),
						sourceFileName: sourceFile.fileName,
						node: declaration,
					})
				}
			}
		}
	}

	return { functions, consts, files }
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
