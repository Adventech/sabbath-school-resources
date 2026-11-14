import http from "http"
import https from "https"
import fs from "fs-extra"

// Hidden marker used to find (and update) the validator's previous comment
// instead of adding a new one on every push.
export const COMMENT_MARKER = "<!-- sspm-resource-validator -->"
const MAX_COMMENT_LENGTH = 60000

export const isGitHubActions = function () {
    return process.env.GITHUB_ACTIONS === "true"
}

let getPullRequestNumber = function () {
    try {
        if (process.env.GITHUB_EVENT_PATH && fs.pathExistsSync(process.env.GITHUB_EVENT_PATH)) {
            const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf-8"))
            return event.pull_request?.number ?? (event.issue?.pull_request ? event.issue.number : null)
        }
    } catch (e) {
        console.error(`Could not read the GitHub event payload: ${e}`)
    }
    return null
}

let request = function (method, path, body) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    const api = new URL(process.env.GITHUB_API_URL || "https://api.github.com")
    const payload = body ? JSON.stringify(body) : null

    return new Promise((resolve, reject) => {
        const client = api.protocol === "http:" ? http : https
        const req = client.request({
            hostname: api.hostname,
            port: api.port || (api.protocol === "http:" ? 80 : 443),
            path: `${api.pathname.replace(/\/$/, "")}${path}`,
            method,
            headers: {
                "Accept": "application/vnd.github+json",
                "Authorization": `Bearer ${token}`,
                "User-Agent": "sspm-resource-validator",
                "X-GitHub-Api-Version": "2022-11-28",
                ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
            },
        }, (res) => {
            const chunks = []
            res.on("data", (c) => chunks.push(c))
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf-8")
                if (res.statusCode >= 300) {
                    reject(new Error(`GitHub API ${method} ${path} failed with ${res.statusCode}: ${text.slice(0, 300)}`))
                    return
                }
                try { resolve(text ? JSON.parse(text) : null) } catch (e) { resolve(text) }
            })
        })
        req.on("error", reject)
        if (payload) req.write(payload)
        req.end()
    })
}

let findExistingComment = async function (repo, prNumber) {
    for (let page = 1; page <= 10; page++) {
        const comments = await request("GET", `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`)
        if (!Array.isArray(comments) || !comments.length) return null
        const found = comments.find(c => c.body && c.body.includes(COMMENT_MARKER))
        if (found) return found
        if (comments.length < 100) return null
    }
    return null
}

/**
 * Creates or updates the validator comment on the current pull request.
 * When there are no issues, an existing comment is updated to a success message
 * and no new comment is created.
 * @returns {Promise<boolean>} true if the comment was posted
 */
export const postPullRequestComment = async function (body, hasIssues) {
    const repo = process.env.GITHUB_REPOSITORY
    const prNumber = getPullRequestNumber()

    if (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN) {
        console.warn("GITHUB_TOKEN is not set, skipping the pull request comment")
        return false
    }

    if (!repo || !prNumber) {
        console.warn("Not running for a pull request, skipping the pull request comment")
        return false
    }

    if (body.length > MAX_COMMENT_LENGTH) {
        body = body.slice(0, MAX_COMMENT_LENGTH) + "\n\n_…output truncated, see the workflow logs for the full report._"
    }

    body = `${COMMENT_MARKER}\n${body}`

    const existing = await findExistingComment(repo, prNumber)

    if (existing) {
        await request("PATCH", `/repos/${repo}/issues/comments/${existing.id}`, { body })
        return true
    }

    if (!hasIssues) {
        return false
    }

    await request("POST", `/repos/${repo}/issues/${prNumber}/comments`, { body })
    return true
}

// Workflow commands render as annotations on the PR "Files changed" tab
export const printAnnotations = function (issues) {
    const escape = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A")
    for (const issue of issues) {
        const props = [`file=${escape(issue.file)}`]
        if (issue.line) props.push(`line=${issue.line}`)
        console.log(`::${issue.level === "error" ? "error" : "warning"} ${props.join(",")}::${escape(issue.message)}`)
    }
}
