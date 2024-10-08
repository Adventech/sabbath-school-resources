import { getBibleData } from "../bible.js"
import crypto from "crypto"
import { parseSegment } from "../blocks.js"

export const excerpt = {
    extension: {
        name: "excerpt",
        level: "block",
        tokenizer(src, tokens) {
            const rule = /^\[\[([^\]]+)\]\]/g
            const match = rule.exec(src);
            if (match) {
                return {
                    type: "excerpt",
                    raw: match[0],
                };
            }
        },
        renderer(token) {
            // TODO: for web rendering
            return `TODO: excerpt`;
        }
    },
    process: async function (block, resourcePath) {
        let r =  { id: block.id, type: block.type, markdown: block.raw.trim() }

        const bibleData = getBibleData(resourcePath, block.raw.trim())

        if (bibleData.bibleData) {
            r.options = [...new Set(bibleData.bibleData.map(obj => obj.name))];
            r.items = []
            let documentIndex = `${resourcePath.language}/${resourcePath.type}/${resourcePath.name}/content/${resourcePath.section ? resourcePath.section + "/" : ""}${resourcePath.document}`
            for (const [index, passageArray] of bibleData.bibleData.entries()) {
                let item = {
                    id: crypto.createHash("sha256").update(`${documentIndex}-${r.id}-${block.type}-${index}`).digest("hex"),
                    option: passageArray.name,
                    type: "excerpt-item",
                    nested: true,
                }
                let markdown = ""
                for (let verse of Object.keys(passageArray.verses)) {
                    markdown += passageArray.verses[verse] + "\n\n"
                }
                markdown = markdown.replace(/\n\n$/mg, '')

                item.items = await parseSegment(markdown, resourcePath, item.id, "no-bible")

                if (item.items.length && item.items[0].type === "heading") {
                    item.items.shift()
                }

                r.items.push(item)
            }
        }

        return r
    },
}