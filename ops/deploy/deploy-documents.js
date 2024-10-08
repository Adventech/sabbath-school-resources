#!/usr/bin/env node
"use strict"

import crypto from "crypto"
import yaml from "js-yaml"
import fs from "fs-extra"
import frontMatter from "front-matter"
import { fdir } from "fdir"
import { isMainModule, parseResourcePath, deepMerge } from "../helpers/helpers.js"
import { parseSegment } from "../helpers/blocks.js"
import { database } from "../helpers/firebase.js"
import {
    SOURCE_DIR,
    API_DIST,
    RESOURCE_TYPE,
    SEGMENT_TYPES,
    FIREBASE_DATABASE_BLOCKS,
    DEPLOY_ENV,
    GLOBAL_ASSETS_DIR,
    ASSETS_URL,
    RESOURCE_PDF_FILENAME,
    DOCUMENT_INFO_FILENAME, MEDIA_URL, SEGMENT_FILENAME_EXTENSION, RESOURCE_ASSETS_DIRNAME
} from "../helpers/constants.js"
import { SEGMENT_DEFAULT_BLOCK_STYLES } from "../helpers/styles.js"

let getDocumentInfoFromPDF = async function (pdf) {
    const pdfPathInfo = parseResourcePath(document)
    const documentInfo = {}
    // documentInfo.id = `${pdfPathInfo.language}-${pdfPathInfo.type}-${pdfPathInfo.title}-${DOCUMENT_CONTENT_DIRNAME}-${SECTION_DEFAULT_NAME}-${documentPathInfo.document}`
}

let getDocumentInfoYml = async function (document) {
    const documentInfo = yaml.load(fs.readFileSync(document, "utf8"));
    const documentPathInfo = parseResourcePath(document)

    documentInfo.id = `${documentPathInfo.language}-${documentPathInfo.type}-${documentPathInfo.title}-${documentPathInfo.section ? documentPathInfo.section + "-" : ""}${documentPathInfo.document}`
    documentInfo.resourceId = `${documentPathInfo.language}-${documentPathInfo.type}-${documentPathInfo.title}`
    documentInfo.resourceIndex = `${documentPathInfo.language}/${documentPathInfo.type}/${documentPathInfo.title}`
    documentInfo.index = `${documentPathInfo.language}/${documentPathInfo.type}/${documentPathInfo.title}/${documentPathInfo.section ? documentPathInfo.section + "-" : ""}${documentPathInfo.document}`
    documentInfo.name = `${documentPathInfo.document}`

    if (documentInfo.chips) {
        documentInfo.showSegmentChips = true
        delete documentInfo.chips
    }

    if (!documentInfo.cover && fs.pathExistsSync(`${GLOBAL_ASSETS_DIR}/images/${documentPathInfo.type}/${documentPathInfo.title}/${documentPathInfo.section ? documentPathInfo.section + "/" : ""}${documentPathInfo.document}/cover.png`)) {
        documentInfo.cover = `${ASSETS_URL}/assets/images/${documentPathInfo.type}/${documentPathInfo.title}/${documentPathInfo.section ? documentPathInfo.section + "/" : ""}${documentPathInfo.document}/cover.png`
    }

    return documentInfo
}

