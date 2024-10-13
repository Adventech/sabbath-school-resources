import { getBibleData } from "../bible.js"
import { getEGWData } from "../egw.js"
import crypto from "crypto"
import { parseSegment } from "../blocks.js"
import { completion } from "./completion.js"

export const paragraph = {
    extension: {},
    process: async function (block, resourcePath, depth) {
        let text = block.text.trim()

        if (/<a>?/g.test(block.raw)) {
            return false
        }

        const bibleData = depth !== "no-bible" ? getBibleData(resourcePath, text) : null

        let r =  { id: block.id, type: block.type, markdown: text }

        let documentIndex = `${resourcePath.language}/${resourcePath.type}/${resourcePath.name}/${resourcePath.section ? resourcePath.section + "/" : ""}${resourcePath.document}/${resourcePath.segment}`
        if (bibleData && bibleData.bibleData.length) {
            r["markdown"] = bibleData.text

            r.data = { bible: {} }
            let index = 0

            let detectedVerses = [...new Set(bibleData.bibleData.flatMap(item => Object.keys(item.verses)))]

            for (let verse of detectedVerses) {
                let excerpt = {
                    id: crypto.createHash("sha256").update(`${documentIndex}-${r.id}-excerpt-${index}`).digest("hex"),
                    type: "excerpt",
                    items: [],
                    options: [...new Set(bibleData.bibleData.map(obj => obj.name))],
                }

                for (let passageArray of bibleData.bibleData) {
                    let item = {
                        id: crypto.createHash("sha256").update(`${documentIndex}-${r.id}-excerpt-${index}-${r.type}-${index}`).digest("hex"),
                        option: passageArray.name,
                        type: "excerpt-item",
                        nested: true
                    }
                    let markdown = passageArray.verses[verse]

                    item.items = await parseSegment(markdown, resourcePath, item.id, "no-bible")
                    excerpt.items.push(item)
                    index++

                }
                r.data.bible[verse] = excerpt
            }
        }

        const egwData = depth !== "no-bible" ? await getEGWData(resourcePath, r.markdown) : null

        if (egwData && Object.keys(egwData?.data?.egw).length) {
            if (!r["data"]) { r["data"] = {}}

            r["data"]["egw"] = {}

            let index = 0
            for (let egwReferenceKey of Object.keys(egwData.data.egw)) {
                r.data.egw[egwReferenceKey] = [{
                    id: crypto.createHash("sha256").update(`${documentIndex}-${r.id}-egw-${index}-${r.type}-${index}-${egwReferenceKey}-reference`).digest("hex"),
                    type: "heading",
                    markdown: egwData.data.reference[egwReferenceKey],
                    depth: 3,
                }]

                let paragraphs = egwData.data.egw[egwReferenceKey].split("\n\n")

                for (const [indexParagraph, paragraph] of paragraphs.entries()) {
                    let paragraphBlock = {
                        id: crypto.createHash("sha256").update(`${documentIndex}-${r.id}-egw-${index}-${r.type}-${index}-${indexParagraph}`).digest("hex"),
                        type: "paragraph",
                        markdown: paragraph
                    }
                    r.data.egw[egwReferenceKey].push(paragraphBlock)
                }

                index++
            }

            r["markdown"] = egwData.output
        }

        const completionRet = await completion.process(r.markdown, r.id)

        if (completionRet) {
            r.markdown = completionRet.text
            r.data = { ...r.data, completion: completionRet.data }
        }

        return r
    },
}