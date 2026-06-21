import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

import { Emitter } from "../../src/classes/Emitter"
import { UnsupportedSyntaxError } from "../../src/classes/UnsupportedSyntaxError"
import { buildCommandSyntax, buildProjectModel } from "../../src/classes/ProjectModel"

/** Parse `code` in-memory and emit SQF — the unified traversal validates as it emits.
 * A project model is built from the single file so same-file functions/consts resolve. */
function emit(code: string, fileName = "test.js"): string {
	const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true)
	return new Emitter(sourceFile, buildProjectModel([sourceFile], ".")).emitFile()
}

/** Parse `code` and emit the body of its first function declaration — the contents
 * of the `sqf/fn_<name>_<hash>.sqf` file that function would produce. */
function emitFn(code: string, fileName = "test.js"): string {
	const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true)
	const fn = sourceFile.statements.find(ts.isFunctionDeclaration)
	assert.ok(fn, "expected a function declaration")
	return new Emitter(sourceFile, buildProjectModel([sourceFile], ".")).emitFunctionBody(fn)
}

/** Emit `code` with command call shapes learned from `@sqfsyntaxtype` tags in `decls`. */
function emitWithCommands(code: string, decls: string): string {
	const declFile = ts.createSourceFile("commands.d.ts", decls, ts.ScriptTarget.Latest, true)
	const sourceFile = ts.createSourceFile("test.js", code, ts.ScriptTarget.Latest, true)
	const project = buildProjectModel([sourceFile], ".")
	for (const [command, syntax] of buildCommandSyntax([declFile])) project.commandSyntax.set(command, syntax)
	return new Emitter(sourceFile, project).emitFile()
}

