import { Validator } from "jsonschema"

export const LEVEL = {
    ERROR: "error",
    WARNING: "warning",
}

const validator = new Validator()

export class Reporter {
    constructor () {
        this.issues = []
        this.seen = new Set()
    }

    add (level, file, message, line = null) {
        // the same file (e.g. language info.yml) can be checked for several resources
        const key = `${level}|${file}|${line}|${message}`
        if (this.seen.has(key)) return
        this.seen.add(key)
        this.issues.push({ level, file, line, message })
    }

    error (file, message, line) { this.add(LEVEL.ERROR, file, message, line) }

    warn (file, message, line) { this.add(LEVEL.WARNING, file, message, line) }

    get errors () { return this.issues.filter(i => i.level === LEVEL.ERROR) }

    get warnings () { return this.issues.filter(i => i.level === LEVEL.WARNING) }

    /**
     * Validates `instance` against a JSON schema and reports every violation.
     * Unknown keys (additionalProperties) are reported as warnings, everything else as errors.
     * @returns {boolean} true when no errors (warnings are allowed)
     */
    schema (file, instance, schema, { label = "", line = null, level = null } = {}) {
        const result = validator.validate(instance, schema, { nestedErrors: false })
        let ok = true

        for (const e of result.errors) {
            const where = formatPath(label, e.path)
            if (e.name === "additionalProperties") {
                const key = e.argument
                if (/^\s|\s$/.test(key) || (/\s/.test(key) && !e.path.length)) {
                    // e.g. "    title" (bad indentation) or "s First Lie" (unquoted colon in a value)
                    this.add(level ?? LEVEL.ERROR, file, `Malformed key \`${key}\`${where ? ` in \`${where}\`` : ""} - check indentation or quote values containing ":"`, line)
                    ok = false
                } else {
                    this.add(LEVEL.WARNING, file, `Unknown key \`${key}\`${where ? ` in \`${where}\`` : ""} is ignored`, line)
                }
                continue
            }

            if (e.name === "anyOf" || e.name === "oneOf") {
                this.add(level ?? LEVEL.ERROR, file, `\`${where || "(root)"}\` has an invalid value: ${short(e.instance)}`, line)
            } else {
                this.add(level ?? LEVEL.ERROR, file, `\`${where || "(root)"}\` ${e.message}`, line)
            }
            ok = level === LEVEL.WARNING ? ok : false
        }

        return ok
    }
}

let formatPath = function (label, path) {
    let p = label
    for (const part of path) {
        p += typeof part === "number" ? `[${part}]` : `${p ? "." : ""}${part}`
    }
    return p
}

let short = function (value) {
    let s = JSON.stringify(value)
    if (s && s.length > 80) s = s.slice(0, 77) + "..."
    return `\`${s}\``
}
