const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { pathToFileURL } = require("node:url")

const repositoryRoot = path.resolve(__dirname, "..")
const validatorPath = path.join(
    repositoryRoot,
    "ops",
    "validate",
    "validate-resources.js",
)
const runnerPath = path.join(
    repositoryRoot,
    "ops",
    "validate",
    "validation-runner.js",
)

test("the validation command is read-only", () => {
    const source = fs.readFileSync(validatorPath, "utf8")

    assert.doesNotMatch(source, /\bfixDates\s*\(/)
    assert.doesNotMatch(
        source,
        /\b(?:outputFile|outputFileSync|writeFile|writeFileSync)\s*\(/,
    )
})

test("the CLI awaits validation and fails the process when validation fails", () => {
    const source = fs.readFileSync(validatorPath, "utf8")

    assert.match(
        source,
        /await\s+runValidation\s*\(\s*arg\s*,\s*validateResources\s*\)/,
    )
    assert.match(source, /process\.exitCode\s*=\s*1/)
})

test("the runner awaits every selected resource group in order", async () => {
    const { runValidation } = await import(pathToFileURL(runnerPath).href)
    const calls = []
    const selection = {
        en: {
            ss: { resources: "2026-03" },
            devo: { resources: "daily" },
        },
        de: {
            ss: { resources: "(2026-02|2026-03)" },
        },
    }

    await runValidation(selection, async (language, type, resources) => {
        await Promise.resolve()
        calls.push([language, type, resources])
    })

    assert.deepEqual(calls, [
        ["en", "ss", "2026-03"],
        ["en", "devo", "daily"],
        ["de", "ss", "(2026-02|2026-03)"],
    ])
})

test("the runner propagates validator failures", async () => {
    const { runValidation } = await import(pathToFileURL(runnerPath).href)

    await assert.rejects(
        runValidation(
            { en: { ss: { resources: "2026-03" } } },
            async () => {
                throw new Error("synthetic validation failure")
            },
        ),
        /synthetic validation failure/,
    )
})
