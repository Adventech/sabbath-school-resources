import { parseSegment } from "../blocks.js"
import crypto from "crypto"

export const table = {
    extension: {},
    process: async function (block, resourcePath) {
        let header = []
        let rows = []

        let processRows = async function(_rows, rowIndex) {
            let r = []
            for (let [columnIndex, row] of _rows.entries()) {
                let items = await parseSegment(row.text, resourcePath, `${block.id}-${JSON.stringify(_rows)}-${rowIndex}-${columnIndex}`)

                for (let [index, item] of items.entries()) {
                    items[index].id = crypto.createHash("sha256").update(
                        `${block.id}-${JSON.stringify(_rows)}-${rowIndex}-${columnIndex}-${index}`
                    ).digest("hex")
                    items[index].nested = false
                }

                r.push({ items })
            }
            return r
        }

        if (block.header) {
            header = await processRows(block.header)
        }

        if (block.rows) {
            for (let [rowIndex, row] of block.rows.entries()) {
                rows.push({ items: await processRows(row, rowIndex) })
            }
        }

        return { id: block.id, type: block.type, rows, header }
    },
}