import { parseSegment } from "../blocks.js"
import { paragraph } from "./index.js"

export const question = {
    extension: {
        name: "question",
        level: "block",
        tokenizer(src, tokens) {
            const rule = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/
            const match = rule.exec(src);
            if (match) {
                return {
                    type: "question",
                    raw: match[0],
                    text: match[0].replace(/(^`)|(`$)/g, "").trim()
                }
            }
        },

        renderer(token) {
            // TODO: for web rendering
            return `TODO: reference`;
        }
    },
    process: async function (block, resourcePath) {
        let questionText = await paragraph.process({ id: block.id, text: block.text}, resourcePath, 1)

        let ret = { id: block.id, type: block.type, markdown: questionText.markdown ? `**${questionText.markdown}**` : '' }
        if (questionText.data) { ret.data = questionText.data }
        return ret
    },
}