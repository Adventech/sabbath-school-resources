import fs from "fs-extra"
import yaml from "js-yaml"
import frontMatter from "front-matter"
import picomatch from "picomatch"
import dayjs from "dayjs"
import customParseFormat from "dayjs/plugin/customParseFormat.js"
import { fdir } from "fdir"
import { parseResourcePath } from "../../helpers/helpers.js"
import {
    SOURCE_DIR,
    RESOURCE_TYPE,
    RESOURCE_KIND,
    RESOURCE_INFO_FILENAME,
    RESOURCE_FEED_FILENAME,
    RESOURCE_PDF_FILENAME,
    RESOURCE_ASSETS_DIRNAME,
    RESOURCE_COVERS,
    LANGUAGE_INFO_FILENAME,
    DOCUMENT_INFO_FILENAME,
    SECTION_INFO_FILENAME,
    SEGMENT_FILENAME_EXTENSION,
    SEGMENT_TYPES,
    AUTHORS_DIRNAME,
    AUTHORS_INFO_FILENAME,
    AUTHORS_FEED_FILENAME,
    CATEGORIES_DIRNAME,
    CATEGORY_INFO_FILENAME,
    CATEGORY_FEED_FILENAME,
    FEED_SCOPES,
    DATE_FORMAT,
} from "../../helpers/constants.js"
import {
    languageSchema,
    resourceSchema,
    sectionSchema,
    documentSchema,
    segmentSchema,
    pdfFileSchema,
    feedSchema,
    categoryFeedSchema,
    authorSchema,
    categorySchema,
} from "./schemas.js"
import { BlockValidator, typefacesOf, isURL } from "./blocks.js"

dayjs.extend(customParseFormat)

// Segments that are appended to other segments and are not listed on their own
const HIDDEN_SEGMENT_REGEX = /^(_|teacher-comments\.md$|hope-ss\.md$)/

