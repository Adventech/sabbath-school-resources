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
    test(`${workflow} enforces Git TLS verification`, () => {
        const source = fs.readFileSync(
            path.join(repositoryRoot, workflow),
            "utf8",
        )

        assert.doesNotMatch(
            source,
            /(?:http\.sslVerify\s+false|GIT_SSL_NO_VERIFY\s*[:=]\s*(?:1|true))/i,
        )
        assert.match(
            source,
            /git\s+config\s+--local\s+http\.sslVerify\s+true/,
        )
    })
}
