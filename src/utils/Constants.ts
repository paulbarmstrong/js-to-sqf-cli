import ts from "typescript"

export const TYPES_PACKAGE_NAME = "js-to-sqf"

/** Source files are resolved relative to this directory within the project. */
export const SRC_DIR = "src"

/** Directory (under the project root) that generated function files are written to. */
export const SQF_OUTPUT_DIR = "sqf"

/** File name of a generated function, with the BI `fn_` discovery prefix. */
export function functionFileName(functionGlobalName: string): string {
	return `fn_${functionGlobalName}.sqf`
}

/** Mission-relative SQF path to a function's file (backslash-separated, as SQF uses),
 * e.g. `sqf\fn_blowUp_a1b2c3d4.sqf`. Used when a function is passed as a value. */
export function functionSqfPath(functionGlobalName: string): string {
	return `${SQF_OUTPUT_DIR}\\${functionFileName(functionGlobalName)}`
}

/** The mission entry point: a default-exported `defineMission({...})`. */
export const INDEX_FILE_NAMES = ["index.ts", "index.js"]

/** Generated file (under `sqf/`) holding every static const global definition. */
export const CONSTANTS_FILE_NAME = "constants.sqf"

/** Generated config (at the project root) registering every function as `JS_fnc_<name>`. */
export const CFG_FUNCTIONS_FILE_NAME = "CfgFunctions.hpp"

/** MissionDefinition handlers, each emitted to a root `<name>.sqf` init script. */
export const MISSION_HANDLER_NAMES = ["init", "initServer", "initPlayerLocal"]

export const BINARY_OPERATOR_MAPPINGS: Map<ts.SyntaxKind, string> = new Map([
	[ts.SyntaxKind.PlusToken, "+"],
	[ts.SyntaxKind.MinusToken, "-"],
	[ts.SyntaxKind.AsteriskToken, "*"],
	[ts.SyntaxKind.SlashToken, "/"],
	[ts.SyntaxKind.PercentToken, "%"],
	[ts.SyntaxKind.GreaterThanToken, ">"],
	[ts.SyntaxKind.LessThanToken, "<"],
	[ts.SyntaxKind.GreaterThanEqualsToken, ">="],
	[ts.SyntaxKind.LessThanEqualsToken, "<="],
	[ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
	[ts.SyntaxKind.EqualsEqualsToken, "=="],
	[ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="],
	[ts.SyntaxKind.ExclamationEqualsToken, "!="],
	[ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
	[ts.SyntaxKind.BarBarToken, "||"],
])

/** Assignment operators. The value is the underlying binary operator a compound
 * assignment desugars to (`x += y` -> `x = x + y`); `null` is plain `=`. SQF has no
 * compound-assignment operators, so they must be expanded. */
export const ASSIGNMENT_OPERATOR_MAPPINGS: Map<ts.SyntaxKind, string | null> = new Map([
	[ts.SyntaxKind.EqualsToken, null],
	[ts.SyntaxKind.PlusEqualsToken, "+"],
	[ts.SyntaxKind.MinusEqualsToken, "-"],
	[ts.SyntaxKind.AsteriskEqualsToken, "*"],
	[ts.SyntaxKind.SlashEqualsToken, "/"],
	[ts.SyntaxKind.PercentEqualsToken, "%"],
])

export const PREFIX_OPERATOR_MAPPINGS: Map<ts.SyntaxKind, string> = new Map([
	[ts.SyntaxKind.ExclamationToken, "!"],
	[ts.SyntaxKind.MinusToken, "-"],
	[ts.SyntaxKind.PlusToken, "+"],
])

/** How a call through an intrinsic namespace is emitted to SQF.
 * - `command`: prefix/infix operator form, like a top-level command (`diag_log x`).
 * - `call`: invoked via the `call` operator with an args array (`[a, b] call BIS_fnc_x`). */
export type NamespaceCallForm = "command" | "call"

export interface NamespaceMapping {
	/** Prepended to the member name to form the SQF identifier (`bis.crewCount` -> `BIS_fnc_crewCount`). */
	sqfPrefix: string
	form: NamespaceCallForm
}

/** Imported names that are namespaces rather than plain commands, keyed by their
 * original export name (the alias, if any, is resolved before lookup). */
export const NAMESPACE_MAPPINGS: Map<string, NamespaceMapping> = new Map([
	["bis", { sqfPrefix: "BIS_fnc_", form: "call" }],
	["diag", { sqfPrefix: "diag_", form: "command" }],
])

/** Zero-arg value methods (e.g. `x.toString()`) that map to a unary SQF command
 * applied to the receiver: `x.toString()` -> `str x`. */
export const METHOD_MAPPINGS: Map<string, string> = new Map([
	["toString", "str"],
])

/** An array iteration method that maps to an SQF iteration command taking a code block.
 * SQF exposes the current element as `_x` (and the index as `_forEachIndex`). */
export interface IterationMapping {
	/** SQF command: `forEach`, `apply` (map), or `select` (filter). */
	command: string
	/** `forEach` is `{code} forEach array`; `apply`/`select` are `array command {code}`. */
	codeFirst: boolean
	/** Whether a second (index) callback parameter is available (only `forEach`). */
	allowIndex: boolean
}

/** Array methods that map to SQF iteration commands operating on `_x`. */
export const ITERATION_METHOD_MAPPINGS: Map<string, IterationMapping> = new Map([
	["forEach", { command: "forEach", codeFirst: true, allowIndex: true }],
	["map", { command: "apply", codeFirst: false, allowIndex: false }],
	["filter", { command: "select", codeFirst: false, allowIndex: false }],
])

export const CONSUMER_TS_COMPILER_OPTIONS = {
	allowJs: true,
	checkJs: false,
	noLib: true,
	noEmit: true,
	target: ts.ScriptTarget.Latest,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
}