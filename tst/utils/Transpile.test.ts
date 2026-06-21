import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"

import { transpile as transpileMission, transpileProject } from "../../src/utils/Transpile"

/** Write a set of source files into a fresh temp project and transpile it,
 * returning the outputs keyed by project-relative path. */
async function transpile(sources: Record<string, string>): Promise<Map<string, string>> {
	const projectDir = await mkdtemp(join(tmpdir(), "js-to-sqf-"))
	try {
		for (const [rel, content] of Object.entries(sources)) {
			const abs = join(projectDir, rel)
			await mkdir(dirname(abs), { recursive: true })
			await writeFile(abs, content)
		}
		const outputs = transpileProject(join(projectDir, "src/index.ts"), projectDir)
		const byRelPath = new Map<string, string>()
		for (const file of outputs) {
			byRelPath.set(file.outPath.slice(projectDir.length + 1), file.sqf)
		}
		return byRelPath
	} finally {
		await rm(projectDir, { recursive: true, force: true })
	}
}

const INDEX = `import { defineMission, systemChat, bis } from "js-to-sqf"
import { TABLE } from "./config"

const SPEED = 5

function getCrew(): number {
	return bis.crewCount("B_Heli_Light_01_F", false)
}

export default defineMission({
	init: () => { getCrew() },
	initServer: () => { systemChat(SPEED.toString()) },
	initPlayerLocal: (player, didJIP) => { systemChat(TABLE.toString()) },
})
`
const CONFIG = `export const TABLE = [[1, 2], [3, 4]]\n`

test("produces the expected set of output files", async () => {
	const out = await transpile({ "src/index.ts": INDEX, "src/config.ts": CONFIG })
	const keys = [...out.keys()].sort()
	assert.deepEqual(
		keys.filter((k) => !k.startsWith("sqf/fn_")),
		["CfgFunctions.hpp", "init.sqf", "initPlayerLocal.sqf", "initServer.sqf", "sqf/constants.sqf"],
	)
	// The function file carries the BI `fn_` prefix and the uniqueness hash.
	assert.ok(keys.some((k) => /^sqf\/fn_getCrew_[0-9a-f]{8}\.sqf$/.test(k)))
})

test("collects all module consts (incl. cross-file) into sqf/constants.sqf", async () => {
	const out = await transpile({ "src/index.ts": INDEX, "src/config.ts": CONFIG })
	const constants = out.get("sqf/constants.sqf")!
	assert.match(constants, /^SPEED_[0-9a-f]{8} = 5;$/m)
	assert.match(constants, /^TABLE_[0-9a-f]{8} = \[\[1, 2\], \[3, 4\]\];$/m)
})

test("each init script loads constants and resolves consts to their globals", async () => {
	const out = await transpile({ "src/index.ts": INDEX, "src/config.ts": CONFIG })

	const initServer = out.get("initServer.sqf")!
	assert.match(initServer, /^call compile preprocessFileLineNumbers "sqf\\constants\.sqf";$/m)
	assert.match(initServer, /^systemChat \(str SPEED_[0-9a-f]{8}\);$/m)

	const playerLocal = out.get("initPlayerLocal.sqf")!
	assert.match(playerLocal, /^private _player = _this select 0;$/m)
	assert.match(playerLocal, /^private _didJIP = _this select 1;$/m)
	assert.match(playerLocal, /^systemChat \(str TABLE_[0-9a-f]{8}\);$/m)

	const init = out.get("init.sqf")!
	assert.match(init, /^call JS_fnc_getCrew_[0-9a-f]{8};$/m)
})

test("functions go to flat sqf/ files (body only) and are registered in CfgFunctions.hpp", async () => {
	const out = await transpile({ "src/index.ts": INDEX, "src/config.ts": CONFIG })
	const fnKey = [...out.keys()].find((k) => /^sqf\/fn_getCrew_[0-9a-f]{8}\.sqf$/.test(k))!
	assert.equal(out.get(fnKey)!.trim(),
		`["B_Heli_Light_01_F", false] call BIS_fnc_crewCount;`)
	assert.match(out.get("CfgFunctions.hpp")!,
		/class getCrew_[0-9a-f]{8} \{ file = "sqf"; \};/)
})

