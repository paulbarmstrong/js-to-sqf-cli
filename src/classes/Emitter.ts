import ts from "typescript"
import { BINARY_OPERATOR_MAPPINGS, NAMESPACE_MAPPINGS, NamespaceMapping, PREFIX_OPERATOR_MAPPINGS, TYPES_PACKAGE_NAME } from "../utils/Constants.js"

export class UnsupportedSyntaxError extends Error {
	override name = "UnsupportedSyntaxError"
	constructor(node: ts.Node, sourceFile: ts.SourceFile, message: string) {
		const { line, character } = sourceFile.getLineAndCharacterOfPosition(
			node.getStart(sourceFile),
		)
		const where = `${sourceFile.fileName}:${line + 1}:${character + 1}`
		super(`${where}: ${message}`)
	}
}

export class Emitter {
	/** local name (possibly aliased) -> SQF command, populated from intrinsic imports */
	private importAliases = new Map<string, string>()

	/** local name (possibly aliased) -> namespace convention, for imports like `bis`/`diag` */
	private importedNamespaces = new Map<string, NamespaceMapping>()

	constructor(private readonly sourceFile: ts.SourceFile) {}

	emitFile(): string {
		// Statements are emitted in order; imports come first in ES modules, so
		// the intrinsics map is populated before any call that uses it.
		const lines = this.sourceFile.statements
			.map((statement) => this.emitStatement(statement))
			.filter((line) => line.length > 0)
		return lines.join("\n") + (lines.length > 0 ? "\n" : "")
	}

	private emitStatement(node: ts.Statement): string {
		switch (node.kind) {
			case ts.SyntaxKind.ImportDeclaration:
				this.registerImport(node as ts.ImportDeclaration)
				return ""

			case ts.SyntaxKind.ExpressionStatement:
				return `${this.emitExpression((node as ts.ExpressionStatement).expression)};`

			case ts.SyntaxKind.IfStatement:
				return this.emitIf(node as ts.IfStatement)

			case ts.SyntaxKind.Block:
				return this.emitBlock(node as ts.Block)

			default:
				throw new UnsupportedSyntaxError(node, this.sourceFile, `unsupported statement: ${ts.SyntaxKind[node.kind]}`)
		}
	}

	private emitBlock(node: ts.Block): string {
		return node.statements
			.map((statement) => this.emitStatement(statement))
			.filter((line) => line.length > 0)
			.join("\n")
	}

	private emitIf(node: ts.IfStatement): string {
		const condition = this.emitExpression(node.expression)
		const thenBranch = this.indent(this.emitStatement(node.thenStatement))
		let out = `if (${condition}) then {\n${thenBranch}\n}`
		if (node.elseStatement !== undefined) {
			out += ` else {\n${this.indent(this.emitStatement(node.elseStatement))}\n}`
		}
		return out + ";"
	}

	private emitExpression(node: ts.Expression): string {
		switch (node.kind) {
			case ts.SyntaxKind.CallExpression:
				return this.emitCall(node as ts.CallExpression)

			case ts.SyntaxKind.BinaryExpression:
				return this.emitBinary(node as ts.BinaryExpression)

			case ts.SyntaxKind.ParenthesizedExpression:
				return `(${this.emitExpression((node as ts.ParenthesizedExpression).expression)})`

			case ts.SyntaxKind.PrefixUnaryExpression:
				return this.emitPrefixUnary(node as ts.PrefixUnaryExpression)

			case ts.SyntaxKind.Identifier:
				// NOTE: emitted verbatim for now. SQF local variables must be `_`-prefixed;
				// a naming/scope convention is still TODO before real variable support.
				return (node as ts.Identifier).text

			case ts.SyntaxKind.StringLiteral:
				return this.emitString((node as ts.StringLiteral).text)

			case ts.SyntaxKind.NumericLiteral:
				return (node as ts.NumericLiteral).text

			case ts.SyntaxKind.TrueKeyword:
				return "true"

			case ts.SyntaxKind.FalseKeyword:
				return "false"

			default:
				throw new UnsupportedSyntaxError(node, this.sourceFile,
					`unsupported expression: ${ts.SyntaxKind[node.kind]}`)
		}
	}

	private emitBinary(node: ts.BinaryExpression): string {
		const operator = BINARY_OPERATOR_MAPPINGS.get(node.operatorToken.kind)
		if (operator === undefined) {
			throw new UnsupportedSyntaxError(
				node.operatorToken, this.sourceFile,
				`unsupported operator: ${ts.SyntaxKind[node.operatorToken.kind]}`,
			)
		}
		return `${this.emitExpression(node.left)} ${operator} ${this.emitExpression(node.right)}`
	}

