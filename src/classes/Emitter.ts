import ts from "typescript"
import { ASSIGNMENT_OPERATOR_MAPPINGS, BINARY_OPERATOR_MAPPINGS, METHOD_MAPPINGS, NAMESPACE_MAPPINGS, NamespaceMapping, PREFIX_OPERATOR_MAPPINGS, TYPES_PACKAGE_NAME } from "../utils/Constants.js"
import { constKey, ConstGlobal, EMPTY_PROJECT_MODEL, FunctionDef, ProjectModel, resolveRelativeImport } from "./ProjectModel.js"
import { UnsupportedSyntaxError } from "./UnsupportedSyntaxError.js"

export class Emitter {
	/** local name (possibly aliased) -> SQF command, populated from intrinsic imports */
	private importAliases = new Map<string, string>()

	/** local name (possibly aliased) -> namespace convention, for imports like `bis`/`diag` */
	private importedNamespaces = new Map<string, NamespaceMapping>()

	/** local name -> cross-file const imported into this file (resolves to a global) */
	private importedConsts = new Map<string, ConstGlobal>()

	/** local name (possibly aliased) -> function imported into this file via a relative import */
	private importedFunctions = new Map<string, FunctionDef>()

	/** in-scope local variable/parameter names; references are `_`-prefixed in SQF */
	private locals = new Set<string>()

	/** whether emission is currently inside a function body; mutation is only allowed there */
	private inFunctionBody = false

	private prepared = false

	constructor(
		private readonly sourceFile: ts.SourceFile,
		private readonly project: ProjectModel = EMPTY_PROJECT_MODEL,
	) {}

	/** Register this file's imports before any emission. A function body can reference
	 * imports declared earlier in the file, so registration can't rely on in-order
	 * statement traversal. Same-file functions are resolved via the project model.
	 * Idempotent. */
	private prepare(): void {
		if (this.prepared) return
		this.prepared = true
		for (const statement of this.sourceFile.statements) {
			if (ts.isImportDeclaration(statement)) {
				this.registerImport(statement)
			}
		}
	}

	/** Emit the file's top-level code. Function declarations emit nothing here —
	 * each user function is written to its own `sqf/` file (see `emitFunctionBody`). */
	emitFile(): string {
		this.prepare()
		const lines = this.sourceFile.statements
			.map((statement) => this.emitStatement(statement))
			.filter((line) => line.length > 0)
		return lines.join("\n") + (lines.length > 0 ? "\n" : "")
	}

	/** Emit the body of a function-like node (a user `function`, or a mission handler
	 * arrow/function-expression/method) as the contents of an SQF file: a `params [...]`
	 * binding (if any) followed by the body. No `name = { ... }` wrapper — function
	 * files are compiled directly into `JS_fnc_<name>` and init scripts run their body. */
	emitFunctionBody(
		node: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration,
	): string {
		this.prepare()
		if (node.body === undefined) {
			throw new UnsupportedSyntaxError(node, this.sourceFile, "function has no body")
		}
		const paramNames = node.parameters.map((param) => {
			if (!ts.isIdentifier(param.name)) {
				throw new UnsupportedSyntaxError(param, this.sourceFile,
					"destructured parameters are not supported")
			}
			return param.name.text
		})

		// Params and any locals declared inside the body are scoped to this function.
		const outerLocals = this.locals
		const outerInFunctionBody = this.inFunctionBody
		this.locals = new Set(outerLocals)
		this.inFunctionBody = true
		paramNames.forEach((name) => this.locals.add(name))
		const parts: string[] = []
		if (paramNames.length > 0) {
			parts.push(`params [${paramNames.map((name) => `"_${name}"`).join(", ")}];`)
		}
		// Arrow functions may have a concise (expression) body; everything else a block.
		const body = ts.isBlock(node.body)
			? this.emitBlock(node.body)
			: `${this.emitExpression(node.body)};`
		if (body.length > 0) parts.push(body)
		this.locals = outerLocals
		this.inFunctionBody = outerInFunctionBody

		return parts.join("\n")
	}

	/** Emit the global-variable definition for a module-level const, e.g. `num_a1b2 = 5;`.
	 * Collected into `sqf/constants.sqf`. */
	emitConstDefinition(c: ConstGlobal): string {
		this.prepare()
		if (c.node.initializer === undefined) {
			throw new UnsupportedSyntaxError(c.node, this.sourceFile,
				`const "${c.localName}" must have an initializer`)
		}
		return `${c.globalName} = ${this.emitExpression(c.node.initializer)};`
	}

