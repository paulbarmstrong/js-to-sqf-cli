import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

import { Emitter } from "../../src/classes/Emitter"
import { UnsupportedSyntaxError } from "../../src/classes/UnsupportedSyntaxError"
import { buildProjectModel } from "../../src/classes/ProjectModel"

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

	test("emits a diag.* namespace call in command form", () => {
		const sqf = emit(`import { diag } from "js-to-sqf"\ndiag.log("x")`)
		assert.equal(sqf.trim(), `diag_log "x";`)
	})

	test("resolves an aliased namespace import", () => {
		const sqf = emit(`import { bis as b } from "js-to-sqf"\nb.crewCount("x")`)
		assert.equal(sqf.trim(), `"x" call BIS_fnc_crewCount;`)
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

	test("emits a function parameter as a `params` binding and `_`-prefixed reference", () => {
		const body = emitFn(
			`import { systemChat } from "js-to-sqf"\nfunction greet(name) {\n\tsystemChat(name)\n}`,
		)
		assert.equal(body, `params ["_name"];\nsystemChat _name;`)
	})

	test("emits a single-arg user function call as `arg call JS_fnc_<name>`", () => {
		const sqf = emit(`function greet(name) {}\ngreet("bob")`)
		assert.match(sqf.trim(), /^"bob" call JS_fnc_greet_[0-9a-f]{8};$/)
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

	test("emits if/then with a binary condition", () => {
		const sqf = emit(
			`import { systemChat } from "js-to-sqf"\nif (1 > 0) {\n\tsystemChat("x")\n}`,
		)
		assert.match(sqf, /if \(1 > 0\) then \{/)
		assert.match(sqf, /systemChat "x";/)
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
