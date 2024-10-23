import { parseSegment } from "../blocks.js"

export const blockquote = {
    extension: {},
    process: async function (block, resourcePath) {
        let blockquote = { id: block.id, type: block.type }

        // memory-verse
        const memoryVerseRegex = /<p>([^<>]*)<\/p>/g
        let memoryVerse = memoryVerseRegex.exec(block.text)
        if (memoryVerse) {
            block.text = block.text.replace(memoryVerseRegex, "").trim()
            block.text = `${block.text}`

            if (memoryVerse[1]?.length) {
                block.text = `**${memoryVerse[1]}**\n\n${block.text}`
            }

            blockquote.memoryVerse = true
        }

        // citation
        const citationRegex = /<cite>([^<>]+)<\/cite>/g
        let citation = citationRegex.exec(block.text)
        if (citation) {
            block.text = block.text.replace(citationRegex, "").trim()
            block.text = `${block.text}\n\n_${citation[1]}_`
            blockquote.citation = true
        }

        // callout
        const calloutRegex = /<callout>([^<>]+)<\/callout>/g
        let callout = calloutRegex.exec(block.text)
        if (callout) {
            block.text = block.text.replace(calloutRegex, "").trim()
            block.text = `${block.text}\n\n_${callout[1]}_`
            blockquote.callout = true
        }

        let items = await parseSegment(block.text, resourcePath, block.id)

        if (blockquote.callout) {
            items.map((item, i) => {
                if (item.type === "paragraph") {
                    item.style = item.style || {}
                    item.style.text = item.style.text || {}
                    item.style.text.align = "center"
                    if (i < items.length-1) {
                        item.style.text.size = "lg"
                    }
                }
            })
        }

        return {...blockquote, items }
    }
}