let getSegmentInfo = async function (segment, processBlocks = false) {
    const segmentFile = fs.readFileSync(segment, "utf8");
    const segmentInfoFrontMatter = frontMatter(segmentFile)
    const segmentPathInfo = parseResourcePath(segment)

    const segmentInfo = {
        ...segmentInfoFrontMatter.attributes,
    }

    let segmentFilterForType = {
        "block": (b) => b.type !== "space",
        "story": (b) => {
            return b.type === "story"
        }
    }

    if (!segmentInfo.type) {
        segmentInfo.type = SEGMENT_TYPES.BLOCK
    }

    segmentInfo.id = `${segmentPathInfo.language}-${segmentPathInfo.type}-${segmentPathInfo.title}-${segmentPathInfo.section ? segmentPathInfo.section + "-" : ""}${segmentPathInfo.document}-${segmentPathInfo.segment}`
    segmentInfo.resourceId = `${segmentPathInfo.language}-${segmentPathInfo.type}-${segmentPathInfo.title}`
    segmentInfo.index = `${segmentPathInfo.language}/${segmentPathInfo.type}/${segmentPathInfo.title}/${segmentPathInfo.section ? segmentPathInfo.section + "-" : ""}${segmentPathInfo.document}/${segmentPathInfo.segment}`
    segmentInfo.name = `${segmentPathInfo.segment}`

    if (segmentInfo.pdf) {
        segmentInfo.type = SEGMENT_TYPES.PDF
        for (let pdf of segmentInfo.pdf) {
            pdf.id = crypto.createHash("sha256").update(
                `${segmentInfo.id}-${pdf.src}`
            ).digest("hex")
        }
    }

    if (segmentInfo.video) {
        segmentInfo.type = SEGMENT_TYPES.VIDEO

        for (let video of segmentInfo.video) {
            video.id = crypto.createHash("sha256").update(
                `${segmentInfo.id}-${video.src}`
            ).digest("hex")
        }
    }

    if (processBlocks) {
        segmentInfo.blocks = await parseSegment(segmentInfoFrontMatter.body, segmentPathInfo, "root", 1, segmentFilterForType[segmentInfo.type])
    }

    if (DEPLOY_ENV === "local") {
        if (segmentInfo.cover && !/^http/.test(segmentInfo.cover)) {
            segmentInfo.cover = `${MEDIA_URL}/${segmentPathInfo.language}/${segmentPathInfo.type}/${segmentPathInfo.title}/${RESOURCE_ASSETS_DIRNAME}/${segmentInfo.cover}`
        }

        if (segmentInfo.background && !/^http/.test(segmentInfo.background)) {
            segmentInfo.background = `${MEDIA_URL}/${segmentPathInfo.language}/${segmentPathInfo.type}/${segmentPathInfo.title}/${RESOURCE_ASSETS_DIRNAME}/${segmentInfo.background}`
        }

        if (segmentInfo.audio && segmentInfo.audio.src && !/^http/.test(segmentInfo.audio.src)) {
            segmentInfo.audio.src = `${MEDIA_URL}/${segmentPathInfo.language}/${segmentPathInfo.type}/${segmentPathInfo.title}/${RESOURCE_ASSETS_DIRNAME}/${segmentInfo.audio.src}`
        }
    }

    return segmentInfo
}

