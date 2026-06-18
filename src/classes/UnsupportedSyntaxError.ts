import ts from "typescript"

/** Thrown when a piece of source syntax has no SQF representation. Carries the
 * `file:line:column` of the offending node so the CLI can point the user at it. */
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