	/** SQF string literals are double-quoted; an embedded `"` is escaped by doubling it. */
	private emitString(value: string): string {
		return `"${value.replace(/"/g, '""')}"`
	}

	private emitPrefixUnary(node: ts.PrefixUnaryExpression): string {
		const operator = PREFIX_OPERATOR_MAPPINGS.get(node.operator)
		if (operator === undefined) {
			throw new UnsupportedSyntaxError(node, this.sourceFile,
				`unsupported unary operator: ${ts.SyntaxKind[node.operator]}`)
		}
		return `${operator}${this.emitExpression(node.operand)}`
	}

	private emitCall(node: ts.CallExpression): string {
		const args = node.arguments.map((arg) => this.emitExpression(arg))

		// Namespace member call, e.g. `bis.crewCount(...)` or `diag.log(...)`.
		if (ts.isPropertyAccessExpression(node.expression)) {
			return this.emitNamespaceCall(node.expression, args)
		}

		if (!ts.isIdentifier(node.expression)) {
			throw new UnsupportedSyntaxError(node.expression, this.sourceFile,
				"only direct function calls are supported")
		}
		const command = this.importAliases.get(node.expression.text)
		if (command === undefined) {
			throw new UnsupportedSyntaxError(
				node.expression, this.sourceFile,
				`call to "${node.expression.text}" has no SQF mapping`,
			)
		}
		return this.emitCommandCall(command, args)
	}

	private emitNamespaceCall(callee: ts.PropertyAccessExpression, args: string[]): string {
		if (!ts.isIdentifier(callee.expression)) {
			throw new UnsupportedSyntaxError(callee.expression, this.sourceFile,
				"only calls on an imported namespace are supported")
		}
		const namespace = this.importedNamespaces.get(callee.expression.text)
		if (namespace === undefined) {
			throw new UnsupportedSyntaxError(callee.expression, this.sourceFile,
				`"${callee.expression.text}" is not an imported intrinsic namespace`)
		}
		const command = `${namespace.sqfPrefix}${callee.name.text}`
		return namespace.form === "call"
			? this.emitFunctionCall(command, args)
			: this.emitCommandCall(command, args)
	}

	/** Unary SQF command form: `cmd arg`, or `cmd [a, b]` for multiple args, or bare `cmd` for none. */
	private emitCommandCall(command: string, args: string[]): string {
		if (args.length === 0) return command
		if (args.length === 1) return `${command} ${args[0]}`
		return `${command} [${args.join(", ")}]`
	}

	/** BIS function form, invoked via `call`: `call FN`, `arg call FN`, or `[a, b] call FN`. */
	private emitFunctionCall(command: string, args: string[]): string {
		if (args.length === 0) return `call ${command}`
		if (args.length === 1) return `${args[0]} call ${command}`
		return `[${args.join(", ")}] call ${command}`
	}

	/** Record the SQF command each name from an intrinsic import maps to, and
	 * reject any import we can't honor. Relative imports register nothing. */
	private registerImport(node: ts.ImportDeclaration): void {
		const spec = (node.moduleSpecifier as ts.StringLiteral).text
		if (spec.startsWith(".") || spec.startsWith("/")) return // relative import: part of our own graph
		if (spec !== TYPES_PACKAGE_NAME) {
			throw new UnsupportedSyntaxError(node, this.sourceFile,
				`import of external module "${spec}" cannot be transpiled to SQF`)
		}

		const clause = node.importClause
		if (clause === undefined) return // `import "x"`: side-effect only, binds nothing
		if (clause.name !== undefined) {
			throw new UnsupportedSyntaxError(node, this.sourceFile,
				`default import from "${spec}" is not supported; use named imports`)
		}
		const bindings = clause.namedBindings
		if (bindings === undefined) return
		if (ts.isNamespaceImport(bindings)) {
			throw new UnsupportedSyntaxError(node, this.sourceFile,
				`namespace import from "${spec}" is not supported; use named imports`)
		}
		for (const element of bindings.elements) {
			// propertyName is the original export when aliased (`{ diagLog as log }`)
			const importedName = (element.propertyName ?? element.name).text
			const namespace = NAMESPACE_MAPPINGS.get(importedName)
			if (namespace !== undefined) {
				this.importedNamespaces.set(element.name.text, namespace)
			} else {
				this.importAliases.set(element.name.text, importedName)
			}
		}
	}

	private indent(block: string): string {
		return block
			.split("\n")
			.map((line) => (line.length > 0 ? `\t${line}` : line))
			.join("\n")
	}
}
