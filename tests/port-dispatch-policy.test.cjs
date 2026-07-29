const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const yaml = require("js-yaml")

const repositoryRoot = path.resolve(__dirname, "..")
const workflowPath = path.join(
    repositoryRoot,
    ".github/workflows/port-from-v2.yml",
)
const workflowSource = fs.readFileSync(workflowPath, "utf8")
const workflow = yaml.load(workflowSource, { schema: yaml.CORE_SCHEMA })
const steps = workflow?.jobs?.["port-from-v2"]?.steps ?? []
const validatorStep = steps.find((step) => step.id === "validate-port-id")
const objectStoreStep = steps.find(
    (step) => step.name === "Sync ported content from s3",
)
const validationScript = validatorStep?.run ?? ""
const rawExpression = "${{ github.event.client_payload.port_id }}"

const acceptedIdentifiers = [
    "12345",
    "port_2026-07",
    "a3f85f64-5717-4562-b3fc-2c963f66afa6",
    "A".repeat(64),
]
const rejectedIdentifiers = [
    undefined,
    "",
    "A".repeat(65),
    "Библия",
    " leading",
    "trailing ",
    "two words",
    "tab\tcharacter",
    "line\nbreak",
    "../prod",
    "/absolute/path",
    "folder/child",
    "folder\\child",
    "$(touch \"$ADV55_MARKER\")",
    "`touch \"$ADV55_MARKER\"`",
    "id;command",
    "id|command",
    "id&command",
    "id'quote",
    "id*glob",
]

function toWslPath(filePath) {
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(filePath)
    if (!match) {
        return filePath.replaceAll("\\", "/")
    }
    return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`
}

function runBash(script, environment, syntaxOnly = false) {
    if (process.platform === "win32") {
        const assignments = Object.entries(environment).map(
            ([key, value]) => `${key}=${value}`,
        )
        const args = ["-e", "env", ...assignments, "bash", "--noprofile", "--norc"]
        if (syntaxOnly) {
            args.push("-n")
        }
        args.push("-c", script)
        return spawnSync("wsl.exe", args, { encoding: "utf8" })
    }

    const args = ["--noprofile", "--norc"]
    if (syntaxOnly) {
        args.push("-n")
    }
    args.push("-c", script)
    return spawnSync("bash", args, {
        encoding: "utf8",
        env: { ...process.env, ...environment },
    })
}

function runValidator(rawPortId) {
    const temporaryDirectory = fs.mkdtempSync(
        path.join(os.tmpdir(), "adv-2026-0055-"),
    )
    const outputPath = path.join(temporaryDirectory, "github-output")
    const markerPath = path.join(temporaryDirectory, "payload-executed")
    const environment = {
        ADV55_MARKER:
            process.platform === "win32" ? toWslPath(markerPath) : markerPath,
        GITHUB_OUTPUT:
            process.platform === "win32" ? toWslPath(outputPath) : outputPath,
    }
    if (rawPortId !== undefined) {
        environment.RAW_PORT_ID = rawPortId
    }

    const result = runBash(validationScript, environment)
    const output = fs.existsSync(outputPath)
        ? fs.readFileSync(outputPath, "utf8")
        : ""
    const markerCreated = fs.existsSync(markerPath)
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })

    return { ...result, markerCreated, output }
}

test("the raw dispatch value enters one semantic validation boundary", () => {
    assert.ok(validatorStep, "missing validate-port-id step")
    assert.equal(validatorStep.shell, "bash")
    assert.equal(validatorStep.env?.RAW_PORT_ID, rawExpression)
    assert.equal(workflowSource.split(rawExpression).length - 1, 1)
    assert.match(
        validationScript,
        /\[\[\s+!\s+"\$RAW_PORT_ID"\s+=~\s+\^\[A-Za-z0-9_-\]\{1,64\}\$\s+\]\]/,
    )

    const syntax = runBash(validationScript, {}, true)
    assert.equal(syntax.status, 0, syntax.stderr)
})

test("the decoded Bash accepts intended IDs and rejects unsafe boundaries", () => {
    for (const identifier of acceptedIdentifiers) {
        const result = runValidator(identifier)
        assert.equal(result.status, 0, `${identifier}: ${result.stderr}`)
        assert.equal(result.stderr, "", identifier)
        assert.equal(result.output, `port_id=${identifier}\n`, identifier)
        assert.equal(result.markerCreated, false, identifier)
    }

    for (const identifier of rejectedIdentifiers) {
        const result = runValidator(identifier)
        const label = identifier === undefined ? "<missing>" : JSON.stringify(identifier)
        assert.notEqual(result.status, 0, label)
        assert.equal(result.output, "", label)
        assert.equal(result.markerCreated, false, label)
        assert.equal(result.stderr, "Invalid port identifier\n", label)
        if (identifier) {
            assert.equal(result.stderr.includes(identifier), false, label)
        }
    }
})

test("rejection stops the synthetic credential-bearing object-store step", () => {
    assert.ok(validatorStep, "missing validate-port-id step")
    assert.ok(objectStoreStep, "missing object-store step")
    assert.ok(steps.indexOf(validatorStep) < steps.indexOf(objectStoreStep))
    assert.equal(validatorStep["continue-on-error"], undefined)
    assert.equal(validatorStep.if, undefined)
    assert.equal(objectStoreStep["continue-on-error"], undefined)
    assert.equal(objectStoreStep.if, undefined)
    assert.equal(
        objectStoreStep.env?.PORT_ID,
        "${{ steps.validate-port-id.outputs.port_id }}",
    )
    assert.match(
        objectStoreStep.run,
        /aws\s+s3\s+cp\s+"s3:\/\/sabbath-school-media-tmp\/port\/ss-\$\{PORT_ID\}\/"/,
    )
    assert.doesNotMatch(objectStoreStep.run, /github\.event\.client_payload/)

    let credentialStepCalls = 0
    for (const identifier of rejectedIdentifiers) {
        const result = runValidator(identifier)
        if (result.status === 0) {
            credentialStepCalls += 1
        }
    }
    assert.equal(credentialStepCalls, 0)
})
