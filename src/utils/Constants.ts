import ts from "typescript"

export const TYPES_PACKAGE_NAME = "js-to-sqf"

/** Entry files are resolved relative to this directory within the project. */
export const SRC_DIR = "src"

export const ENTRY_FILE_NAMES = [
	"initPlayerLocal.js",
	"initPlayerLocal.ts",
	"initServer.js",
	"initServer.ts"
]

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

export const CONSUMER_TS_COMPILER_OPTIONS = {
	allowJs: true,
	checkJs: false,
	noLib: true,
	noEmit: true,
	target: ts.ScriptTarget.Latest,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
}