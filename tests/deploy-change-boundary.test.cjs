const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const repositoryRoot = path.resolve(__dirname, "..")
const workflows = [
    ["deploy-audio.yml", "deploy-audio"],
    ["deploy-pdf.yml", "deploy-pdf"],
    ["deploy-resources.yml", "deploy-resources"],
    ["deploy-video.yml", "deploy-video"],
]

for (const [filename, job] of workflows) {
    test(`${filename} has no unused changed-file execution boundary`, () => {
        const source = fs.readFileSync(
            path.join(repositoryRoot, ".github", "workflows", filename),
            "utf8",
        )

        assert.match(source, new RegExp(`^  ${job}:`, "m"))
        assert.match(source, /uses:\s*actions\/checkout@/)
        assert.doesNotMatch(source, /tj-actions\/changed-files/)
        assert.doesNotMatch(
            source,
            /(?:changed-files-write-output-files-json|all_changed_files)/,
        )
    })
}
