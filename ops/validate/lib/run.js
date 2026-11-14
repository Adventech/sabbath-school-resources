import fs from "fs-extra"
import { fdir } from "fdir"
import { SOURCE_DIR, RESOURCE_TYPE, RESOURCE_INFO_FILENAME } from "../../helpers/constants.js"
import { Reporter } from "./reporter.js"
import { ResourceValidator } from "./validator.js"
import { isGitHubActions, postPullRequestComment, printAnnotations } from "./github.js"

const CHANGED_FILES = "./.github/outputs/all_changed_files.json"

const USAGE = `Usage: node ops/validate/validate-resources.js <language/type/resource> [...more]

Examples:
  node ops/validate/validate-resources.js en/ss/2026-04
  node ops/validate/validate-resources.js src/en/devo/bhp-2026 en/pm/discipleship-handbook
  node ops/validate/validate-resources.js "en/ss/2026-0*"

Without arguments, resources are taken from ${CHANGED_FILES} (GitHub Actions).`

let normalizeTarget = function (target) {
    return target.trim().replace(/^\.?\//, "").replace(/^src\//, "").replace(/\/+$/, "")
}

/**
 * Resolves CLI arguments (or changed files) to a list of "lang/type/resource" paths.
 */
let resolveTargets = function (args, reporter) {
    let targets = args.filter(a => !a.startsWith("-")).map(normalizeTarget).filter(Boolean)

    if (!targets.length && fs.pathExistsSync(CHANGED_FILES)) {
        try {
            const changed = JSON.parse(fs.readFileSync(CHANGED_FILES, "utf-8"))
            targets = changed
                .filter(f => /^src\//.test(f))
                .map(f => normalizeTarget(f).split("/"))
                .filter(p => p.length > 3 && Object.values(RESOURCE_TYPE).includes(p[1]))
                .map(p => p.slice(0, 3).join("/"))
        } catch (e) {
            console.error(`Could not read ${CHANGED_FILES}: ${e}`)
        }
    }

    const resolved = new Set()

    for (const target of [...new Set(targets)]) {
        const parts = target.split("/")

        if (parts.length < 3) {
            reporter.error(`src/${target}`, `Target must be a resource path like \`en/ss/2026-04\``)
            continue
        }

        const glob = parts.slice(0, 3).join("/")

        if (!/[*?{}\[\]()!+@]/.test(glob)) {
            if (fs.pathExistsSync(`${SOURCE_DIR}/${glob}/${RESOURCE_INFO_FILENAME}`)) {
                resolved.add(glob)
            } else {
                reporter.error(`src/${glob}`, fs.pathExistsSync(`${SOURCE_DIR}/${glob}`)
                    ? `Resource \`${RESOURCE_INFO_FILENAME}\` does not exist`
                    : `Resource does not exist`)
            }
            continue
        }

        const found = new fdir()
            .withRelativePaths()
            .withMaxDepth(3)
            .glob(`${glob}/${RESOURCE_INFO_FILENAME}`)
            .crawl(SOURCE_DIR)
            .sync()
            .map(p => p.replace(new RegExp(`/${RESOURCE_INFO_FILENAME}$`), ""))
            // a glob like en/*/* must not pick up authors/ or categories/
            .filter(p => Object.values(RESOURCE_TYPE).includes(p.split("/")[1]))

        if (!found.length) {
            reporter.error(`src/${glob}`, fs.pathExistsSync(`${SOURCE_DIR}/${glob}`)
                ? `Resource \`${RESOURCE_INFO_FILENAME}\` does not exist`
                : `Resource does not exist`)
            continue
        }

        found.forEach(r => resolved.add(r))
    }

    return { targets, resources: [...resolved].sort() }
}

// ---- output ----

const useColor = process.stdout.isTTY && !isGitHubActions()
const paint = (code, s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s
const red = (s) => paint("31", s)
const yellow = (s) => paint("33", s)
const green = (s) => paint("32", s)
const dim = (s) => paint("2", s)
const bold = (s) => paint("1", s)

let sortIssues = function (issues) {
    return [...issues].sort((a, b) =>
        a.file.localeCompare(b.file)
        || (a.line ?? 0) - (b.line ?? 0)
        || (a.level === b.level ? 0 : a.level === "error" ? -1 : 1))
}

let printConsole = function (reporter, resources) {
    const issues = sortIssues(reporter.issues)
    let currentFile = null

    for (const issue of issues) {
        if (issue.file !== currentFile) {
            currentFile = issue.file
            console.log(`\n${bold(issue.file)}`)
        }
        const level = issue.level === "error" ? red("error  ") : yellow("warning")
        const line = issue.line ? dim(String(issue.line).padStart(5)) : "     "
        console.log(`${line}  ${level}  ${issue.message}`)
    }

    const errors = reporter.errors.length
    const warnings = reporter.warnings.length
    const summary = `${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"} in ${resources.length} resource${resources.length === 1 ? "" : "s"}`

    console.log("")
    if (errors) {
        console.log(red(bold(`✖ ${summary}`)))
    } else if (warnings) {
        console.log(yellow(bold(`⚠ ${summary}`)))
    } else {
        console.log(green(bold(`✔ ${summary}`)))
    }
}

let escapeCell = function (s) {
    return String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

let markdownTable = function (issues, icon) {
    let out = "| | File | Issue |\n| --- | --- | --- |\n"
    for (const issue of issues) {
        out += `| ${icon} | \`${escapeCell(issue.file)}${issue.line ? `:${issue.line}` : ""}\` | ${escapeCell(issue.message)} |\n`
    }
    return out
}

let markdownReport = function (reporter, resources) {
    const errors = sortIssues(reporter.errors)
    const warnings = sortIssues(reporter.warnings)
    const validated = resources.map(r => `\`${r}\``).join(", ") || "_nothing_"

    let out
    if (errors.length) {
        out = `### 🛑 Resource validation failed\n\n`
    } else if (warnings.length) {
        out = `### ⚠️ Resource validation passed with warnings\n\n`
    } else {
        out = `### ✅ Resource validation passed\n\n`
    }

    out += `Validated: ${validated}\n\n**${errors.length}** error(s), **${warnings.length}** warning(s)\n\n`

    if (errors.length) {
        out += markdownTable(errors, "🛑") + "\n"
    }

    if (warnings.length) {
        out += `<details${errors.length ? "" : " open"}><summary>Warnings (${warnings.length})</summary>\n\n`
        out += markdownTable(warnings, "⚠️")
        out += `\n</details>\n`
    }

    return out
}

// ---- main ----

export const run = async function (args) {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(USAGE)
        return 0
    }

    const reporter = new Reporter()
    const { targets, resources } = resolveTargets(args, reporter)

    if (!targets.length) {
        console.log(isGitHubActions() ? "No changed resources to validate" : USAGE)
        return isGitHubActions() ? 0 : 2
    }

    const validator = new ResourceValidator(reporter)

    for (const resource of resources) {
        console.log(dim(`Validating ${resource}`))
        try {
            await validator.resource(resource)
        } catch (e) {
            reporter.error(`src/${resource}`, `Validator crashed: ${e.stack ?? e}`)
        }
    }

    printConsole(reporter, resources)

    if (isGitHubActions()) {
        printAnnotations(sortIssues(reporter.issues))
        try {
            await postPullRequestComment(markdownReport(reporter, resources), reporter.issues.length > 0)
        } catch (e) {
            console.error(`Could not post the pull request comment: ${e.message}`)
        }
    }

    return reporter.errors.length ? 1 : 0
}