let processPDFOnlyResource = async function (resource, returnOnly) {
    let resourcePathInfo = parseResourcePath(resource)
    const pdfFile = yaml.load(fs.readFileSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${RESOURCE_PDF_FILENAME}`, "utf8"))
    const documents = []
    const pdfsForDocument = {}

    for (let [i, pdf] of pdfFile.pdf.entries()) {
        if (!pdf.title || !pdf.src) { continue }

        if (!pdf.target) {
            pdf.target = `${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${String(i+1).padStart(2, '0')}`
        }

        pdf.id = crypto.createHash('sha256').update(pdf.target + pdf.src).digest('hex')
        pdf.targetIndex = pdf.target.replace(/\//g, '-')
        pdf.src = `${MEDIA_URL}/pdf/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${pdf.id}/${pdf.id}.pdf`

        if (!pdfsForDocument[pdf.target]) {
            pdfsForDocument[pdf.target] = [pdf]
        } else {
            pdfsForDocument[pdf.target].push(pdf)
        }
    }

    for (let pdfTarget of Object.keys(pdfsForDocument)) {
        const pdfs = pdfsForDocument[pdfTarget]
        if (!pdfs.length) continue
        const documentPathInfo = parseResourcePath(`${pdfs[0].target}/${DOCUMENT_INFO_FILENAME}`)
        const segmentPathInfo = parseResourcePath(`${pdfs[0].target}/${documentPathInfo.document}.md`)
        const documentInfo = {
            title: pdfs[0].title,
            id: `${documentPathInfo.language}-${documentPathInfo.type}-${documentPathInfo.title}-${documentPathInfo.section ? documentPathInfo.section + "-" : ""}${documentPathInfo.document}`,
            resourceId: `${documentPathInfo.language}-${documentPathInfo.type}-${documentPathInfo.title}`,
            index: `${documentPathInfo.language}/${documentPathInfo.type}/${documentPathInfo.title}/${documentPathInfo.section ? documentPathInfo.section + "-" : ""}${documentPathInfo.document}`,
            name: `${documentPathInfo.document}`,
            segments: [
                {
                    title: pdfs[0].title,
                    type: "pdf",
                    id: `${segmentPathInfo.language}-${segmentPathInfo.type}-${segmentPathInfo.title}-${segmentPathInfo.section ? segmentPathInfo.section + "-" : ""}${segmentPathInfo.document}-${segmentPathInfo.segment}`,
                    resourceId: `${segmentPathInfo.language}-${segmentPathInfo.type}-${segmentPathInfo.title}`,
                    index: `${segmentPathInfo.language}/${segmentPathInfo.type}/${segmentPathInfo.title}/${segmentPathInfo.section ? segmentPathInfo.section + "-" : ""}${segmentPathInfo.document}/${segmentPathInfo.segment}`,
                    name: `${segmentPathInfo.segment}`,
                    pdf: pdfs,
                }
            ],
        }

        if (!returnOnly) {
            fs.outputFileSync(`${API_DIST}/${documentPathInfo.language}/${documentPathInfo.type}/${documentPathInfo.title}/${documentPathInfo.section ? documentPathInfo.section + "-" : ""}${documentPathInfo.document}/index.json`, JSON.stringify(documentInfo))
        } else {
            documents.push(documentInfo)
        }
    }

    if (returnOnly) {
        return documents
    }
}

// TODO: instead of wildcard for the resource glob, process only the ones that are in the git change
//       if more than lets say 20 then use **
let processDocuments = async function (resourceType) {

    const resources = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(7)
        .glob(`**/${resourceType}/*/info.yml`)
        .crawl(SOURCE_DIR)
        .sync();

    for (let resource of resources) {
        let resourcePathInfo = parseResourcePath(`${SOURCE_DIR}/${resource}`)
        const resourceInfoYaml = yaml.load(fs.readFileSync(`${SOURCE_DIR}/${resource}`, "utf8"));

        const documents = new fdir()
            .withBasePath()
            .withRelativePaths()
            .withMaxDepth(5)
            .glob(`**/${resourceType}/${resourcePathInfo.title}/*/**/info.yml`)
            .crawl(SOURCE_DIR)
            .sync();

        const pdfFilePath = `${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${RESOURCE_PDF_FILENAME}`

        if (!documents.length
            && fs.pathExistsSync(pdfFilePath)) {
            await processPDFOnlyResource(`${SOURCE_DIR}/${resource}`)
        }

        for (let document of documents) {
            let documentInfo = await getDocumentInfoYml(`${SOURCE_DIR}/${document}`, true)
            let documentPathInfo = parseResourcePath(document)

            documentInfo.segments = []

            const segments = new fdir()
                .withBasePath()
                .withRelativePaths()
                .glob(`*${SEGMENT_FILENAME_EXTENSION}`)
                .crawl(`${SOURCE_DIR}/${document.replace(/info.yml/g, '')}`)
                .sync();

            for (let segment of segments) {
                let segmentInfo = await getSegmentInfo(`${SOURCE_DIR}/${document.replace(/info.yml/g, '')}${segment}`, true)
                let segmentPathInfo = parseResourcePath(`${SOURCE_DIR}/${document.replace(/info.yml/g, '')}${segment}`)

                let setBlockInDatabase = async function (block) {
                    if (block.items && block.items.length) {
                        for (let itemBlock of block.items) {
                            if (itemBlock && itemBlock.id) {
                                await setBlockInDatabase(itemBlock)
                            }
                        }
                    }
                    if (block && block.id) {
                        await database.collection(FIREBASE_DATABASE_BLOCKS).doc(block.id).set(block);
                    }
                }

                if (segmentInfo.blocks) {
                    for (let block of segmentInfo.blocks) {
                        await setBlockInDatabase(block)
                    }
                }

                // await database.collection(FIREBASE_DATABASE_SEGMENTS).doc(segmentInfo.id).set(segmentInfo)

                // skipping hidden segments
                if (!/^_/.test(segment)) {
                    documentInfo.segments.push(segmentInfo)
                }
                fs.outputFileSync(`${API_DIST}/${segmentPathInfo.language}/${resourceType}/${segmentPathInfo.title}/${segmentPathInfo.section ? segmentPathInfo.section + "-" : ""}${segmentPathInfo.document}/${segmentPathInfo.segment}/index.json`, JSON.stringify(segmentInfo))
            }

            // await database.collection(FIREBASE_DATABASE_DOCUMENTS).doc(documentInfo.id).set(documentInfo)

            let style = deepMerge(SEGMENT_DEFAULT_BLOCK_STYLES, resourceInfoYaml.style)
            documentInfo.style = deepMerge(style, documentInfo.style)

            fs.outputFileSync(`${API_DIST}/${documentPathInfo.language}/${resourceType}/${documentPathInfo.title}/${documentPathInfo.section ? documentPathInfo.section + "-" : ""}${documentPathInfo.document}/index.json`, JSON.stringify(documentInfo))
        }
    }
}

if (isMainModule(import.meta)) {
    Object.keys(RESOURCE_TYPE).map(async (key) => {
        await processDocuments(RESOURCE_TYPE[key])
    })
}

export {
    getSegmentInfo,
    getDocumentInfoYml,
    processPDFOnlyResource,
}