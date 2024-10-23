import { parseSegment } from "../blocks.js"

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
        let questionText = await parseSegment(block.text, resourcePath, block.id)
        if (!questionText.length) {
            questionText = [{markdown: block.text}]
        }
        let ret = { id: block.id, type: block.type, markdown: questionText[0].markdown ? `**${questionText[0].markdown}**` : '' }
        if (questionText[0].data) { ret.data = questionText[0].data }
        return ret
    },
}