	private emitStatement(node: ts.Statement): string {
		switch (node.kind) {
			case ts.SyntaxKind.ImportDeclaration:
				// Already handled in `prepare()`.
				return ""

			case ts.SyntaxKind.FunctionDeclaration:
				// Nested functions have no SQF representation; a function inside a body
				// would otherwise be silently dropped. A top-level function reaching here
				// (only via emitFile) is emitted to its own `sqf/` file, not inline.
				if (this.inFunctionBody) {
					throw new UnsupportedSyntaxError(node, this.sourceFile,
						"nested functions are not supported; declare functions at the top level")
				}
				return ""

			case ts.SyntaxKind.ExpressionStatement:
				return `${this.emitExpression((node as ts.ExpressionStatement).expression)};`

			case ts.SyntaxKind.IfStatement:
				return this.emitIf(node as ts.IfStatement)

			case ts.SyntaxKind.Block:
				return this.emitBlock(node as ts.Block)

			case ts.SyntaxKind.VariableStatement:
				return this.emitVariableStatement(node as ts.VariableStatement)

			case ts.SyntaxKind.ReturnStatement:
				return this.emitReturn(node as ts.ReturnStatement)

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

	private emitVariableStatement(node: ts.VariableStatement): string {
		return node.declarationList.declarations
			.map((declaration) => this.emitVariableDeclaration(declaration))
			.join("\n")
	}

	private emitVariableDeclaration(node: ts.VariableDeclaration): string {
		if (!ts.isIdentifier(node.name)) {
			throw new UnsupportedSyntaxError(node.name, this.sourceFile,
				"destructuring declarations are not supported")
		}
		const name = node.name.text
		// A module-level const becomes a global (defined in sqf/constants.sqf), so its
		// declaration emits nothing here and it must NOT be registered as a local.
		// (Reached only via emitFile, which is not used by the CLI; kept for tests.)
		if (!this.inFunctionBody) {
			return ""
		}
		// Resolve the initializer before binding the name, then register it so later
		// references emit as `_name`.
		const out = node.initializer === undefined
			? `private _${name};`
			: `private _${name} = ${this.emitExpression(node.initializer)};`
		this.locals.add(name)
		return out
	}

	/** SQF code blocks have no `return`; the block's value is its last expression. */
	private emitReturn(node: ts.ReturnStatement): string {
		if (node.expression === undefined) return ""
		return `${this.emitExpression(node.expression)};`
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

			case ts.SyntaxKind.ArrayLiteralExpression:
				return this.emitArrayLiteral(node as ts.ArrayLiteralExpression)

			case ts.SyntaxKind.PrefixUnaryExpression:
				return this.emitPrefixUnary(node as ts.PrefixUnaryExpression)

			case ts.SyntaxKind.Identifier:
				return this.emitIdentifier(node as ts.Identifier)

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
		if (ASSIGNMENT_OPERATOR_MAPPINGS.has(node.operatorToken.kind)) {
			return this.emitAssignment(node)
		}
		const operator = BINARY_OPERATOR_MAPPINGS.get(node.operatorToken.kind)
		if (operator === undefined) {
			throw new UnsupportedSyntaxError(
				node.operatorToken, this.sourceFile,
				`unsupported operator: ${ts.SyntaxKind[node.operatorToken.kind]}`,
			)
		}
		return `${this.emitExpression(node.left)} ${operator} ${this.emitExpression(node.right)}`
	}

	/** Variable mutation. Only allowed inside a function body (the readme forbids
	 * mutating variables outside functions). Compound assignments are desugared,
	 * since SQF has no `+=` etc. */
	private emitAssignment(node: ts.BinaryExpression): string {
		if (!this.inFunctionBody) {
			throw new UnsupportedSyntaxError(node, this.sourceFile,
				"mutating variables outside of functions is not supported")
		}
		const compound = ASSIGNMENT_OPERATOR_MAPPINGS.get(node.operatorToken.kind)!
		const left = this.emitExpression(node.left)
		const right = this.emitExpression(node.right)
		return compound === null ? `${left} = ${right}` : `${left} = ${left} ${compound} ${right}`
	}

	/** A JS array literal maps directly to an SQF array: `[a, b, c]` (empty -> `[]`). */
	private emitArrayLiteral(node: ts.ArrayLiteralExpression): string {
		return `[${node.elements.map((element) => this.emitExpression(element)).join(", ")}]`
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

	private emitIdentifier(node: ts.Identifier): string {
		const name = node.text
		// SQF locals must be `_`-prefixed.
		if (this.locals.has(name)) return `_${name}`
		// A module-level const — imported here, or declared in this file — resolves to
		// its global SQF variable name (defined in sqf/constants.sqf).
		const imported = this.importedConsts.get(name)
		if (imported !== undefined) return imported.globalName
		const own = this.project.consts.get(constKey(this.sourceFile.fileName, name))
		if (own !== undefined) return own.globalName
		// Everything else (commands, etc.) is emitted verbatim.
		return name
	}

	private emitCall(node: ts.CallExpression): string {
		const args = node.arguments.map((arg) => this.emitExpression(arg))

		// Property-access callee: either a namespace member (`bis.crewCount(...)`)
		// or a method on a value (`x.toString()`).
		if (ts.isPropertyAccessExpression(node.expression)) {
			const callee = node.expression
			const namespace = ts.isIdentifier(callee.expression)
				? this.importedNamespaces.get(callee.expression.text)
				: undefined
			if (namespace !== undefined) {
				const command = `${namespace.sqfPrefix}${callee.name.text}`
				return namespace.form === "call"
					? this.emitFunctionCall(command, args)
					: this.emitCommandCall(command, args)
			}
			return this.emitMethodCall(callee, args)
		}

		if (!ts.isIdentifier(node.expression)) {
			throw new UnsupportedSyntaxError(node.expression, this.sourceFile,
				"only direct function calls are supported")
		}
		const name = node.expression.text
		const command = this.importAliases.get(name)
		if (command !== undefined) return this.emitCommandCall(command, args)
		// A user function (imported under any name, or declared in this same file) is
		// invoked via its CfgFunctions handle `JS_fnc_<globalName>`.
		const fn = this.importedFunctions.get(name)
			?? this.project.functions.get(constKey(this.sourceFile.fileName, name))
		if (fn !== undefined) {
			return this.emitFunctionCall(`JS_fnc_${fn.globalName}`, args)
		}
		throw new UnsupportedSyntaxError(
			node.expression, this.sourceFile,
			`call to "${name}" has no SQF mapping`,
		)
	}

	/** A zero-arg value method, e.g. `x.toString()` -> `(str x)`. */
	private emitMethodCall(callee: ts.PropertyAccessExpression, args: string[]): string {
		const method = callee.name.text
		const command = METHOD_MAPPINGS.get(method)
		if (command === undefined) {
			throw new UnsupportedSyntaxError(callee.name, this.sourceFile,
				`method "${method}" has no SQF mapping`)
		}
		if (args.length > 0) {
			throw new UnsupportedSyntaxError(callee.name, this.sourceFile,
				`method "${method}" with arguments is not supported`)
		}
		// Parenthesized so it stays a single operand when used as a command argument.
		return `(${command} ${this.emitExpression(callee.expression)})`
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

	/** Record the SQF command each name from an intrinsic import maps to, resolve
	 * relative imports against the project model, and reject any import we can't honor. */
	private registerImport(node: ts.ImportDeclaration): void {
		const spec = (node.moduleSpecifier as ts.StringLiteral).text
		if (spec.startsWith(".") || spec.startsWith("/")) {
			this.registerRelativeImport(node, spec)
			return
		}
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

	/** Resolve a relative import to definitions in another user file: imported
	 * functions become `JS_fnc_<name>` calls; imported consts become global vars. */
	private registerRelativeImport(node: ts.ImportDeclaration, spec: string): void {
		const bindings = node.importClause?.namedBindings
		if (bindings === undefined || !ts.isNamedImports(bindings)) return
		const targetFile = resolveRelativeImport(this.sourceFile.fileName, spec, this.project.files)
		if (targetFile === undefined) return
		for (const element of bindings.elements) {
			const localName = element.name.text
			const originalName = (element.propertyName ?? element.name).text
			const fn = this.project.functions.get(constKey(targetFile, originalName))
			if (fn !== undefined) {
				this.importedFunctions.set(localName, fn)
				continue
			}
			const c = this.project.consts.get(constKey(targetFile, originalName))
			if (c !== undefined) {
				this.importedConsts.set(localName, c)
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
