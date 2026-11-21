// Protects existing hyperlinks from Bible / EGW reference detection.
// Without this, text like [About Daniel 1](https://...) becomes
// [About [Daniel 1](sspmBible://Dan1)](https://...) — a nested, broken link.

const LINK_PATTERNS = [
    // HTML anchors: <a ...>...</a>
    /<a\b[^>]*>[\s\S]*?<\/a>/gi,
    // Markdown inline links and images (allows one level of nested brackets in text): [text](url "title")
    /!?\[(?:[^\[\]]|\[[^\[\]]*\])*\]\((?:[^()\s]|\([^()]*\))*(?:\s+(?:"[^"]*"|'[^']*'))?\)/g,
    // Markdown reference links: [text][ref]
    /!?\[(?:[^\[\]]|\[[^\[\]]*\])*\]\[[^\[\]]*\]/g,
    // Autolinks: <https://...>
    /<(?:https?|mailto|ftp):[^\s<>]*>/gi,
    // Bare URLs
    /\b(?:https?:\/\/|www\.)[^\s<>()]*[^\s<>().,;:!?'"]/gi,
]

// Private-use code points: never matched by Bible or EGW parsers
const MARK = ""
const DIGIT_BASE = 0xE010

const encodeIndex = (i) => String(i).split("").map(d => String.fromCharCode(DIGIT_BASE + Number(d))).join("")
const TOKEN_RE = new RegExp(`${MARK}([\\uE010-\\uE019]+)${MARK}`, "g")

export const protectLinks = function (text) {
    const links = []
    if (typeof text !== "string" || !text.length) return { text, links }

    let masked = text
    for (const pattern of LINK_PATTERNS) {
        masked = masked.replace(pattern, (match) => {
            links.push(match)
            return `${MARK}${encodeIndex(links.length - 1)}${MARK}`
        })
    }
    return { text: masked, links }
}

export const restoreLinks = function (text, links) {
    if (typeof text !== "string" || !links?.length) return text
    // Restore repeatedly: an outer link may contain the token of an inner one
    let restored = text
    let previous
    do {
        previous = restored
        restored = restored.replace(TOKEN_RE, (_, enc) => {
            const index = Number(enc.split("").map(c => c.charCodeAt(0) - DIGIT_BASE).join(""))
            return links[index] ?? ""
        })
    } while (restored !== previous)
    return restored
}
