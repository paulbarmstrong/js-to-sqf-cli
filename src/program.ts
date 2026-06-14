import { relative } from "node:path"
import ts from "typescript"

/**
 * Thrown when the source uses a construct we can't (or won't) represent in SQF.
 * These are expected, user-facing errors — print the message, not a stack trace.
 */
export class UnsupportedSyntaxError extends Error {
	override name = "UnsupportedSyntaxError"
}

/**
 * The set of AST node kinds the transpiler knows how to handle. This is an
 * ALLOWLIST on purpose: anything not listed here throws, so we can never
 * silently emit garbage for syntax we haven't implemented. Grow this set as
 * the emitter learns new node kinds.
 *
 * Note: a few kinds share numeric values with aliases the printer shows under
 * different names (e.g. NumericLiteral === FirstLiteralToken, VariableStatement
 * === FirstStatement) — comparing by kind value handles both.
 */
const SUPPORTED_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
	ts.SyntaxKind.SourceFile,
	ts.SyntaxKind.EndOfFileToken,
	// statements
	ts.SyntaxKind.VariableStatement,
	ts.SyntaxKind.VariableDeclarationList,
	ts.SyntaxKind.VariableDeclaration,
	ts.SyntaxKind.FunctionDeclaration,
	ts.SyntaxKind.Block,
	ts.SyntaxKind.ReturnStatement,
	ts.SyntaxKind.IfStatement,
	ts.SyntaxKind.ExpressionStatement,
	// expressions
	ts.SyntaxKind.BinaryExpression,
	ts.SyntaxKind.CallExpression,
	ts.SyntaxKind.ParenthesizedExpression,
	ts.SyntaxKind.PrefixUnaryExpression,
	ts.SyntaxKind.Identifier,
	ts.SyntaxKind.Parameter,
	// literals
	ts.SyntaxKind.StringLiteral,
	ts.SyntaxKind.NumericLiteral,
	ts.SyntaxKind.TrueKeyword,
	ts.SyntaxKind.FalseKeyword,
	// operator / punctuation tokens that appear as their own nodes
	ts.SyntaxKind.PlusToken,
	ts.SyntaxKind.MinusToken,
	ts.SyntaxKind.AsteriskToken,
	ts.SyntaxKind.SlashToken,
	ts.SyntaxKind.PercentToken,
	ts.SyntaxKind.GreaterThanToken,
	ts.SyntaxKind.LessThanToken,
	ts.SyntaxKind.GreaterThanEqualsToken,
	ts.SyntaxKind.LessThanEqualsToken,
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.AmpersandAmpersandToken,
	ts.SyntaxKind.BarBarToken,
	ts.SyntaxKind.ExclamationToken,
	ts.SyntaxKind.EqualsToken,
	// modifier tokens (e.g. `export function`) — relative exports are part of our graph
	ts.SyntaxKind.ExportKeyword,
	ts.SyntaxKind.DefaultKeyword,
])

/**
 * Build a Program over the entry files. createProgram resolves and loads the
 * ENTIRE transitive graph (every relative import, recursively), unlike
 * createSourceFile which only parses one file.
 *
 * - allowJs: entry files are `.js`, so they must be allowed in.
 * - noLib: we don't type-check, so skip loading the lib.*.d.ts files.
 * - noEmit: we produce SQF ourselves; never let tsc write output.
 */
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

/**
 * Load the module graph from the entry files and validate every file in it.
 * Returns the user's own source files (entry + followed relative imports),
 * excluding anything from node_modules or the default lib.
 *
 * Throws UnsupportedSyntaxError on a parse error, an external (npm/builtin)
 * import, or any node kind not in SUPPORTED_KINDS.
 */
export function loadAndValidate(entryFiles: string[], rootDir: string): ts.SourceFile[] {
	const program = loadProgram(entryFiles)

	// Surface parse errors (unterminated strings, stray tokens, ...) up front.
	const syntactic = program.getSyntacticDiagnostics()
	if (syntactic.length > 0) {
		const formatted = ts.formatDiagnosticsWithColorAndContext(syntactic, {
			getCurrentDirectory: () => rootDir,
			getCanonicalFileName: (f) => f,
			getNewLine: () => "\n",
		})
		throw new UnsupportedSyntaxError(`parse error(s):\n${formatted}`)
	}

	const userFiles = program
		.getSourceFiles()
		.filter(
			(sf) =>
				!program.isSourceFileFromExternalLibrary(sf) &&
				!program.isSourceFileDefaultLibrary(sf),
		)

	for (const sourceFile of userFiles) {
		checkSupported(sourceFile, rootDir)
	}
	return userFiles
}

/** A bare specifier ("lodash", "node:fs") resolves to node_modules / a builtin —
 * i.e. external code we can't transpile. A relative one ("./x", "../y") is part
 * of our own graph and is fine to follow. */
function isBareSpecifier(spec: string): boolean {
	return !spec.startsWith(".") && !spec.startsWith("/")
}

/**
 * Validate a single already-parsed source file against SUPPORTED_KINDS and the
 * external-import rule. Exported so it can be unit-tested in-memory (build a
 * SourceFile with ts.createSourceFile, no disk needed).
 */
export function checkSupported(sourceFile: ts.SourceFile, rootDir: string): void {
	const fail = (node: ts.Node, message: string): never => {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(
			node.getStart(sourceFile),
		)
		const where = `${relative(rootDir, sourceFile.fileName)}:${line + 1}:${character + 1}`
		throw new UnsupportedSyntaxError(`${where}: ${message}`)
	}

	const visit = (node: ts.Node): void => {
		// import ... from "x"  /  export ... from "x"
		if (
			ts.isImportDeclaration(node) ||
			(ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined)
		) {
			const spec = (node.moduleSpecifier as ts.StringLiteral | undefined)?.text
			if (spec !== undefined && isBareSpecifier(spec)) {
				fail(node, `import of external module "${spec}" cannot be transpiled to SQF`)
			}
			return // relative import: resolved into the graph; nothing to validate inside it
		}

		// require("x")  /  dynamic import("x")
		if (ts.isCallExpression(node)) {
			const isRequire =
				ts.isIdentifier(node.expression) && node.expression.text === "require"
			const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
			if (isRequire || isDynamicImport) {
				const arg = node.arguments[0]
				if (arg !== undefined && ts.isStringLiteral(arg) && isBareSpecifier(arg.text)) {
					fail(node, `import of external module "${arg.text}" cannot be transpiled to SQF`)
				}
			}
		}

		if (!SUPPORTED_KINDS.has(node.kind)) {
			fail(node, `unsupported syntax: ${ts.SyntaxKind[node.kind]}`)
		}
		ts.forEachChild(node, visit)
	}

	visit(sourceFile)
}
