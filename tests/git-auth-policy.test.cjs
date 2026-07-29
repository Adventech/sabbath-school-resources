const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const repositoryRoot = path.resolve(__dirname, "..")
const workflows = [
    ".github/workflows/deploy-assets.yml",
    ".github/workflows/port-from-v2.yml",
]

for (const workflow of workflows) {
    test(`${workflow} keeps write credentials ephemeral`, () => {
        const source = fs.readFileSync(
            path.join(repositoryRoot, workflow),
            "utf8",
        )

        assert.match(
            source,
            /uses:\s*actions\/checkout@[\s\S]{0,220}persist-credentials:\s*false/,
        )
        assert.doesNotMatch(
            source,
            /remote_repo=.*(?:INPUT_GITHUB_TOKEN|PERSONAL_GH_TOKEN|GITHUB_ACTOR)/,
        )
        assert.match(
            source,
            /remote_repo="https:\/\/github\.com\/\$\{GITHUB_REPOSITORY\}\.git"/,
        )
        assert.match(source, /trap\s+cleanup_git_credentials\s+EXIT/)
        assert.match(
            source,
            /git\s+config\s+--local\s+credential\.helper\s+"\$git_credential_helper"/,
        )
        assert.match(
            source,
            /git\s+config\s+--local\s+--unset-all\s+credential\.helper/,
        )
        assert.match(source, /rm\s+-f\s+"\$git_credential_helper"/)
    })
}
