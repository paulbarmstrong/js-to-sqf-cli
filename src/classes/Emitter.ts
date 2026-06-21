import ts from "typescript"
import { ASSIGNMENT_OPERATOR_MAPPINGS, BINARY_OPERATOR_MAPPINGS, ITERATION_METHOD_MAPPINGS, IterationMapping, METHOD_MAPPINGS, NAMESPACE_MAPPINGS, NamespaceMapping, PREFIX_OPERATOR_MAPPINGS, TYPES_PACKAGE_NAME } from "../utils/Constants.js"
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
		// Bind parameters positionally from `_this` (`_this select i`) rather than via
		// `params [...]`, so binding is purely by order and independent of names.
		const parts: string[] = paramNames.map((name, index) => `private _${name} = _this select ${index};`)
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

			case ts.SyntaxKind.ForStatement:
				return this.emitFor(node as ts.ForStatement)

			case ts.SyntaxKind.WhileStatement:
				return this.emitWhile(node as ts.WhileStatement)

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

	/** A C-style `for` maps to SQF's array form: `for [{init}, {cond}, {inc}] do {body}`.
	 * The loop variable is scoped to the loop. */
	private emitFor(node: ts.ForStatement): string {
		const outerLocals = this.locals
		this.locals = new Set(outerLocals)
		const init = this.emitForInitializer(node.initializer)
		const condition = node.condition !== undefined ? this.emitExpression(node.condition) : ""
		const incrementor = node.incrementor !== undefined ? this.emitExpression(node.incrementor) : ""
		const body = this.indent(this.emitStatement(node.statement))
		this.locals = outerLocals
		return `for [{${init}}, {${condition}}, {${incrementor}}] do {\n${body}\n};`
	}

	/** The `for` init clause: a `let`/`const` declaration list, an expression, or nothing. */
	private emitForInitializer(node: ts.ForInitializer | undefined): string {
		if (node === undefined) return ""
		if (ts.isVariableDeclarationList(node)) {
			return node.declarations.map((declaration) => {
				if (!ts.isIdentifier(declaration.name)) {
					throw new UnsupportedSyntaxError(declaration.name, this.sourceFile,
						"destructuring declarations are not supported")
				}
				const name = declaration.name.text
				const init = declaration.initializer !== undefined
					? ` = ${this.emitExpression(declaration.initializer)}`
					: ""
				this.locals.add(name)
				return `private _${name}${init}`
			}).join("; ")
		}
		return this.emitExpression(node)
	}

	private emitWhile(node: ts.WhileStatement): string {
		const condition = this.emitExpression(node.expression)
		const body = this.indent(this.emitStatement(node.statement))
		return `while {${condition}} do {\n${body}\n};`
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

			case ts.SyntaxKind.ElementAccessExpression:
				return this.emitElementAccess(node as ts.ElementAccessExpression)

			case ts.SyntaxKind.ArrowFunction:
			case ts.SyntaxKind.FunctionExpression:
				return this.emitInlineCodeBlock(node as ts.ArrowFunction | ts.FunctionExpression)

			case ts.SyntaxKind.PrefixUnaryExpression:
				return this.emitPrefixUnary(node as ts.PrefixUnaryExpression)

			case ts.SyntaxKind.PostfixUnaryExpression:
				return this.emitPostfixUnary(node as ts.PostfixUnaryExpression)

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
		// Element writes use the SQF `set` command, not `=`.
		if (ts.isElementAccessExpression(node.left)) {
			return this.emitElementAssignment(node.left, node)
		}
		const compound = ASSIGNMENT_OPERATOR_MAPPINGS.get(node.operatorToken.kind)!
		const left = this.emitExpression(node.left)
		const right = this.emitExpression(node.right)
		return compound === null ? `${left} = ${right}` : `${left} = ${left} ${compound} ${right}`
	}

	/** Array element write `arr[i] = x` -> `arr set [i, x]`. A compound assignment
	 * (`arr[i] += x`) expands to `arr set [i, (arr select i) + x]`. */
	private emitElementAssignment(target: ts.ElementAccessExpression, node: ts.BinaryExpression): string {
		const array = this.emitExpression(target.expression)
		const index = this.emitExpression(target.argumentExpression)
		const compound = ASSIGNMENT_OPERATOR_MAPPINGS.get(node.operatorToken.kind)!
		const right = this.emitExpression(node.right)
		const value = compound === null ? right : `(${array} select ${index}) ${compound} ${right}`
		return `${array} set [${index}, ${value}]`
	}

	/** A JS array literal maps directly to an SQF array: `[a, b, c]` (empty -> `[]`). */
	private emitArrayLiteral(node: ts.ArrayLiteralExpression): string {
		return `[${node.elements.map((element) => this.emitExpression(element)).join(", ")}]`
	}

	/** Array element read `arr[i]` -> `(arr select i)`. Parenthesized because the binary
	 * `select` command binds looser than arithmetic, so it must stay a single operand. */
	private emitElementAccess(node: ts.ElementAccessExpression): string {
		return `(${this.emitExpression(node.expression)} select ${this.emitExpression(node.argumentExpression)})`
	}

	/** An inline arrow/function passed as a value (e.g. an `addAction` script) becomes an
	 * SQF code block `{ ... }`. Any parameters bind from `_this` via `params [...]`. */
	private emitInlineCodeBlock(node: ts.ArrowFunction | ts.FunctionExpression): string {
		return `{\n${this.indent(this.emitFunctionBody(node))}\n}`
	}

	/** SQF string literals are double-quoted; an embedded `"` is escaped by doubling it. */
	private emitString(value: string): string {
		return `"${value.replace(/"/g, '""')}"`
	}

	private emitPrefixUnary(node: ts.PrefixUnaryExpression): string {
		if (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) {
			return this.emitIncrementDecrement(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken)
		}
		const operator = PREFIX_OPERATOR_MAPPINGS.get(node.operator)
		if (operator === undefined) {
			throw new UnsupportedSyntaxError(node, this.sourceFile,
				`unsupported unary operator: ${ts.SyntaxKind[node.operator]}`)
		}
		return `${operator}${this.emitExpression(node.operand)}`
	}

	private emitPostfixUnary(node: ts.PostfixUnaryExpression): string {
		// SQF has no `++`/`--`; both pre- and post-forms desugar to `x = x +/- 1`.
		return this.emitIncrementDecrement(node.operand, node.operator === ts.SyntaxKind.PlusPlusToken)
	}

	/** `x++`/`++x`/`x--`/`--x` -> `x = x + 1` / `x = x - 1`. A mutation, so only valid
	 * inside a function body. The pre/post value distinction is not preserved. */
	private emitIncrementDecrement(operand: ts.Expression, isIncrement: boolean): string {
		if (!this.inFunctionBody) {
			throw new UnsupportedSyntaxError(operand, this.sourceFile,
				"mutating variables outside of functions is not supported")
		}
		const target = this.emitExpression(operand)
		return `${target} = ${target} ${isIncrement ? "+" : "-"} 1`
	}

	private emitIdentifier(node: ts.Identifier): string {
		const name = node.text
		// SQF locals must be `_`-prefixed.
		if (this.locals.has(name)) return `_${name}`
		// A user function referenced as a value (e.g. passed to `addAction`) resolves to
		// its CfgFunctions handle `JS_fnc_<globalName>`.
		const fn = this.importedFunctions.get(name)
			?? this.project.functions.get(constKey(this.sourceFile.fileName, name))
		if (fn !== undefined) return `JS_fnc_${fn.globalName}`
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
		// Property-access callee: a namespace member (`bis.crewCount(...)`), an array
		// iteration (`arr.forEach(...)`), or a value method (`x.toString()`).
		if (ts.isPropertyAccessExpression(node.expression)) {
			const callee = node.expression
			const namespace = ts.isIdentifier(callee.expression)
				? this.importedNamespaces.get(callee.expression.text)
				: undefined
			if (namespace !== undefined) {
				const args = node.arguments.map((arg) => this.emitExpression(arg))
				const command = `${namespace.sqfPrefix}${callee.name.text}`
				return namespace.form === "call"
					? this.emitFunctionCall(command, args)
					: this.emitCommandCall(command, args)
			}
			const iteration = ITERATION_METHOD_MAPPINGS.get(callee.name.text)
			if (iteration !== undefined) {
				return this.emitIteration(callee, iteration, node.arguments)
			}
			return this.emitMethodCall(callee, node.arguments.map((arg) => this.emitExpression(arg)))
		}

		const args = node.arguments.map((arg) => this.emitExpression(arg))
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
			// User functions read params positionally from `_this`, so always pass an
			// array (even a single arg) to keep `_this select i` valid.
			return this.emitFunctionCall(`JS_fnc_${fn.globalName}`, args, true)
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

	/** Array iteration (`forEach`/`map`/`filter`) -> the SQF command that runs a code
	 * block over each element (`forEach`/`apply`/`select`). The callback's element/index
	 * params are bound to SQF's `_x`/`_forEachIndex`. */
	private emitIteration(
		callee: ts.PropertyAccessExpression,
		mapping: IterationMapping,
		args: ts.NodeArray<ts.Expression>,
	): string {
		const method = callee.name.text
		if (args.length !== 1) {
			throw new UnsupportedSyntaxError(callee.name, this.sourceFile,
				`"${method}" requires a single inline callback`)
		}
		const callback = args[0]!
		if (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback)) {
			throw new UnsupportedSyntaxError(callback, this.sourceFile,
				`"${method}" requires an inline function callback`)
		}
		const code = `{\n${this.indent(this.emitIterationBlock(callback, mapping.allowIndex, method))}\n}`
		const receiver = this.emitIterationReceiver(callee.expression)
		return mapping.codeFirst
			? `${code} ${mapping.command} ${receiver}`
			: `${receiver} ${mapping.command} ${code}`
	}

	/** Emit an iteration callback's body, binding its element/index params to SQF's
	 * `_x` and `_forEachIndex`. */
	private emitIterationBlock(
		callback: ts.ArrowFunction | ts.FunctionExpression,
		allowIndex: boolean,
		method: string,
	): string {
		const params = callback.parameters
		const maxParams = allowIndex ? 2 : 1
		if (params.length > maxParams) {
			throw new UnsupportedSyntaxError(callback, this.sourceFile, allowIndex
				? `"${method}" callback supports at most (element, index) parameters`
				: `"${method}" callback supports only an element parameter (no index is available)`)
		}

		const outerLocals = this.locals
		const outerInFunctionBody = this.inFunctionBody
		this.locals = new Set(outerLocals)
		this.inFunctionBody = true

		const bindings: string[] = []
		const bind = (param: ts.ParameterDeclaration, sqfVar: string) => {
			if (!ts.isIdentifier(param.name)) {
				throw new UnsupportedSyntaxError(param, this.sourceFile,
					"destructured parameters are not supported")
			}
			const name = param.name.text
			this.locals.add(name)
			// The element magic var is already `_x`, so a param literally named `x` needs no binding.
			if (`_${name}` !== sqfVar) bindings.push(`private _${name} = ${sqfVar};`)
		}
		if (params.length >= 1) bind(params[0]!, "_x")
		if (params.length >= 2) bind(params[1]!, "_forEachIndex")

		const body = ts.isBlock(callback.body)
			? this.emitBlock(callback.body)
			: `${this.emitExpression(callback.body)};`

		this.locals = outerLocals
		this.inFunctionBody = outerInFunctionBody
		return [...bindings, body].filter((line) => line.length > 0).join("\n")
	}

	/** Parenthesize a compound iteration receiver so chained iteration commands
	 * (`arr.map(...).filter(...)`) and binary expressions associate correctly. */
	private emitIterationReceiver(expr: ts.Expression): string {
		const out = this.emitExpression(expr)
		return ts.isCallExpression(expr) || ts.isBinaryExpression(expr) ? `(${out})` : out
	}

	/** Emit a command call in the shape declared by its `@sqfsyntaxtype`:
	 * - nullary: `cmd`
	 * - binary: `left cmd right` (right = the 2nd arg, or `[arg2, ...]` for 3+ args)
	 * - unary (and the fallback when the type is unknown): `cmd arg`, `cmd [a, b]`, or `cmd`.
	 */
	private emitCommandCall(command: string, args: string[]): string {
		const syntax = this.project.commandSyntax.get(command)
		if (syntax === "nullary") return command
		if (syntax === "binary" && args.length >= 2) {
			const rest = args.slice(1)
			const right = rest.length === 1 ? rest[0] : `[${rest.join(", ")}]`
			return `${args[0]} ${command} ${right}`
		}
		if (args.length === 0) return command
		if (args.length === 1) return `${command} ${args[0]}`
		return `${command} [${args.join(", ")}]`
	}

	/** `call`-operator form: `call FN`, `arg call FN`, or `[a, b] call FN`. With
	 * `alwaysArray`, a single argument is still wrapped (`[arg] call FN`) so the callee
	 * can read `_this select 0` — used for user functions; BIS functions keep the
	 * scalar single-arg form. */
	private emitFunctionCall(command: string, args: string[], alwaysArray = false): string {
		if (args.length === 0) return `call ${command}`
		if (args.length === 1 && !alwaysArray) return `${args[0]} call ${command}`
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
