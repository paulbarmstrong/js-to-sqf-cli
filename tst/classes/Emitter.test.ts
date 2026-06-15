import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

import { Emitter, UnsupportedSyntaxError } from "../../src/classes/Emitter"

/** Parse `code` in-memory and emit SQF — the unified traversal validates as it emits. */
function emit(code: string, fileName = "test.js"): string {
	const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true)
	return new Emitter(sourceFile).emitFile()
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

	test("emits a user function as a global SQF code block called via `call`", () => {
		const sqf = emit(
			`import { bis } from "js-to-sqf"\n` +
			`function getCrewCount() {\n\treturn bis.crewCount("B_Heli_Light_01_F", false)\n}\n` +
			`getCrewCount()`,
		)
		assert.match(sqf, /getCrewCount = \{\n\t\["B_Heli_Light_01_F", false\] call BIS_fnc_crewCount;\n\};/)
		assert.match(sqf, /^call getCrewCount;$/m)
	})

	test("emits a function parameter as a `params` binding and `_`-prefixed reference", () => {
		const sqf = emit(
			`import { systemChat } from "js-to-sqf"\nfunction greet(name) {\n\tsystemChat(name)\n}`,
		)
		assert.match(sqf, /greet = \{\n\tparams \["_name"\];\n\tsystemChat _name;\n\};/)
	})

	test("declares a local with `private` and `_`-prefixes later references", () => {
		const sqf = emit(`import { systemChat } from "js-to-sqf"\nconst msg = "hi"\nsystemChat(msg)`)
		assert.match(sqf, /^private _msg = "hi";$/m)
		assert.match(sqf, /^systemChat _msg;$/m)
	})

	test("maps .toString() to the SQF `str` command", () => {
		const sqf = emit(`import { systemChat } from "js-to-sqf"\nconst n = 1\nsystemChat(n.toString())`)
		assert.match(sqf, /systemChat \(str _n\);/)
	})

	test("rejects a method with no SQF mapping", () => {
		assert.throws(
			() => emit(`const s = "x"\ns.padStart(3)`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /method "padStart" has no SQF mapping/.test(err.message),
		)
	})

	test("emits if/then with a binary condition", () => {
		const sqf = emit(
			`import { systemChat } from "js-to-sqf"\nif (1 > 0) {\n\tsystemChat("x")\n}`,
		)
		assert.match(sqf, /if \(1 > 0\) then \{/)
		assert.match(sqf, /systemChat "x";/)
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
