import { NodeHtmlMarkdown } from 'node-html-markdown'
import { parseBlock, parseSegment } from "../blocks.js"

export const html = {
    extension: {},
    process: async function (block, resourcePath) {
        if (/<(table|img|center)>?/g.test(block.raw)) {
            try {
                let ret = (await parseSegment(NodeHtmlMarkdown.translate(block.raw), resourcePath))[0] ?? null

                return { ...ret, id: block.id }
            } catch (e) {
                console.info(`Error occurred parsing HTML table, skipping`, e)
            }

            return false
        }
        return false
    },
}