test("output is deterministic across re-runs (no churn under --watch)", async () => {
	const first = await transpile({ "src/index.ts": INDEX, "src/config.ts": CONFIG })
	const second = await transpile({ "src/index.ts": INDEX, "src/config.ts": CONFIG })
	for (const [path, content] of first) {
		assert.equal(second.get(path), content, `output for ${path} changed between runs`)
	}
})

const INDEX_WITH_FN = `import { defineMission, systemChat } from "js-to-sqf"
function greet() { systemChat("hi") }
export default defineMission({ init: () => { greet() } })
`

/** Run the full (file-writing) transpile over a temp project; returns its dir. */
async function transpileToDir(sources: Record<string, string>): Promise<string> {
	const projectDir = await mkdtemp(join(tmpdir(), "js-to-sqf-"))
	for (const [rel, content] of Object.entries(sources)) {
		const abs = join(projectDir, rel)
		await mkdir(dirname(abs), { recursive: true })
		await writeFile(abs, content)
	}
	await transpileMission(projectDir)
	return projectDir
}

test("creates description.ext with the CfgFunctions include when absent", async () => {
	const dir = await transpileToDir({ "src/index.ts": INDEX_WITH_FN })
	try {
		assert.equal(await readFile(join(dir, "description.ext"), "utf8"), `#include "CfgFunctions.hpp"\n`)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test("appends the include to an existing description.ext, preserving content", async () => {
	const dir = await transpileToDir({
		"src/index.ts": INDEX_WITH_FN,
		"description.ext": `disabledAI = 0;\n`,
	})
	try {
		const content = await readFile(join(dir, "description.ext"), "utf8")
		assert.match(content, /^disabledAI = 0;$/m)
		assert.match(content, /^#include "CfgFunctions\.hpp"$/m)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test("does not duplicate the include if already present", async () => {
	const dir = await transpileToDir({
		"src/index.ts": INDEX_WITH_FN,
		"description.ext": `#include "CfgFunctions.hpp"\ndisabledAI = 0;\n`,
	})
	try {
		const content = await readFile(join(dir, "description.ext"), "utf8")
		assert.equal(content.match(/#include "CfgFunctions\.hpp"/g)?.length, 1)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

test("allows same-named functions in different files (no collision)", async () => {
	const out = await transpile({
		"src/index.ts":
			`import { defineMission } from "js-to-sqf"\n` +
			`import { helper as a } from "./a"\n` +
			`import { helper as b } from "./b"\n` +
			`export default defineMission({ init: () => { a(); b() } })\n`,
		"src/a.ts": `export function helper(): number { return 1 }\n`,
		"src/b.ts": `export function helper(): number { return 2 }\n`,
	})
	// Two distinct function files, one per same-named function.
	const fnFiles = [...out.keys()].filter((k) => /^sqf\/fn_helper_[0-9a-f]{8}\.sqf$/.test(k))
	assert.equal(fnFiles.length, 2)
	// init calls two distinct globals.
	const calls = new Set(out.get("init.sqf")!.match(/JS_fnc_helper_[0-9a-f]{8}/g) ?? [])
	assert.equal(calls.size, 2)
})

test("allows a module-level const with a computed (non-literal) initializer", async () => {
	const out = await transpile({
		"src/index.ts":
			`import { defineMission } from "js-to-sqf"\n` +
			`function compute(): number { return 1 }\n` +
			`const VALUE = compute()\n` +
			`export default defineMission({ init: () => {} })\n`,
	})
	assert.match(out.get("sqf/constants.sqf")!, /^VALUE_[0-9a-f]{8} = call JS_fnc_compute_[0-9a-f]{8};$/m)
})
