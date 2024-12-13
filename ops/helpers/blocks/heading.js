import { superscript } from "./superscript.js"

export const heading = {
    extension: {},
    process: async function (block, resourcePath) {
        return { id: block.id, type: block.type, markdown: superscript(block.text.trim()), depth: block.depth  }
    },
}