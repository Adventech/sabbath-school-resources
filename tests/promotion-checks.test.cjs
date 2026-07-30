const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const { pathToFileURL } = require("node:url")

const repositoryRoot = path.resolve(__dirname, "..")
const modulePath = path.join(
    repositoryRoot,
    "ops",
    "ci",
    "promotion-checks.js",
)
const workflowPath = path.join(
    repositoryRoot,
    ".github",
    "workflows",
    "sync-stage-into-prod.yml",
)

async function promotionModule() {
    return import(pathToFileURL(modulePath).href)
}

function checkRun(overrides = {}) {
    return {
        id: 1,
        name: "validation",
        status: "completed",
        conclusion: "success",
        details_url: "https://github.com/Adventech/example/actions/runs/10/job/1",
        app: { id: 1 },
        ...overrides,
    }
}

function response(body, link = null, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: {
            get(name) {
                return name.toLowerCase() === "link" ? link : null
            },
        },
        async json() {
            return body
        },
    }
}

test("promotion fails closed when no independent signals exist", async () => {
    const { evaluatePromotionSignals } = await promotionModule()

    assert.equal(
        evaluatePromotionSignals({
            checkRuns: [],
            statuses: [],
            currentRunId: "123",
        }).allowed,
        false,
    )
})

test("completed checks and latest successful statuses allow promotion", async () => {
    const { evaluatePromotionSignals } = await promotionModule()

    const result = evaluatePromotionSignals({
        checkRuns: [checkRun()],
        statuses: [
            { id: 3, context: "legacy-ci", state: "success" },
            { id: 2, context: "legacy-ci", state: "failure" },
        ],
        currentRunId: "123",
    })

    assert.equal(result.allowed, true)
    assert.equal(result.signalCount, 2)
})

test("current workflow checks are excluded by run identity", async () => {
    const { evaluatePromotionSignals } = await promotionModule()

    const result = evaluatePromotionSignals({
        checkRuns: [
            checkRun({
                conclusion: "failure",
                details_url:
                    "https://github.com/Adventech/example/actions/runs/123/job/9",
            }),
        ],
        statuses: [],
        currentRunId: "123",
    })

    assert.equal(result.allowed, false)
    assert.equal(result.signalCount, 0)
})

test("pending or failed independent signals block promotion", async () => {
    const { evaluatePromotionSignals } = await promotionModule()

    const pending = evaluatePromotionSignals({
        checkRuns: [checkRun({ status: "in_progress", conclusion: null })],
        statuses: [],
        currentRunId: "123",
    })
    const failedStatus = evaluatePromotionSignals({
        checkRuns: [checkRun()],
        statuses: [{ id: 4, context: "legacy-ci", state: "failure" }],
        currentRunId: "123",
    })

    assert.equal(pending.allowed, false)
    assert.equal(failedStatus.allowed, false)
})

test("check reruns are reduced to the latest result per app and name", async () => {
    const { evaluatePromotionSignals } = await promotionModule()

    const result = evaluatePromotionSignals({
        checkRuns: [
            checkRun({ id: 20, conclusion: "success" }),
            checkRun({ id: 10, conclusion: "failure" }),
        ],
        statuses: [],
        currentRunId: "123",
    })

    assert.equal(result.allowed, true)
    assert.equal(result.signalCount, 1)
})

test("GitHub collections are fetched through every safe next page", async () => {
    const { fetchGitHubCollection } = await promotionModule()
    const first =
        "https://api.github.com/repos/Adventech/example/commits/abc/check-runs"
    const second =
        "https://api.github.com/repositories/1/commits/abc/check-runs?page=2"
    const calls = []
    const fetchImpl = async url => {
        calls.push(url)
        if (url === first) {
            return response(
                { check_runs: [checkRun({ id: 1 })] },
                `<${second}>; rel="next"`,
            )
        }
        return response({ check_runs: [checkRun({ id: 2 })] })
    }

    const checks = await fetchGitHubCollection(
        fetchImpl,
        first,
        {},
        "check_runs",
    )

    assert.deepEqual(calls, [first, second])
    assert.deepEqual(checks.map(check => check.id), [1, 2])
})

test("GitHub collection failures and unsafe pagination fail closed", async () => {
    const { fetchGitHubCollection } = await promotionModule()
    const url =
        "https://api.github.com/repos/Adventech/example/commits/abc/statuses"

    await assert.rejects(
        fetchGitHubCollection(
            async () => response([], null, 403),
            url,
            {},
            null,
        ),
        /GitHub API request failed with status 403/,
    )
    await assert.rejects(
        fetchGitHubCollection(
            async () => response(
                [],
                '<https://example.invalid/next>; rel="next"',
            ),
            url,
            {},
            null,
        ),
        /unsafe pagination URL/,
    )
})

test("promotion workflow verifies and merges the same immutable revision", () => {
    const source = fs.readFileSync(workflowPath, "utf8")
    const verificationPosition = source.indexOf(
        "name: Verify immutable stage revision",
    )
    const mergePosition = source.indexOf("name: Merge stage revision")
    const verificationBlock = source.slice(
        verificationPosition,
        mergePosition,
    )

    assert.doesNotMatch(source, /danieldeichfuss\/get-status/)
    assert.match(
        source,
        /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020/,
    )
    assert.match(source, /node-version:\s*['"]24\.18\.0['"]/)
    assert.match(
        verificationBlock,
        /node ops\/ci\/promotion-checks\.js/,
    )
    assert.doesNotMatch(verificationBlock, /PERSONAL_GH_TOKEN/)
    assert.match(source, /ref:\s*\${{\s*github\.sha\s*}}/)
    assert.match(source, /head_to_merge:\s*\${{\s*github\.sha\s*}}/)
    assert.doesNotMatch(source, /from_branch:\s*stage/)
    assert.ok(
        verificationPosition >= 0 && verificationPosition < mergePosition,
        "verification must complete before the merge step",
    )
})
