import { NodeHtmlMarkdown } from 'node-html-markdown'
import { parseSegment } from "../blocks.js"

export const html = {
    extension: {},
    process: async function (block, resourcePath) {
        if (/<(table|img|center|p|(b$)|(i$))>?/g.test(block.raw)) {
            try {
                if (NodeHtmlMarkdown.translate(block.raw).trim() === '') {
                    return false
                }

                let ret = (await parseSegment(NodeHtmlMarkdown.translate(block.raw), resourcePath))[0] ?? null

                return { ...ret, id: block.id }
            } catch (e) {
                console.info(`Error occurred parsing HTML table, skipping`, e)
            }
        }

        if (/^<video/g.test(block.raw)) {
            try {
                const match = block.raw.match(/<source[^>]*\s+src=["']([^"']+)["']/i)

                const src = match ? match[1] : null

                if (!src) {
                    throw new Error('empty src attribute')
                }

                let ret = (await parseSegment(`!v[${src}]`, resourcePath))[0] ?? null

                return { ...ret, id: block.id }
            } catch (e) {
                console.info(`Error occurred parsing HTML table, skipping`, e)
            }
        }

        return false
    },
}