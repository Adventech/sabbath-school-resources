import crypto from "crypto"
import { marked } from "marked"
import { story, storySlide, carousel, slide, image, collapse, audio, video, reference, question, blockquote, hr, heading, list, paragraph, poll, style, excerpt, table, html } from "./blocks/index.js"

marked.use({
    extensions: [
        story.extension,
        storySlide.extension,
        carousel.extension,
        slide.extension,
        question.extension,
        collapse.extension,
        image.extension,
        audio.extension,
        video.extension,
        reference.extension,
        poll.extension,
        excerpt.extension
    ]
});

let parseBlock = async function (block, resourcePath, index, parentId, depth) {
    let blockStyleReturn = style(block)
    let blockStyle = blockStyleReturn.blockStyle

    let documentIndex = `${resourcePath.language}/${resourcePath.type}/${resourcePath.name}/content/${resourcePath.section ? resourcePath.section + "/" : ""}${resourcePath.document}/${resourcePath.segment}`

    block.id = crypto.createHash("sha256").update(
        `${documentIndex}-${parentId}-${block.type}-${index}`
    ).digest("hex")

    const supportedBlockTypes = {
        story,
        'story-slide': storySlide,
        blockquote,
        audio,
        video,
        image,
        question,
        collapse,
        carousel,
        slide,
        hr,
        reference,
        paragraph,
        heading,
        list,
        poll,
        excerpt,
        table,
        html,
    }

    if (supportedBlockTypes[block.type]) {
        let processedBlock = await supportedBlockTypes[block.type].process(block, resourcePath, depth)

        // In certain cases we might decide that we should skip this block, i.e image is referencing local file that
        // does not exist. In this case we will skip it
        if (!processedBlock) { return null }

        if (parentId !== "root") {
            processedBlock.nested = true
        }

        return { ...processedBlock, ...blockStyle }
    }

    // If for some reason we encountered a markdown block that we do not know, returning null, i.e skipping
    return null
}

let parseSegment = async function (segment, resourcePath, parentId, depth, filter = (b) => b.type !== "space") {
    const blocks = marked.lexer(segment).filter(filter)
    let blocksData = []

    for (let [index, block] of blocks.entries()) {
        let indexHash = blocks.filter(b => b.type === block.type).findIndex(b => b === block)
        let blockData = await parseBlock(block, resourcePath, indexHash >= 0 ? indexHash : index, parentId ?? "root", depth ?? 1)

        if (blockData) {
            blocksData.push(blockData)
        }
    }

    return blocksData
}

export {
    marked,
    parseSegment,
    parseBlock
}