let display = function (path) {
    return path.replace(/^\.\//, "")
}

let rel = function (path) {
    return path.replace(new RegExp(`^${SOURCE_DIR.replace(/\./g, "\\.")}/`), "")
}

export class ResourceValidator {
    constructor (reporter) {
        this.reporter = reporter
        this.checkedLanguages = new Map()
        this.checkedAuthors = new Set()
        this.checkedCategories = new Set()
        this.checkedFeeds = new Set()
    }

    // ---- helpers ----

    loadYaml (path, { required = true, label = null } = {}) {
        const file = display(path)
        if (!fs.pathExistsSync(path)) {
            if (required) this.reporter.error(file, `${label ?? "File"} does not exist`)
            return undefined
        }
        try {
            const data = yaml.load(fs.readFileSync(path, "utf8"))
            if (data === undefined || data === null) {
                this.reporter.error(file, `File is empty`)
                return undefined
            }
            return data
        } catch (e) {
            this.reporter.error(file, `Invalid YAML: ${e.reason ?? e.message}`, e.mark ? e.mark.line + 1 : null)
            return undefined
        }
    }

    date (file, value, key, line = null) {
        if (value === undefined || value === null) return null
        if (typeof value !== "string") {
            this.reporter.error(file, `\`${key}\` must be a string in ${DATE_FORMAT} format, got \`${value}\``, line)
            return null
        }
        const d = dayjs(value, DATE_FORMAT, true)
        if (!d.isValid()) {
            this.reporter.error(file, `\`${key}\` \`${value}\` is not a valid ${DATE_FORMAT} date`, line)
            return null
        }
        return d
    }

    dateRange (file, info, startKeys, endKeys) {
        const startKey = startKeys.find(k => info[k] !== undefined)
        const endKey = endKeys.find(k => info[k] !== undefined)
        const start = startKey ? this.date(file, info[startKey], startKey) : null
        const end = endKey ? this.date(file, info[endKey], endKey) : null

        if (start && end && end.isBefore(start)) {
            this.reporter.error(file, `\`${endKey}\` (${info[endKey]}) is before \`${startKey}\` (${info[startKey]})`)
        }
        if (startKey && !endKey) this.reporter.warn(file, `\`${startKey}\` is set but \`${endKeys[0]}\` is missing`)
        if (endKey && !startKey) this.reporter.warn(file, `\`${endKey}\` is set but \`${startKeys[0]}\` is missing`)

        return { start, end }
    }

    localAsset (file, resourceDir, src, what, extraDirs = []) {
        if (!src || isURL(src)) return
        const candidates = [`${resourceDir}/${RESOURCE_ASSETS_DIRNAME}/${src}`, ...extraDirs.map(d => `${d}/${src}`)]
        if (!candidates.some(c => fs.pathExistsSync(c))) {
            this.reporter.error(file, `${what} \`${src}\` not found in \`${RESOURCE_ASSETS_DIRNAME}/\``)
        }
    }

    regex (file, pattern, label, flags = "") {
        try {
            new RegExp(pattern, flags)
        } catch (e) {
            this.reporter.error(file, `${label} is not a valid regular expression: ${e.message}`)
        }
    }

    // ---- language ----

    language (language) {
        if (this.checkedLanguages.has(language)) return this.checkedLanguages.get(language)

        const path = `${SOURCE_DIR}/${language}/${LANGUAGE_INFO_FILENAME}`
        const file = display(path)
        const info = this.loadYaml(path, { label: "Language info" })
        this.checkedLanguages.set(language, info ?? null)

        if (!info) return null

        this.reporter.schema(file, info, languageSchema)

        if (info.code && info.code !== language) {
            this.reporter.error(file, `\`code\` is \`${info.code}\` but the language folder is \`${language}\``)
        }

        for (const [i, pattern] of (info.deploymentReplacements?.collapse ?? []).entries()) {
            this.regex(file, pattern, `\`deploymentReplacements.collapse[${i}]\``, "img")
        }

        for (const [i, pattern] of (info.share?.autoCTAPatterns ?? []).entries()) {
            this.regex(file, pattern, `\`share.autoCTAPatterns[${i}]\``)
        }

        // deploy-languages reads feed.yml for every resource type folder of the language
        for (const type of Object.values(RESOURCE_TYPE)) {
            const typeDir = `${SOURCE_DIR}/${language}/${type}`
            if (fs.pathExistsSync(typeDir) && !fs.pathExistsSync(`${typeDir}/${RESOURCE_FEED_FILENAME}`)) {
                this.reporter.error(display(typeDir), `\`${RESOURCE_FEED_FILENAME}\` is missing - this crashes the languages deploy`)
            }
        }

        return info
    }

    // ---- feeds ----

    allResourceIds (language) {
        if (!this._resourceIds) this._resourceIds = {}
        if (!this._resourceIds[language]) {
            this._resourceIds[language] = new fdir()
                .withRelativePaths()
                .withMaxDepth(2)
                .glob(`+(${Object.values(RESOURCE_TYPE).join("|")})/*/${RESOURCE_INFO_FILENAME}`)
                .crawl(`${SOURCE_DIR}/${language}`)
                .sync()
                .map(p => `${language}-${p.split("/")[0]}-${p.split("/")[1]}`)
        }
        return this._resourceIds[language]
    }

    entityIds (language, dirname) {
        const dir = `${SOURCE_DIR}/${language}/${dirname}`
        if (!fs.pathExistsSync(dir)) return []
        return fs.readdirSync(dir).filter(d => fs.pathExistsSync(`${dir}/${d}/${RESOURCE_INFO_FILENAME}`))
    }

    feedFiles (language, type) {
        const dir = `${SOURCE_DIR}/${language}/${type}`
        if (!fs.pathExistsSync(dir)) return []
        return fs.readdirSync(dir)
            .filter(f => f === RESOURCE_FEED_FILENAME || /^feed-[a-z]+\.yml$/.test(f))
            .map(f => `${dir}/${f}`)
    }

    feed (path, language) {
        if (this.checkedFeeds.has(path)) return this.loadedFeed(path)
        this.checkedFeeds.add(path)

        const file = display(path)
        const feed = this.loadYaml(path)
        if (!feed) return null

        this.reporter.schema(file, feed, feedSchema)
        if (!Array.isArray(feed.groups)) return feed

        const resourceIds = this.allResourceIds(language)
        const authorIds = this.entityIds(language, AUTHORS_DIRNAME)
        const categoryIds = this.entityIds(language, CATEGORIES_DIRNAME)

        for (const [i, group] of feed.groups.entries()) {
            if (!group || typeof group !== "object") continue
            const name = `\`groups[${i}]\`${group.group ? ` ("${group.group}")` : ""}`

            if (!group.resources && !group.authors && !group.categories && !group.kind && !group.scope && !group.author) {
                this.reporter.warn(file, `${name} has no \`resources\`, \`authors\`, \`categories\`, \`kind\` or \`scope\` - it will always be empty`)
            }

            this.feedPatterns(file, name, group.resources, resourceIds, "resource")
            this.feedPatterns(file, name, group.authors, authorIds, "author")
            this.feedPatterns(file, name, group.categories, categoryIds, "category")

            if (group.authors && group.scope !== FEED_SCOPES.AUTHOR) {
                this.reporter.warn(file, `${name} lists \`authors\` but its scope is not \`${FEED_SCOPES.AUTHOR}\``)
            }
            if (group.categories && group.scope !== FEED_SCOPES.CATEGORY) {
                this.reporter.warn(file, `${name} lists \`categories\` but its scope is not \`${FEED_SCOPES.CATEGORY}\``)
            }
        }

        return feed
    }

    loadedFeed (path) {
        try { return yaml.load(fs.readFileSync(path, "utf8")) } catch (e) { return null }
    }

    feedPatterns (file, name, patterns, ids, what) {
        if (!Array.isArray(patterns)) return
        for (const pattern of patterns) {
            if (typeof pattern !== "string") continue
            let matcher
            try {
                matcher = picomatch(pattern)
            } catch (e) {
                this.reporter.error(file, `${name} has an invalid ${what} pattern \`${pattern}\`: ${e.message}`)
                continue
            }
            if (!ids.some(id => matcher(id))) {
                this.reporter.warn(file, `${name} ${what} pattern \`${pattern}\` does not match any existing ${what}`)
            }
        }
    }

    feedMembership (resourceId, info, pathInfo) {
        if (info.skipFeed) return

        const kind = info.externalURL ? RESOURCE_KIND.EXTERNAL : (info.kind ?? RESOURCE_KIND.BOOK)
        const resourceFile = display(`${SOURCE_DIR}/${pathInfo.language}/${pathInfo.type}/${pathInfo.title}/${RESOURCE_INFO_FILENAME}`)
        const byPattern = (g) => Array.isArray(g.resources) && g.resources.some(p => {
            try { return picomatch(p)(resourceId) } catch (e) { return false }
        })

        // Own type feed: same order of precedence as deploy-resources (pattern, kind, scope)
        const ownFeeds = this.feedFiles(pathInfo.language, pathInfo.type)
        const missingIn = []
        for (const path of ownFeeds) {
            const feed = this.feed(path, pathInfo.language)
            if (!feed || !Array.isArray(feed.groups)) continue
            const listed = feed.groups.some(g => g && (byPattern(g) || (g.kind && g.kind === kind) || g.scope === FEED_SCOPES.RESOURCE))
            if (!listed) missingIn.push(path)
        }
        if (!missingIn.length) return

        // Non-ss resources can also be listed (by pattern only) in the feeds of other types
        if (pathInfo.type !== RESOURCE_TYPE.SS) {
            for (const type of Object.values(RESOURCE_TYPE).filter(t => t !== pathInfo.type)) {
                for (const path of this.feedFiles(pathInfo.language, type)) {
                    const feed = this.feed(path, pathInfo.language)
                    if (feed && Array.isArray(feed.groups) && feed.groups.some(g => g && byPattern(g))) return
                }
            }
        }

        for (const path of missingIn) {
            this.reporter.warn(resourceFile, `Resource \`${resourceId}\` is not matched by any group of \`${display(path)}\` (or another type's feed) and will not appear in any feed - set \`skipFeed: true\` if intended`)
        }
    }

    // ---- authors & categories ----

    author (language, id, referencedBy) {
        const path = `${SOURCE_DIR}/${language}/${AUTHORS_DIRNAME}/${id}/${AUTHORS_INFO_FILENAME}`
        if (!fs.pathExistsSync(path)) {
            this.reporter.error(referencedBy, `Author \`${id}\` does not exist (\`${display(path)}\`) - authors are not attached to the resource`)
            return
        }
        if (this.checkedAuthors.has(path)) return
        this.checkedAuthors.add(path)

        const file = display(path)
        const info = this.loadYaml(path)
        if (info) {
            this.reporter.schema(file, info, authorSchema)
            if (info.id && info.id !== id) {
                this.reporter.error(file, `\`id\` is \`${info.id}\` but the author folder is \`${id}\` - the resource will not show up in the author feed`)
            }
        }

        const feedPath = `${SOURCE_DIR}/${language}/${AUTHORS_DIRNAME}/${id}/${AUTHORS_FEED_FILENAME}`
        const feed = this.loadYaml(feedPath, { label: "Author feed" })
        if (feed) {
            this.reporter.schema(display(feedPath), feed, feedSchema)
        }
    }

    category (language, id, referencedBy) {
        const path = `${SOURCE_DIR}/${language}/${CATEGORIES_DIRNAME}/${id}/${CATEGORY_INFO_FILENAME}`
        if (!fs.pathExistsSync(path)) {
            this.reporter.error(referencedBy, `Category \`${id}\` does not exist (\`${display(path)}\`)`)
            return
        }
        if (this.checkedCategories.has(path)) return
        this.checkedCategories.add(path)

        const file = display(path)
        const info = this.loadYaml(path)
        if (info) {
            this.reporter.schema(file, info, categorySchema)
            if (info.id && info.id !== id) {
                this.reporter.error(file, `\`id\` is \`${info.id}\` but the category folder is \`${id}\``)
            }
        }

        const feedPath = `${SOURCE_DIR}/${language}/${CATEGORIES_DIRNAME}/${id}/${CATEGORY_FEED_FILENAME}`
        const feed = this.loadYaml(feedPath, { label: "Category feed" })
        if (feed) {
            this.reporter.schema(display(feedPath), feed, categoryFeedSchema)
        }
    }

    // ---- resource ----

    /**
     * @param resourcePath  "lang/type/title"
     */
    async resource (resourcePath) {
        const pathInfo = parseResourcePath(resourcePath)
        const resourceDir = `${SOURCE_DIR}/${pathInfo.language}/${pathInfo.type}/${pathInfo.title}`
        const infoPath = `${resourceDir}/${RESOURCE_INFO_FILENAME}`
        const file = display(infoPath)
        const resourceId = `${pathInfo.language}-${pathInfo.type}-${pathInfo.title}`

        if (!Object.values(RESOURCE_TYPE).includes(pathInfo.type)) {
            this.reporter.error(display(resourceDir), `Unknown resource type \`${pathInfo.type}\`, expected one of ${Object.values(RESOURCE_TYPE).map(t => `\`${t}\``).join(", ")}`)
            return
        }

        const languageInfo = this.language(pathInfo.language)
        const info = this.loadYaml(infoPath, { label: "Resource info" })
        if (!info) return

        this.reporter.schema(file, info, resourceSchema)

        if (info.color_primary && info.primaryColor) {
            this.reporter.warn(file, `Both \`color_primary\` and \`primaryColor\` are set - \`primaryColor\` wins`)
        }

        this.dateRange(file, info, ["startDate", "start_date"], ["endDate", "end_date"])

        // covers
        if (!info.covers?.portrait && !fs.pathExistsSync(`${resourceDir}/${RESOURCE_ASSETS_DIRNAME}/${RESOURCE_COVERS.PORTRAIT}`)) {
            this.reporter.warn(file, `No portrait cover (\`covers.portrait\` or \`${RESOURCE_ASSETS_DIRNAME}/${RESOURCE_COVERS.PORTRAIT}\`) - a placeholder is used`)
        }
        for (const [key, value] of Object.entries(info.covers ?? {})) {
            if (typeof value === "string") this.localAsset(file, resourceDir, value, `\`covers.${key}\``)
        }

        // kind / external
        const isExternal = info.kind === RESOURCE_KIND.EXTERNAL || !!info.externalURL
        if (info.kind === RESOURCE_KIND.EXTERNAL && !info.externalURL) {
            this.reporter.error(file, `\`kind: external\` requires \`externalURL\``)
        }

        // authors
        if (info.author) {
            const authors = Array.isArray(info.author) ? info.author : [info.author]
            for (const author of authors) {
                if (typeof author === "string") this.author(pathInfo.language, author, file)
            }
        }

        // categories
        if (Array.isArray(info.categories)) {
            if (![RESOURCE_TYPE.DEVO, RESOURCE_TYPE.PM].includes(pathInfo.type)) {
                this.reporter.warn(file, `\`categories\` are only processed for \`${RESOURCE_TYPE.DEVO}\` and \`${RESOURCE_TYPE.PM}\` resources`)
            }
            for (const category of info.categories) {
                if (typeof category === "string") this.category(pathInfo.language, category, file)
            }
        }

        // featured resources
        for (const featured of info.featuredResources ?? []) {
            if (typeof featured === "string" && !fs.pathExistsSync(`${SOURCE_DIR}/${featured}/${RESOURCE_INFO_FILENAME}`)) {
                this.reporter.error(file, `Featured resource \`${featured}\` does not exist`)
            }
        }

        // features
        if (Array.isArray(info.features) && info.features.length) {
            const available = Object.keys(languageInfo?.features ?? {})
            for (const feature of info.features) {
                if (!available.includes(feature)) {
                    this.reporter.warn(file, `Feature \`${feature}\` is not defined in \`${pathInfo.language}/${LANGUAGE_INFO_FILENAME}\` and is ignored`)
                }
            }
        }

        // fonts & typefaces
        const fonts = new Set((Array.isArray(info.fonts) ? info.fonts : []).map(f => f?.name).filter(Boolean))
        const typefaces = []
        const onTypeface = (file, line) => (typeface) => typefaces.push({ typeface, file, line })
        for (const typeface of typefacesOf(info.style)) onTypeface(file, null)(typeface)

        // feeds
        if (!fs.pathExistsSync(`${SOURCE_DIR}/${pathInfo.language}/${pathInfo.type}/${RESOURCE_FEED_FILENAME}`)) {
            this.reporter.error(file, `\`${pathInfo.language}/${pathInfo.type}/${RESOURCE_FEED_FILENAME}\` does not exist - the resource is skipped by the deploy`)
        } else {
            this.feedMembership(resourceId, info, pathInfo)
        }

        // sections
        const sections = new fdir()
            .withRelativePaths()
            .withMaxDepth(2)
            .glob(`*/${SECTION_INFO_FILENAME}`)
            .crawl(resourceDir)
            .sync()
        for (const section of sections) {
            const sectionPath = `${resourceDir}/${section}`
            const sectionInfo = this.loadYaml(sectionPath)
            if (sectionInfo) this.reporter.schema(display(sectionPath), sectionInfo, sectionSchema)
        }

        // documents - same discovery as deploy-documents
        // equivalent to the deploy's `lang/type/title/*/**/info.yml` (depth 5 from src),
        // but crawling only the resource folder
        const documents = new fdir()
            .withRelativePaths()
            .withMaxDepth(2)
            .glob(`*/**/${DOCUMENT_INFO_FILENAME}`)
            .crawl(resourceDir)
            .sync()
            .filter(d => !d.split("/").includes(RESOURCE_ASSETS_DIRNAME))
            .map(d => `${pathInfo.language}/${pathInfo.type}/${pathInfo.title}/${d}`)
            .sort()

        const pdfPath = `${resourceDir}/${RESOURCE_PDF_FILENAME}`
        if (fs.pathExistsSync(pdfPath)) {
            this.pdfFile(pdfPath, pathInfo, !documents.length)
        }

        if (!documents.length && !isExternal && !fs.pathExistsSync(pdfPath)) {
            this.reporter.error(file, `Resource has no documents and no \`${RESOURCE_PDF_FILENAME}\``)
        }

        let previous = null
        for (const document of documents) {
            const result = await this.document(`${SOURCE_DIR}/${document}`, languageInfo, onTypeface)

            // overlapping dates between consecutive documents of the same section
            if (result?.start && result?.end) {
                if (previous && previous.dir === result.parentDir && result.start.isBefore(previous.end, "day")) {
                    this.reporter.warn(display(result.path), `Document starts on ${result.start.format(DATE_FORMAT)}, before the previous document ends (${previous.end.format(DATE_FORMAT)})`)
                }
                previous = { dir: result.parentDir, end: result.end }
            }
        }

        if (typefaces.length) {
            for (const { typeface, file: f, line } of typefaces) {
                if (!fonts.has(typeface)) {
                    this.reporter.warn(f, `Typeface \`${typeface}\` is not declared in the resource \`fonts\``, line)
                }
            }
        }
    }

    pdfFile (path, pathInfo, pdfOnly) {
        const file = display(path)
        const info = this.loadYaml(path)
        if (!info) return
        if (!this.reporter.schema(file, info, pdfFileSchema)) return

        for (const [i, pdf] of info.pdf.entries()) {
            if (pdf.target) {
                const target = parseResourcePath(pdf.target)
                if (`${target.language}/${target.type}/${target.title}` !== `${pathInfo.language}/${pathInfo.type}/${pathInfo.title}` || !target.document) {
                    this.reporter.error(file, `\`pdf[${i}].target\` \`${pdf.target}\` must point to a document of this resource`)
                }
            }
            if (pdfOnly && !pdf.title) {
                this.reporter.warn(file, `\`pdf[${i}]\` has no \`title\` and is skipped for PDF-only resources`)
            }
            this.date(file, pdf.start_date, `pdf[${i}].start_date`)
            this.date(file, pdf.end_date, `pdf[${i}].end_date`)
        }
    }

    // ---- documents & segments ----

    async document (path, languageInfo, onTypeface) {
        const file = display(path)
        const info = this.loadYaml(path)
        const documentDir = path.replace(new RegExp(`/${DOCUMENT_INFO_FILENAME}$`), "")
        const pathInfo = parseResourcePath(rel(path))
        const resourceDir = `${SOURCE_DIR}/${pathInfo.language}/${pathInfo.type}/${pathInfo.title}`

        let start = null, end = null

        // segments are validated even when the document info is broken
        if (info !== undefined && (typeof info !== "object" || Array.isArray(info))) {
            this.reporter.error(file, `Document info must be a YAML object`)
        } else if (info) {
            this.reporter.schema(file, info, documentSchema);
            ({ start, end } = this.dateRange(file, info, ["startDate", "start_date"], ["endDate", "end_date"]))

            this.localAsset(file, resourceDir, info.cover, "`cover`", [documentDir])
            this.localAsset(file, resourceDir, info.background, "`background`", [documentDir])
            for (const typeface of typefacesOf(info.style)) onTypeface(file, null)(typeface)
        }

        const segments = fs.readdirSync(documentDir)
            .filter(f => f.endsWith(SEGMENT_FILENAME_EXTENSION))
            .sort()

        const visible = segments.filter(s => !HIDDEN_SEGMENT_REGEX.test(s))
        if (!visible.length && !info?.externalURL) {
            this.reporter.warn(file, `Document has no segments`)
        }

        for (const segment of segments) {
            await this.segment(`${documentDir}/${segment}`, languageInfo, { start, end }, onTypeface)
        }

        return { path, start, end, parentDir: documentDir.replace(/\/[^/]+$/, "") }
    }

    async segment (path, languageInfo, documentDates, onTypeface) {
        const file = display(path)
        const pathInfo = parseResourcePath(rel(path))
        const resourceDir = `${SOURCE_DIR}/${pathInfo.language}/${pathInfo.type}/${pathInfo.title}`
        const content = fs.readFileSync(path, "utf8")

        let parsed
        try {
            parsed = frontMatter(content)
        } catch (e) {
            this.reporter.error(file, `Invalid front matter - this crashes the deploy: ${e.reason ?? e.message}`, e.mark ? e.mark.line + 2 : 1)
            return
        }

        const attributes = parsed.attributes ?? {}
        this.reporter.schema(file, attributes, segmentSchema, { label: "" })

        // date
        const date = this.date(file, attributes.date, "date")
        if (date && documentDates.start && documentDates.end
            && (date.isBefore(documentDates.start, "day") || date.isAfter(documentDates.end, "day"))) {
            this.reporter.warn(file, `\`date\` ${attributes.date} is outside of the document range ${documentDates.start.format(DATE_FORMAT)} - ${documentDates.end.format(DATE_FORMAT)}`)
        }
        this.dateRange(file, attributes, ["startDate"], ["endDate"])

        // media
        this.localAsset(file, resourceDir, attributes.cover, "`cover`")
        this.localAsset(file, resourceDir, attributes.background, "`background`")
        if (attributes.audio?.src) this.localAsset(file, resourceDir, attributes.audio.src, "`audio.src`")

        if (attributes.type && attributes.type !== SEGMENT_TYPES.PDF && attributes.pdf) {
            this.reporter.warn(file, `\`type: ${attributes.type}\` is overridden to \`${SEGMENT_TYPES.PDF}\` because \`pdf\` is set`)
        }
        if (attributes.type && attributes.type !== SEGMENT_TYPES.VIDEO && attributes.video) {
            this.reporter.warn(file, `\`type: ${attributes.type}\` is overridden to \`${SEGMENT_TYPES.VIDEO}\` because \`video\` is set`)
        }

        for (const typeface of typefacesOf(attributes.style)) onTypeface(file, null)(typeface)

        // body - apply the same collapse replacements as the deploy
        let body = parsed.body
        for (const pattern of languageInfo?.deploymentReplacements?.collapse ?? []) {
            let regex
            try { regex = new RegExp(pattern, "img") } catch (e) { continue }
            const match = body.match(regex)
            if (match) {
                body = body.replace(regex, `\n\`\`\`=${match[0].replace(/\n?#{2,}\s*/, "").trim()}\n\`\`\``)
            }
        }

        const type = attributes.pdf ? SEGMENT_TYPES.PDF : attributes.video ? SEGMENT_TYPES.VIDEO : (attributes.type ?? SEGMENT_TYPES.BLOCK)
        const filter = type === SEGMENT_TYPES.STORY ? (b) => b.type === "story" : null

        const blocks = new BlockValidator({
            reporter: this.reporter,
            file,
            pathInfo,
            onTypeface: (typeface, line) => onTypeface(file, line)(typeface),
        })

        const tokens = blocks.markdown(body, parsed.bodyBegin ?? 1, filter)

        if (!tokens.length && type === SEGMENT_TYPES.BLOCK) {
            this.reporter.warn(file, `Segment has no content`)
        }
    }
}
