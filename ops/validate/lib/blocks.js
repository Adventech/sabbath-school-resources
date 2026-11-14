import fs from "fs-extra"
import frontMatter from "front-matter"
import { NodeHtmlMarkdown } from "node-html-markdown"
import { marked } from "../../helpers/blocks.js"
import { getBibleData } from "../../helpers/bible.js"
import { parseResourcePath } from "../../helpers/helpers.js"
import {
    SOURCE_DIR,
    RESOURCE_ASSETS_DIRNAME,
    RESOURCE_INFO_FILENAME,
    DOCUMENT_INFO_FILENAME,
    SEGMENT_FILENAME_EXTENSION,
} from "../../helpers/constants.js"
import { inlineStyleSchema } from "./schemas.js"
import { LEVEL } from "./reporter.js"

// Same expressions as ops/helpers/blocks/style.js
const STYLE_LIST_REGEX = /^\s*(-)\s*({\s*"style"\s*:.*})/
const STYLE_BLOCK_REGEX = /^({\s*"style"\s*:.*})/
// Anything that looks like an attempt to add a style
const STYLE_LOOSE_REGEX = /^\s*(-\s*)?\{\s*["']?style["']?\s*:/

// Opening markers of the custom blocks. A paragraph starting with one of these means
// the custom tokenizer did not match (unclosed block, missing new line, trailing spaces...)
const CUSTOM_BLOCK_MARKERS = [
    { regex: /^:{3}/, name: "carousel (`:::`)" },
    { regex: /^={3}/, name: "slide (`===`)" },
    { regex: /^;{3}/, name: "story (`;;;`)" },
    { regex: /^\^{3}/, name: "story slide (`^^^`)" },
    { regex: /^\?{3}/, name: "poll (`???=`)" },
    { regex: /^`{3,}=/, name: "collapse (```` ```= ````)" },
    { regex: /^\{\s*(#|ref)\s*\[/, name: "reference (`{#[...]}`)" },
    { regex: /^!\s*(a|audio)\s*\[/, name: "audio (`!a[...]`)" },
    { regex: /^!\s*(v|video)\s*\[/, name: "video (`!v[...]`)" },
]

const HTML_TAG_REGEX = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*)?\/?>/g
const HTML_ALLOWED_INLINE = ["sup", "sub"]

let lineOf = function (text, index) {
    if (index <= 0) return 0
    return text.slice(0, index).split("\n").length - 1
}

let isURL = function (src) {
    return /^https?:\/\//.test(String(src).trim())
}

let typefacesOf = function (style, out = []) {
    if (style && typeof style === "object") {
        for (const key of Object.keys(style)) {
            if (key === "typeface" && typeof style[key] === "string") {
                out.push(style[key])
            } else {
                typefacesOf(style[key], out)
            }
        }
    }
    return out
}

export class BlockValidator {
    /**
     * @param ctx.reporter       Reporter
     * @param ctx.file           display path of the segment file
     * @param ctx.pathInfo       parseResourcePath() of the segment
     * @param ctx.onTypeface     callback(typeface, line) to collect used typefaces
     */
    constructor (ctx) {
        this.ctx = ctx
        this.reporter = ctx.reporter
        this.file = ctx.file
        this.pathInfo = ctx.pathInfo
        const p = ctx.pathInfo
        this.resourceDir = `${SOURCE_DIR}/${p.language}/${p.type}/${p.title}`
        this.documentDir = `${this.resourceDir}/${p.section ? p.section + "/" : ""}${p.document}`
    }

    error (message, line) { this.reporter.error(this.file, message, line) }

    warn (message, line) { this.reporter.warn(this.file, message, line) }

    /**
     * Validates a markdown chunk.
     * @param markdown   markdown text
     * @param line       1-based line in the file where the chunk starts
     * @param filter     same filter that the deploy applies to the root tokens
     * @returns {Array}  non-space tokens
     */
    markdown (markdown, line, filter = null) {
        let tokens
        try {
            tokens = marked.lexer(markdown)
        } catch (e) {
            this.error(`Markdown could not be parsed: ${e.message}`, line)
            return []
        }

        let offset = 0
        const result = []

        for (const token of tokens) {
            // marked trims the raw of some tokens (e.g. lists), so locate it instead of summing lengths
            const raw = token.raw ?? ""
            const found = raw ? markdown.indexOf(raw, offset) : -1
            const start = found >= 0 ? found : offset
            // some custom tokenizers (e.g. image) include the preceding blank lines in their raw
            const tokenLine = line + lineOf(markdown, start + (raw.length - raw.trimStart().length))
            offset = start + raw.length

            if (token.type === "space") continue
            result.push(token)

            if (filter && !filter(token)) {
                this.warn(`\`${token.type}\` block is outside of a \`;;;\` story block and is ignored in a story segment`, tokenLine)
                continue
            }

            this.block(token, tokenLine)
        }

        return result
    }

    // Line of a child chunk within the parent's raw text
    childLine (parent, parentLine, child) {
        const index = parent.raw.indexOf(child.trim().split("\n")[0])
        return parentLine + (index >= 0 ? lineOf(parent.raw, index) : 0)
    }

    style (block, line) {
        const raw = block.raw ?? ""

        let validate = (json, isList) => {
            let options
            try {
                options = JSON.parse(json)
            } catch (e) {
                if (isList) {
                    this.error(`Invalid JSON in list style \`${json}\` - this crashes the deploy (${e.message})`, line)
                } else {
                    this.error(`Invalid JSON in block style \`${json}\` - style is ignored (${e.message})`, line)
                }
                return null
            }

            const ok = this.reporter.schema(this.file, options.style, inlineStyleSchema, { label: "style", line })
            if (!ok) {
                this.error(`Block style is ignored by the deploy because it does not match the style schema`, line)
                return null
            }
            for (const typeface of typefacesOf(options.style)) {
                this.ctx.onTypeface?.(typeface, line)
            }
            return options.style
        }

        if (block.type === "list" && STYLE_LIST_REGEX.test(raw)) {
            validate(raw.match(STYLE_LIST_REGEX)[2], true)
            return { listStyle: true }
        }

        const match = raw.match(STYLE_BLOCK_REGEX)
        if (match) {
            validate(match[0], false)
            const rest = (block.type === "image" ? raw : (block.text ?? "")).replace(STYLE_BLOCK_REGEX, "").trim()
            if (!rest.length && block.type !== "image") {
                this.warn(`Style is not attached to any content - put the style and the content in the same block (no blank line between them)`, line)
            }
            return { text: rest }
        }

        if (STYLE_LOOSE_REGEX.test(raw)) {
            this.error(`Unrecognized style prefix - it must be valid JSON starting with \`{"style":\` at the beginning of the block`, line)
        }

        return {}
    }

    inline (text, line, { where = "Paragraph" } = {}) {
        if (!text) return

        const tags = new Set()
        for (const m of String(text).matchAll(HTML_TAG_REGEX)) {
            const tag = m[1].toLowerCase()
            if (!HTML_ALLOWED_INLINE.includes(tag)) tags.add(tag)
        }
        if (tags.size) {
            this.warn(`${where} contains HTML tags that are stripped by the deploy: ${[...tags].map(t => `\`<${t}>\``).join(", ")}`, line)
        }
    }

    customBlockMarker (text, line) {
        const firstLine = String(text).trimStart().split("\n")[0]

        // e.g. a "=====" underline after a "###" heading
        const stray = firstLine.match(/^([=:;^?])\1{3,}\s*$/)
        if (stray) {
            this.warn(`Stray line of \`${stray[1]}\` characters is rendered as text`, line)
            return true
        }

        for (const marker of CUSTOM_BLOCK_MARKERS) {
            if (marker.regex.test(firstLine)) {
                this.error(`Malformed or unclosed ${marker.name} block - it is rendered as plain text`, line)
                return true
            }
        }
        return false
    }

    localFile (src, line, what, { allowDocumentDir = false, dropped = false } = {}) {
        if (!src || !String(src).trim()) {
            this.error(`${what} has an empty source`, line)
            return
        }
        if (isURL(src)) return

        const inAssets = fs.pathExistsSync(`${this.resourceDir}/${RESOURCE_ASSETS_DIRNAME}/${src}`)
        const inDocument = allowDocumentDir && fs.pathExistsSync(`${this.documentDir}/${src}`)

        if (!inAssets && !inDocument) {
            this.error(`${what} \`${src}\` not found in \`${RESOURCE_ASSETS_DIRNAME}/\`${allowDocumentDir ? " or the document folder" : ""}${dropped ? " - the block is dropped by the deploy" : ""}`, line)
        }
    }

    block (block, line) {
        const style = this.style(block, line)
        const handler = this[`block_${block.type.replace(/-/g, "_")}`]

        if (!handler) {
            this.warn(`Unsupported markdown block \`${block.type}\` is dropped by the deploy`, line)
            return
        }

        handler.call(this, block, line, style)
    }

    // ---- standard markdown ----

    block_paragraph (block, line, style) {
        const text = style.text ?? block.text ?? ""

        if (this.customBlockMarker(text, line)) return

        if (/<a>?/.test(block.raw)) {
            this.error(`Paragraph is dropped by the deploy because it contains \`<a\` - use markdown links instead of HTML`, line)
            return
        }

        this.inline(text, line)
    }

    block_text (block, line, style) {
        this.block_paragraph(block, line, style)
    }

    block_heading (block, line, style) {
        this.inline(style.text ?? block.text, line, { where: "Heading" })
    }

    block_hr () {}

    block_code (block, line) {
        this.warn(`Code block is not supported and is dropped by the deploy - use \`\`\`=Caption for a collapse block`, line)
    }

    block_blockquote (block, line) {
        let text = block.text ?? ""

        if (/<p>/.test(text) && !/<p>([^<>]*)<\/p>/.test(text)) {
            this.warn(`Malformed memory verse - expected \`<p>Title</p>\` inside the blockquote`, line)
        }
        if (/<callout>/.test(text) && !/<callout>([^<>]*)<\/callout>/.test(text)) {
            this.warn(`Malformed callout - expected \`<callout>Text</callout>\` inside the blockquote`, line)
        }
        text = text.replace(/<p>([^<>]*)<\/p>/g, "$1")
        text = text.replace(/<cite>([^<>]+)<\/cite>/g, "$1")
        text = text.replace(/<callout>([^<>]*)<\/callout>/g, "$1")

        const items = this.markdown(text, line)
        if (!items.length) {
            this.warn(`Empty blockquote`, line)
        }
    }

    block_list (block, line, style) {
        let items = block.items ?? []

        if (style.listStyle) {
            items = items.slice(1)
        }

        if (!items.length) {
            this.warn(`List has no items`, line)
            return
        }

        for (const item of items) {
            const itemLine = this.childLine(block, line, item.raw)
            for (const token of item.tokens ?? []) {
                if (token.type === "text" || token.type === "code") {
                    if (/<a>?/.test(token.raw)) {
                        this.warn(`List item contains \`<a\` - HTML is not sanitized in this case, use markdown links instead`, itemLine)
                    } else {
                        this.inline(token.text, itemLine, { where: "List item" })
                    }
                } else if (token.type !== "space") {
                    this.block(token, this.childLine(block, line, token.raw))
                }
            }
        }

        // Multiple choice: every item is a task and the deploy takes the first checked one as the answer
        if (items.length > 1 && items.every(i => i.task)) {
            const checked = items.filter(i => i.checked).length
            if (checked > 1) {
                this.warn(`Multiple choice has ${checked} checked answers - only the first one is used`, line)
            }
        }
    }

    block_table (block, line) {
        const cells = [...(block.header ?? [])]
        for (const row of block.rows ?? []) cells.push(...row)

        for (const cell of cells) {
            if (cell?.text) {
                this.markdown(cell.text, this.childLine(block, line, cell.text))
            }
        }
    }

    block_html (block, line) {
        const raw = block.raw ?? ""

        if (/^\s*<!--/.test(raw)) return

        if (/<(table|img|center|p|(b$)|(i$))>?/.test(raw)) {
            let markdown
            try {
                markdown = NodeHtmlMarkdown.translate(raw).trim()
            } catch (e) {
                this.error(`HTML block could not be converted and is dropped: ${e.message}`, line)
                return
            }

            if (!markdown) {
                this.warn(`HTML block has no content and is dropped`, line)
                return
            }

            const tokens = marked.lexer(markdown).filter(t => t.type !== "space")
            if (tokens.length > 1) {
                this.warn(`HTML block converts to ${tokens.length} blocks but only the first one is kept - use markdown instead`, line)
            }
            if (tokens[0]) {
                this.block(tokens[0], line)
            }
            return
        }

        if (/^<video/.test(raw)) {
            const match = raw.match(/<source[^>]*\s+src=["']([^"']+)["']/i)
            if (!match) {
                this.error(`\`<video>\` block without a \`<source src="...">\` is dropped`, line)
            }
            return
        }

        this.warn(`HTML block is not supported and is dropped by the deploy`, line)
    }

    // ---- custom blocks ----

    block_image (block, line) {
        this.localFile(block.src, line, "Image", { allowDocumentDir: true, dropped: true })
    }

    block_audio (block, line) {
        const caption = (block.raw.match(/^!\s*(a|audio)\s*\[([^\]\n\[]+)\]( *[^\n]*)/) ?? [])[3] ?? ""
        const credits = caption.match(/({\s*"credits"\s*:.*})/)
        if (credits) {
            try {
                JSON.parse(credits[1])
            } catch (e) {
                this.error(`Invalid JSON in audio credits \`${credits[1]}\` (${e.message})`, line)
            }
        }
        this.localFile(block.target, line, "Audio")
    }

    block_video (block, line) {
        this.localFile(block.target, line, "Video")
    }

    block_reference (block, line) {
        const target = parseResourcePath(block.target)

        if (!target.language || !target.type || !target.title) {
            this.error(`Reference \`${block.target}\` is invalid - expected \`language/type/resource[/document[/segment]]\``, line)
            return
        }

        const resourceDir = `${SOURCE_DIR}/${target.language}/${target.type}/${target.title}`
        const documentDir = `${resourceDir}/${target.section ? target.section + "/" : ""}${target.document}`

        let file = `${resourceDir}/${RESOURCE_INFO_FILENAME}`
        if (target.segment) {
            file = `${documentDir}/${target.segment}${SEGMENT_FILENAME_EXTENSION}`
        } else if (target.document) {
            file = `${documentDir}/${DOCUMENT_INFO_FILENAME}`
        }

        if (!fs.pathExistsSync(`${resourceDir}/${RESOURCE_INFO_FILENAME}`)) {
            this.error(`Reference \`${block.target}\` points to a resource that does not exist - the block is dropped`, line)
            return
        }

        if (!fs.pathExistsSync(file)) {
            this.error(`Reference \`${block.target}\` points to \`${file.replace(/^\.\//, "")}\` that does not exist - the block is dropped`, line)
            return
        }

        if (target.segment) {
            try {
                frontMatter(fs.readFileSync(file, "utf-8"))
            } catch (e) {
                this.error(`Reference \`${block.target}\` points to a segment with invalid front matter - the block is dropped`, line)
            }
        }
    }

    block_question (block, line) {
        if (/<a>?/.test(block.text ?? "")) {
            this.error(`Question contains \`<a\` and is rendered empty - use markdown links instead`, line)
            return
        }
        this.inline(block.text, line, { where: "Question" })
    }

    block_excerpt (block, line) {
        let data
        try {
            data = getBibleData(this.pathInfo, block.raw.trim())
        } catch (e) {
            this.warn(`Bible excerpt \`${block.raw.trim()}\` could not be resolved: ${e.message}`, line)
            return
        }
        if (!data?.bibleData?.length) {
            this.warn(`Bible excerpt \`${block.raw.trim()}\` did not match any verses in the configured Bible versions`, line)
        }
    }

    block_collapse (block, line) {
        if (!String(block.caption ?? "").trim()) {
            this.error(`Collapse block without a caption`, line)
        }
        const items = this.markdown(block.text ?? "", line + 1)
        if (!items.length) {
            this.warn(`Empty collapse block`, line)
        }
    }

    block_poll (block, line) {
        const items = this.markdown(block.text ?? "", line + 1)
        if (items.length !== 1 || items[0].type !== "list") {
            this.warn(`Poll should contain exactly one list of options`, line)
        }
    }

    block_carousel (block, line) {
        if (!this.markdown(block.text ?? "", line + 1).length) {
            this.warn(`Empty carousel`, line)
        }
    }

    block_slide (block, line) {
        if (!this.markdown(block.text ?? "", line + 1).length) {
            this.warn(`Empty slide`, line)
        }
    }

    block_story (block, line) {
        const items = this.markdown(block.text ?? "", line + 1)
        if (!items.length) {
            this.warn(`Empty story`, line)
        }
    }

    block_story_slide (block, line) {
        const items = this.markdown(block.text ?? "", line + 1)
        const image = items.find(b => b.type === "image")
        const paragraph = items.find(b => b.type === "paragraph")

        if (!image || !paragraph) {
            this.error(`Story slide requires both an image and a paragraph - the slide is dropped`, line)
        }
    }
}

export { typefacesOf, isURL }
export { LEVEL }
