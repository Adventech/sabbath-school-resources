#!/usr/bin/env node
"use strict"

/**
 * Offline validator for resources in ./src.
 *
 *   node ops/validate/validate-resources.js en/ss/2026-04 [more resources...]
 *
 * Validates the resource info.yml, its sections, documents and segments (front matter,
 * markdown blocks, inline styles, local assets, references), and everything the resource
 * depends on: language info.yml, the type feed(s), authors and categories.
 *
 * Locally, issues are printed to the console. On GitHub Actions they are also emitted as
 * annotations and posted (or updated) as a pull request comment using GITHUB_TOKEN.
 * Exits with code 1 when errors are found.
 */

// The validator never talks to Firestore or remote assets: force the local deploy mode
// before any helper reads DEPLOY_ENV (imports below are dynamic for that reason).
delete process.env.DEPLOY_ENV

const { run } = await import("./lib/run.js")

process.exitCode = await run(process.argv.slice(2))
