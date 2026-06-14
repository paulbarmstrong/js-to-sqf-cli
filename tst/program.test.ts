import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

import { checkSupported, loadAndValidate, UnsupportedSyntaxError } from "../src/program.js"

/** Committed fixture trees live next to this test file — read, never written. */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures")

/** Parse `code` in-memory and run the per-file validator on it. */
function validate(code: string, fileName = "test.js"): void {
	const sourceFile = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true)
	checkSupported(sourceFile, "")
}

describe("checkSupported (per-file validation)", () => {
	test("accepts supported syntax", () => {
		assert.doesNotThrow(() =>
			validate(`
				const greeting = "hello"
				function add(a, b) {
					return a + b
				}
				if (add(1, 2) > 0) {
					hint(greeting)
				}
			`),
		)
	})

	test("accepts a relative import", () => {
		assert.doesNotThrow(() => validate(`import { add } from "./math.js"`))
	})

	test("accepts require() of a relative path", () => {
		assert.doesNotThrow(() => validate(`const math = require("./math.js")`))
	})

	test("rejects a bare (npm) import", () => {
		assert.throws(
			() => validate(`import _ from "lodash"`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /lodash/.test(err.message),
		)
	})

	test("rejects a node: builtin import", () => {
		assert.throws(
			() => validate(`import { readFile } from "node:fs"`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /node:fs/.test(err.message),
		)
	})

	test("rejects require() of a bare module", () => {
		assert.throws(
			() => validate(`const fs = require("fs")`),
			UnsupportedSyntaxError,
		)
	})

	test("rejects an unsupported node kind (class)", () => {
		assert.throws(
			() => validate(`class Foo {}`),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError && /ClassDeclaration/.test(err.message),
		)
	})

	test("rejects a regex literal (no SQF equivalent)", () => {
		assert.throws(() => validate(`const re = /[a-z]+/`), UnsupportedSyntaxError)
	})

	test("error message includes a file:line:column location", () => {
		assert.throws(
			() => validate(`\nclass Foo {}`, "thing.js"),
			(err: unknown) =>
				err instanceof UnsupportedSyntaxError &&
				/thing\.js:2:1:/.test(err.message),
		)
	})
})

describe("loadAndValidate (graph loading)", () => {
	test("follows relative imports into the graph", () => {
		const dir = join(FIXTURES, "valid-graph")
		const files = loadAndValidate([join(dir, "initPlayerLocal.js")], dir)
		const names = files.map((f) => f.fileName.split("/").pop()).sort()
		assert.deepEqual(names, ["initPlayerLocal.js", "math.js"])
	})

	test("rejects a graph that imports an npm package", () => {
		const dir = join(FIXTURES, "npm-import")
		assert.throws(
			() => loadAndValidate([join(dir, "initPlayerLocal.js")], dir),
			UnsupportedSyntaxError,
		)
	})
})
