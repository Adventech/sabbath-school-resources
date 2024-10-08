import crypto from "crypto"
import { parseBlock } from "../blocks.js"
import { paragraph } from "./paragraph.js"

/**
 * List
 * Checklist
 * Multiple-choice
 * Appeal
 * List inside POLL is a list of poll options
 */

export const list = {
    extension: {},
    process: async function (block, resourcePath, depth) {
        let blockData = { id: block.id, type: block.type, items: [], ordered: block.ordered, start: block.start || 0 }

        for (let [index, listItem] of block.items.entries()) {
            let documentIndex = `${resourcePath.language}/${resourcePath.type}/${resourcePath.name}/${resourcePath.section ? resourcePath.section + "/" : ""}${resourcePath.document}`

            for (let token of listItem.tokens) {
                if (token.type === "text") {
                    let listItemId = crypto.createHash("sha256").update(
                        `${documentIndex}-${block.id}-${token.type}-${index}`
                    ).digest("hex")

                    let p = await paragraph.process(token, resourcePath)

                    blockData.items.push({
                        "type": "list-item",
                        "markdown": p.markdown ?? token.text.trim(),
                        "index": index,
                        "id": listItemId,
                        "data": p.data ?? null,
                        "nested": true,
                    })
                } else {
                    blockData.items.push(
                        await parseBlock(token, resourcePath, index, block.id, depth+1)
                    )
                }
            }
        }

        // Appeal
        if (block.items.length === 1 && block.items[0].task) {
            return { id: block.id, type: "appeal", markdown: block.items[0].text }
        }

        // Checklist
        if (block.items.length > 1) {
            let multiAppeal = true
            for (let item of block.items) {
                if (item.type !== "list_item") {
                    multiAppeal = false
                    break
                }

                if (item.checked) {
                    multiAppeal = false
                    break
                }

                if (!item.task) {
                    multiAppeal = false
                    break
                }
            }
            if (multiAppeal) {
                for (let i = 0; i < blockData.items.length; i++) {
                    if (blockData.items[i].type === 'list-item') {
                        blockData.items[i].type = 'list-item-checklist'
                    }
                }
                return { ...blockData, type: "checklist" }
            }
        }

        // Multiple choice

        if (block.items.length > 1) {
            let multipleChoice = true
            let checkedNum = 0
            let answer
            for (let [i, item] of block.items.entries()) {
                if (item.type !== "list_item") {
                    multipleChoice = false
                    break
                }

                if (item.checked) {
                    checkedNum++
                    answer = i
                    break
                }

                if (!item.task) {
                    multipleChoice = false
                    break
                }
            }
            if (multipleChoice && checkedNum === 1) {
                for (let i = 0; i < blockData.items.length; i++) {
                    if (blockData.items[i].type === 'list-item') {
                        blockData.items[i].type = 'list-item-choice'
                    }
                }
                return { ...blockData, answer: answer, type: "multiple-choice" }
            }
        }

        return { ...blockData, depth }
    },
}