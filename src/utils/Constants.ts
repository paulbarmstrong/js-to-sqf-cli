import ts from "typescript"

export const TYPES_PACKAGE_NAME = "js-to-sqf"

/** Intrinsic whose call looks up an object by its mission-editor variable name:
 * `getGameObjectByVariableName(x)` -> `(missionNamespace getVariable x)`. */
export const GET_GAME_OBJECT_BY_VARIABLE_NAME = "getGameObjectByVariableName"

/** Intrinsic class whose construction builds an SQF config path with `>>`:
 * `new Config(configFile(), "CfgVehicles", x)` -> `(configFile >> "CfgVehicles" >> x)`. */
export const CONFIG_CLASS_NAME = "Config"

/** Source files are resolved relative to this directory within the project. */
export const SRC_DIR = "src"

/** Directory (under the project root) that generated function files are written to. */
export const SQF_OUTPUT_DIR = "sqf"

/** File name of a generated function, with the BI `fn_` discovery prefix. */
export function functionFileName(functionGlobalName: string): string {
	return `fn_${functionGlobalName}.sqf`
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
])

/** Zero-arg value methods (e.g. `x.toString()`) that map to a unary SQF command
 * applied to the receiver: `x.toString()` -> `str x`. */
export const METHOD_MAPPINGS: Map<string, string> = new Map([
	["toString", "str"],
])

/** An array iteration method. All compile through SQF `forEach` (the only iteration
 * command exposing both `_x` and `_forEachIndex`); `map`/`filter` collect into a new
 * array via `pushBack`, so the element and index are always available. */
export type IterationKind = "forEach" | "map" | "filter"

export const ITERATION_METHODS: Map<string, IterationKind> = new Map([
	["forEach", "forEach"],
	["map", "map"],
	["filter", "filter"],
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