describe("emitSourceFile (validate + emit in one pass)", () => {
	test("emits an intrinsic call as a unary SQF command", () => {
		const sqf = emit(`import { systemChat } from "js-to-sqf"\nsystemChat("hello world")`)
		assert.equal(sqf.trim(), `systemChat "hello world";`)
	})

	test("resolves an aliased intrinsic to its SQF command", () => {
		const sqf = emit(`import { systemChat as log } from "js-to-sqf"\nlog("hi")`)
		assert.equal(sqf.trim(), `systemChat "hi";`)
	})

	test("emits a bis.* namespace call in BIS function (call) form", () => {
		const sqf = emit(
			`import { bis } from "js-to-sqf"\nbis.crewCount("B_Heli_Light_01_F", false)`,
		)
		assert.equal(sqf.trim(), `["B_Heli_Light_01_F", false] call BIS_fnc_crewCount;`)
	})

	test("emits a single-arg bis.* call without an args array", () => {
		const sqf = emit(`import { bis } from "js-to-sqf"\nbis.crewCount("x")`)
		assert.equal(sqf.trim(), `"x" call BIS_fnc_crewCount;`)
	})

	test("emits a diag command as a plain command (no special namespace)", () => {
		const sqf = emit(`import { diag_log } from "js-to-sqf"\ndiag_log("x")`)
		assert.equal(sqf.trim(), `diag_log "x";`)
	})

	test("resolves an aliased namespace import", () => {
		const sqf = emit(`import { bis as b } from "js-to-sqf"\nb.crewCount("x")`)
		assert.equal(sqf.trim(), `"x" call BIS_fnc_crewCount;`)
	})

	test("emits a nullary command (@sqfsyntaxtype nullary) bare", () => {
		const sqf = emitWithCommands(
			`import { player } from "js-to-sqf"\nplayer()`,
			`/** @sqfsyntaxtype nullary */\nexport function player() {}`,
		)
		assert.equal(sqf.trim(), `player;`)
	})

	test("emits a binary command (@sqfsyntaxtype binary) as `left cmd right`", () => {
		const sqf = emitWithCommands(
			`import { spawn } from "js-to-sqf"\nspawn([1], 2)`,
			`/** @sqfsyntaxtype binary */\nexport function spawn(a, b) {}`,
		)
		assert.equal(sqf.trim(), `[1] spawn 2;`)
	})

	test("emits a binary command with 3+ args as `left cmd [rest...]`", () => {
		const sqf = emitWithCommands(
			`import { addAction } from "js-to-sqf"\naddAction(1, "t", 3)`,
			`/** @sqfsyntaxtype binary */\nexport function addAction(a, b, c) {}`,
		)
		assert.equal(sqf.trim(), `1 addAction ["t", 3];`)
	})

	test("emits a unary command with multiple args as an array operand", () => {
		const sqf = emitWithCommands(
			`import { addCamShake } from "js-to-sqf"\naddCamShake(1, 2, 3)`,
			`/** @sqfsyntaxtype unary */\nexport function addCamShake(p, d, f) {}`,
		)
		assert.equal(sqf.trim(), `addCamShake [1, 2, 3];`)
	})

	test("converts getGameObjectByVariableName to missionNamespace getVariable", () => {
		const sqf = emit(`import { getGameObjectByVariableName } from "js-to-sqf"\ngetGameObjectByVariableName("myCar")`)
		assert.equal(sqf.trim(), `(missionNamespace getVariable "myCar");`)
	})

	test("getGameObjectByVariableName accepts a non-literal argument", () => {
		const body = emitFn(`import { getGameObjectByVariableName } from "js-to-sqf"\nfunction f(n) { getGameObjectByVariableName(n) }`)
		assert.match(body, /\(missionNamespace getVariable _n\);/)
	})

	test("emits a namespace member referenced as a value as its SQF identifier", () => {
		const body = emitFn(`import { bis } from "js-to-sqf"\nfunction f() {\n\tconst x = bis.getParamValue\n}`)
		assert.match(body, /^private _x = BIS_fnc_getParamValue;$/m)
	})

	test("rejects a member call that is neither a namespace nor a mapped method", () => {
		assert.throws(
			() => emit(`foo.bar("x")`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /method "bar" has no SQF mapping/.test(err.message),
		)
	})

	test("emits nothing for a function declaration in top-level code and calls it via `JS_fnc_`", () => {
		const sqf = emit(
			`import { bis } from "js-to-sqf"\n` +
			`function getCrewCount() {\n\treturn bis.crewCount("B_Heli_Light_01_F", false)\n}\n` +
			`getCrewCount()`,
		)
		// The function body is written to its own file, not inlined here.
		assert.doesNotMatch(sqf, /getCrewCount = \{/)
		assert.match(sqf.trim(), /^call JS_fnc_getCrewCount_[0-9a-f]{8};$/)
	})

	test("emits a function body (its own SQF file) without a wrapper", () => {
		const body = emitFn(
			`import { bis } from "js-to-sqf"\n` +
			`function getCrewCount() {\n\treturn bis.crewCount("B_Heli_Light_01_F", false)\n}`,
		)
		assert.equal(body, `["B_Heli_Light_01_F", false] call BIS_fnc_crewCount;`)
	})

	test("binds a function parameter positionally from _this", () => {
		const body = emitFn(
			`import { systemChat } from "js-to-sqf"\nfunction greet(name) {\n\tsystemChat(name)\n}`,
		)
		assert.equal(body, `private _name = _this select 0;\nsystemChat _name;`)
	})

	test("emits a single-arg user function call with an args array", () => {
		const sqf = emit(`function greet(name) {}\ngreet("bob")`)
		assert.match(sqf.trim(), /^\["bob"\] call JS_fnc_greet_[0-9a-f]{8};$/)
	})

	test("substitutes a user function passed as a value with its JS_fnc_ handle", () => {
		const sqf = emit(`import { addAction } from "js-to-sqf"\nfunction blowUp() {}\naddAction("Boom", blowUp)`)
		assert.match(sqf.trim(), /^addAction \["Boom", JS_fnc_blowUp_[0-9a-f]{8}\];$/)
	})

	test("emits an inline arrow argument as an SQF code block", () => {
		const sqf = emit(`import { addAction, hint } from "js-to-sqf"\naddAction("Hi", () => { hint("hello") })`)
		assert.match(sqf, /addAction \["Hi", \{/)
		assert.match(sqf, /^\thint "hello";$/m)
		assert.match(sqf, /^\}\];$/m)
	})

	test("an inline code block binds its parameters positionally from _this", () => {
		const body = emitFn(`import { hint } from "js-to-sqf"\nfunction f() {\n\tconst cb = (target, caller) => { hint("x") }\n}`)
		assert.match(body, /private _cb = \{/)
		assert.match(body, /private _target = _this select 0;/)
		assert.match(body, /private _caller = _this select 1;/)
	})

	test("declares a local with `private` and `_`-prefixes later references", () => {
		const body = emitFn(`import { systemChat } from "js-to-sqf"\nfunction f() {\n\tconst msg = "hi"\n\tsystemChat(msg)\n}`)
		assert.match(body, /^private _msg = "hi";$/m)
		assert.match(body, /^systemChat _msg;$/m)
	})

	test("maps .toString() to the SQF `str` command", () => {
		const body = emitFn(`import { systemChat } from "js-to-sqf"\nfunction f() {\n\tconst n = 1\n\tsystemChat(n.toString())\n}`)
		assert.match(body, /systemChat \(str _n\);/)
	})

	test("rejects a method with no SQF mapping", () => {
		assert.throws(
			() => emit(`const s = "x"\ns.padStart(3)`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /method "padStart" has no SQF mapping/.test(err.message),
		)
	})

	test("emits an array literal as an SQF array", () => {
		const body = emitFn(`function f() {\n\tconst xs = [1, "two", true]\n}`)
		assert.match(body, /^private _xs = \[1, "two", true\];$/m)
	})

	test("emits an empty array literal", () => {
		const body = emitFn(`function f() {\n\tconst xs = []\n}`)
		assert.match(body, /^private _xs = \[\];$/m)
	})

	test("emits nested array literals", () => {
		const body = emitFn(`function f() {\n\tconst xs = [[1, 2], [3, 4]]\n}`)
		assert.match(body, /^private _xs = \[\[1, 2\], \[3, 4\]\];$/m)
	})

	test("reads an array element with `select`, parenthesized", () => {
		const body = emitFn(`function f() {\n\tconst xs = [1]\n\tconst v = xs[0] + 1\n}`)
		assert.match(body, /^private _v = \(_xs select 0\) \+ 1;$/m)
	})

	test("writes an array element with `set`", () => {
		const body = emitFn(`function f() {\n\tconst xs = [1]\n\txs[0] = 9\n}`)
		assert.match(body, /^_xs set \[0, 9\];$/m)
	})

	test("expands a compound element assignment via `set`", () => {
		const body = emitFn(`function f() {\n\tconst xs = [1]\n\txs[0] += 5\n}`)
		assert.match(body, /^_xs set \[0, \(_xs select 0\) \+ 5\];$/m)
	})

	test("emits if/then with a binary condition", () => {
		const sqf = emit(
			`import { systemChat } from "js-to-sqf"\nif (1 > 0) {\n\tsystemChat("x")\n}`,
		)
		assert.match(sqf, /if \(1 > 0\) then \{/)
		assert.match(sqf, /systemChat "x";/)
	})

	test("emits a C-style for loop as the SQF for-array form", () => {
		const body = emitFn(`function f() {\n\tfor (let i = 0; i < 3; i++) {}\n}`)
		assert.match(body, /^for \[\{private _i = 0\}, \{_i < 3\}, \{_i = _i \+ 1\}\] do \{/m)
	})

	test("emits a while loop with a desugared increment", () => {
		const body = emitFn(`function f() {\n\tlet n = 0\n\twhile (n < 5) {\n\t\tn++\n\t}\n}`)
		assert.match(body, /^while \{_n < 5\} do \{$/m)
		assert.match(body, /^\t_n = _n \+ 1;$/m)
	})

	test("maps .forEach to the SQF forEach command, binding params to _x/_forEachIndex", () => {
		const body = emitFn(
			`import { systemChat } from "js-to-sqf"\n` +
			`function f() {\n\tconst xs = [1]\n\txs.forEach((item, idx) => { systemChat(item.toString()) })\n}`,
		)
		assert.match(body, /^\tprivate _item = _x;$/m)
		assert.match(body, /^\tprivate _idx = _forEachIndex;$/m)
		assert.match(body, /\} forEach _xs;/)
	})

	test("maps .map to apply (element param named x needs no binding)", () => {
		const body = emitFn(`function f() {\n\tconst xs = [1]\n\tconst ys = xs.map((x) => x * 2)\n}`)
		assert.match(body, /private _ys = _xs apply \{/)
		assert.match(body, /^\t_x \* 2;$/m)
		assert.doesNotMatch(body, /private _x = _x;/)
	})

	test("maps .filter to select", () => {
		const body = emitFn(`function f() {\n\tconst xs = [1]\n\tconst ys = xs.filter((v) => v > 0)\n}`)
		assert.match(body, /private _ys = _xs select \{/)
		assert.match(body, /private _v = _x;/)
		assert.match(body, /_v > 0;/)
	})

	test("chains .map().filter() with a parenthesized receiver", () => {
		const body = emitFn(`function f() {\n\tconst xs = [1]\n\tconst ys = xs.map((x) => x * 2).filter((x) => x > 0)\n}`)
		assert.match(body, /private _ys = \(_xs apply \{[\s\S]*?\}\) select \{/)
	})

	test("rejects an index parameter on .map/.filter (no index available)", () => {
		assert.throws(
			() => emitFn(`function f() {\n\tconst xs = [1]\n\txs.map((x, i) => x)\n}`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /only an element parameter/.test(err.message),
		)
	})

	test("rejects mutating a variable outside of a function", () => {
		assert.throws(
			() => emit(`let x = 1\nx = 2`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError &&
				/mutating variables outside of functions is not supported/.test(err.message),
		)
	})

	test("rejects a function declared inside another function", () => {
		assert.throws(
			() => emitFn(`function outer() {\n\tfunction inner() {}\n}`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError &&
				/nested functions are not supported/.test(err.message),
		)
	})

	test("allows mutating a local variable inside a function", () => {
		const body = emitFn(`function f() {\n\tlet x = 1\n\tx = 2\n}`)
		assert.match(body, /^private _x = 1;$/m)
		assert.match(body, /^_x = 2;$/m)
	})

	test("desugars a compound assignment inside a function", () => {
		const body = emitFn(`function f() {\n\tlet x = 1\n\tx += 3\n}`)
		assert.match(body, /^_x = _x \+ 3;$/m)
	})

	test("rejects a default import from an intrinsic module", () => {
		assert.throws(
			() => emit(`import sqf from "js-to-sqf"`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /default import/.test(err.message),
		)
	})

	test("rejects a bare (npm) import", () => {
		assert.throws(
			() => emit(`import _ from "lodash"`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /lodash/.test(err.message),
		)
	})

	test("rejects a node: builtin import", () => {
		assert.throws(
			() => emit(`import { readFile } from "node:fs"`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /node:fs/.test(err.message),
		)
	})

	test("rejects a call to a non-intrinsic function", () => {
		assert.throws(
			() => emit(`hint("x")`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /no SQF mapping/.test(err.message),
		)
	})

	test("rejects an unsupported statement (class)", () => {
		assert.throws(
			() => emit(`class Foo {}`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError &&
				/unsupported statement: ClassDeclaration/.test(err.message),
		)
	})

	test("rejects an unsupported expression (regex literal)", () => {
		assert.throws(
			() => emit(`import { systemChat } from "js-to-sqf"\nsystemChat(/x/)`),
			UnsupportedSyntaxError,
		)
	})

	test("error message includes a file:line:column location", () => {
		assert.throws(
			() => emit(`\nclass Foo {}`, "thing.js"),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /thing\.js:2:1:/.test(err.message),
		)
	})
})
