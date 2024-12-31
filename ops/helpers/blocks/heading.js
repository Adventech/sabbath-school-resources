import { superscript } from "./superscript.js"
import { sanitize } from "./sanitize.js"

export const heading = {
    extension: {},
    process: async function (block, resourcePath) {
        let text = superscript(block.text.trim())
        text = sanitize(text)
        return { id: block.id, type: block.type, markdown: text, depth: block.depth  }
    },
}