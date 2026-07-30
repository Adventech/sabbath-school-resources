#!/usr/bin/env node
"use strict"

import path from "node:path"
import { fileURLToPath } from "node:url"

const successfulCheckConclusions = new Set([
    "neutral",
    "skipped",
    "success",
])

function isCurrentWorkflowRun(checkRun, currentRunId) {
    if (!currentRunId || typeof checkRun?.details_url !== "string") {
        return false
    }

    const runPath = `/actions/runs/${currentRunId}`
    return checkRun.details_url.includes(`${runPath}/`)
        || checkRun.details_url.endsWith(runPath)
}

function newerSignal(candidate, existing) {
    const candidateId = Number(candidate?.id)
    const existingId = Number(existing?.id)

    if (Number.isFinite(candidateId) && Number.isFinite(existingId)) {
        return candidateId > existingId
    }

    return false
}

function latestCheckRuns(checkRuns, currentRunId) {
    const latest = new Map()

    for (const checkRun of checkRuns) {
        if (isCurrentWorkflowRun(checkRun, currentRunId)) {
            continue
        }

        const app = checkRun?.app?.id ?? checkRun?.app?.slug ?? "unknown"
        const name = typeof checkRun?.name === "string"
            ? checkRun.name
            : `missing-${checkRun?.id ?? latest.size}`
        const key = `${app}:${name}`
        const existing = latest.get(key)

        if (!existing || newerSignal(checkRun, existing)) {
            latest.set(key, checkRun)
        }
    }

    return [...latest.values()]
}

function latestCommitStatuses(statuses) {
    const latest = new Map()

    for (const status of statuses) {
        const context = typeof status?.context === "string"
            ? status.context
            : `missing-${status?.id ?? latest.size}`
        const existing = latest.get(context)

        if (!existing || newerSignal(status, existing)) {
            latest.set(context, status)
        }
    }

    return [...latest.values()]
}

export function evaluatePromotionSignals({
    checkRuns,
    statuses,
    currentRunId,
}) {
    if (!Array.isArray(checkRuns) || !Array.isArray(statuses)) {
        throw new TypeError("checkRuns and statuses must be arrays")
    }

    const checks = latestCheckRuns(checkRuns, String(currentRunId ?? ""))
    const commitStatuses = latestCommitStatuses(statuses)
    const failedChecks = checks.filter(checkRun =>
        checkRun?.status !== "completed"
        || !successfulCheckConclusions.has(checkRun?.conclusion)
    )
    const failedStatuses = commitStatuses.filter(status =>
        status?.state !== "success"
    )
    const signalCount = checks.length + commitStatuses.length

    return {
        allowed: signalCount > 0
            && failedChecks.length === 0
            && failedStatuses.length === 0,
        signalCount,
        failedCheckCount: failedChecks.length,
        failedStatusCount: failedStatuses.length,
    }
}

function safeGitHubApiUrl(value, label) {
    let parsed
    try {
        parsed = new URL(value)
    } catch {
        throw new Error(`unsafe ${label} URL`)
    }

    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") {
        throw new Error(`unsafe ${label} URL`)
    }

    return parsed.toString()
}

function nextPageUrl(linkHeader) {
    if (!linkHeader) {
        return null
    }

    for (const link of linkHeader.split(",")) {
        const match = link.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/)
        if (match?.[2] === "next") {
            return safeGitHubApiUrl(match[1], "pagination")
        }
    }

    return null
}

export async function fetchGitHubCollection(
    fetchImpl,
    initialUrl,
    headers,
    property,
) {
    if (typeof fetchImpl !== "function") {
        throw new TypeError("fetchImpl must be a function")
    }

    const items = []
    const visited = new Set()
    let url = safeGitHubApiUrl(initialUrl, "GitHub API")

    while (url) {
        if (visited.has(url) || visited.size >= 100) {
            throw new Error("unsafe pagination cycle or page limit")
        }
        visited.add(url)

        const response = await fetchImpl(url, { headers })
        if (!response?.ok) {
            throw new Error(
                `GitHub API request failed with status ${response?.status ?? "unknown"}`,
            )
        }

        const payload = await response.json()
        const page = property === null ? payload : payload?.[property]
        if (!Array.isArray(page)) {
            throw new Error("GitHub API response did not contain a collection")
        }
        items.push(...page)
        url = nextPageUrl(response.headers?.get?.("link"))
    }

    return items
}

function requiredEnvironment(name, pattern) {
    const value = process.env[name]
    if (typeof value !== "string" || !pattern.test(value)) {
        throw new Error(`Missing or invalid ${name}`)
    }
    return value
}

export async function runPromotionCheck(fetchImpl = globalThis.fetch) {
    const repository = requiredEnvironment(
        "PROMOTION_REPOSITORY",
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    )
    const sha = requiredEnvironment("PROMOTION_SHA", /^[0-9a-f]{40}$/)
    const currentRunId = requiredEnvironment(
        "PROMOTION_RUN_ID",
        /^[0-9]+$/,
    )
    const token = requiredEnvironment("GITHUB_TOKEN", /\S/)
    const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    const commitUrl =
        `https://api.github.com/repos/${repository}/commits/${sha}`
    const [checkRuns, statuses] = await Promise.all([
        fetchGitHubCollection(
            fetchImpl,
            `${commitUrl}/check-runs?per_page=100&filter=latest`,
            headers,
            "check_runs",
        ),
        fetchGitHubCollection(
            fetchImpl,
            `${commitUrl}/statuses?per_page=100`,
            headers,
            null,
        ),
    ])
    const result = evaluatePromotionSignals({
        checkRuns,
        statuses,
        currentRunId,
    })

    console.log(
        `Promotion gate evaluated ${result.signalCount} independent signal(s).`,
    )
    if (!result.allowed) {
        console.error(
            `Promotion blocked: ${result.failedCheckCount} check(s) and `
            + `${result.failedStatusCount} status context(s) are incomplete `
            + "or unsuccessful, or no independent signal exists.",
        )
        process.exitCode = 1
    }

    return result
}

const isMainModule = process.argv[1]
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMainModule) {
    try {
        await runPromotionCheck()
    } catch (error) {
        console.error(`Promotion check failed closed: ${error}`)
        process.exitCode = 1
    }
}
