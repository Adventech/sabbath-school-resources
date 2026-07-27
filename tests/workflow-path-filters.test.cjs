const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const workflowPath = path.resolve(
    __dirname,
    "..",
    ".github",
    "workflows",
    "deploy-assets.yml",
)

const source = fs.readFileSync(workflowPath, "utf8")
const triggerBlock = source.slice(0, source.indexOf("\njobs:"))

for (const changedWorkflow of [
    ".github/workflows/deploy-assets.yml",
    ".github/workflows/deploy-resources.yml",
]) {
    test(`${changedWorkflow} changes trigger the asset workflow`, () => {
        assert.match(
            triggerBlock,
            new RegExp(`['"]${changedWorkflow.replaceAll(".", "\\.")}['"]`),
        )
    })
}

test("workflow path filters do not use forbidden relative segments", () => {
    assert.doesNotMatch(triggerBlock, /['"]\.{1,2}\//)
})
