#!/usr/bin/env node
"use strict"

import fs from "fs-extra"
import { fdir } from "fdir"
import { Validator } from "jsonschema"
import { getResourceInfo } from "../deploy/deploy-resources.js"
import { getSectionInfo } from "../deploy/deploy-sections.js"
import { arg, isMainModule, parseResourcePath } from "../helpers/helpers.js"
import {
    SOURCE_DIR,
    RESOURCE_TYPE,
    RESOURCE_KIND,
    RESOURCE_INFO_FILENAME,
    SECTION_INFO_FILENAME,
    RESOURCE_ASSETS_DIRNAME, RESOURCE_COVERS, SEGMENT_FILENAME_EXTENSION, API_DIST
} from "../helpers/constants.js"
import { getDocumentInfoYml, getSegmentInfo } from "../deploy/deploy-documents.js"
import { runValidation } from "./validation-runner.js"
import dayjs from "dayjs"
import isBetween from "dayjs/plugin/isBetween.js"
import customParseFormat from "dayjs/plugin/customParseFormat.js"
dayjs.extend(isBetween)
dayjs.extend(customParseFormat)


let failMessages = []

let fail = function (message) {
    failMessages.push(message)
}

const resourceSchema = {
    "$id": "/schemas/resource",
    "type": "object",
    "additionalProperties": false,
    "properties": {
        "id": { type: "string", },
        "name": { type: "string", },
        "type": { type: "string", },
        "index": { type: "string", },
        "title": { type: "string", },
        "markdownTitle": { type: "string", },
        "markdownSubtitle": { type: "string", },
        "markdownDescription": { type: "string", },
        "subtitle": { type: "string", },
        "description": { type: "string", },
        "kind": {
            type: "string",
            enum: [
                RESOURCE_KIND.BOOK,
                RESOURCE_KIND.DEVOTIONAL,
                RESOURCE_KIND.PLAN,
                RESOURCE_KIND.EXTERNAL,
                RESOURCE_KIND.BLOG,
            ]
        },
        "credits": { type: "array", },
        "features": { type: "array", },
        "primaryColor": { type: "string", },
        "primaryColorDark": { type: "string", },
        "startDate": { type: "string", },
        "endDate": { type: "string", },
        "author": { type: "string", },
        "categories": { type: "array", },
        "featuredResources": { type: "array", items: {"$ref": "/schemas/resource" }},
        "covers": {
            type: "object",
            additionalProperties: false,
            properties: {
                portrait: { type: "string" },
                landscape: { type: "string" },
                square: { type: "string" },
                splash: { type: "string" },
            }
        },
        "fonts": {
            "$ref": "/schemas/fonts",
        },
        "documentId": { type: "string" },
        "documentIndex": { type: "string" },
        "externalURL": { type: "string" },
        "preferredCover": { type: "string" },
        "featuredResourcesView": { type: "string" },
        "progressTracking": { type: "string" },
        "displayProgress": { type: "boolean" },
        "introduction": { type: "string" },
        "cta": {
            type: "object",
            additionalProperties: false,
            properties: {
                "hidden": { type: "boolean" },
                "text": { type: "string" },
            }
        },

        "style": { type: "object" },
    },
    "required": [ "id", "name", "type", "index", "kind", "title", "primaryColor", "primaryColorDark", "covers" ],
    "if": {
        "not": {
            "properties": {
                "kind": { "const": "external" }
            },
        }
    },
}

const fontsSchema = {
    "$id": "/schemas/fonts",
    "type": "array",
    "items": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string" },
          "src": { "type": "string" },
          "weight": { "type": "number" },
        },
    },
}

const sectionSchema = {
    "$id": "/schemas/section",
    "type": "object",
    "additionalProperties": false,
    "properties": {
        "title": { type: "string", },
        "name": { type: "string", },
        "displaySequence": { type: "boolean", },
        "isRoot": { type: "boolean", },
    },
    "required": [ "title", "name" ]
}

const validator = new Validator()
validator.addSchema(fontsSchema, "/schemas/fonts")

// TODO: add feed validation for categories, authors and resource roots
let validateResources = async function (language, resourceType, resourcesG) {
    const resources = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(3)
        .glob(`${language}/${resourceType}/${resourcesG}/${RESOURCE_INFO_FILENAME}`)
        .crawl(SOURCE_DIR)
        .sync()

    for (let resource of resources) {
        let resourceInfo
        let resourcePathInfo

        try {
            resourcePathInfo = parseResourcePath(resource)
        } catch (e) {
            e = e.toString().replace(/\n/g, "<br>")
            fail(`Critical error. Can not parse the resource path: ${resource}. Error: \`${e}\``)
            continue
        }

        try {
            resourceInfo = await getResourceInfo(`${SOURCE_DIR}/${resource}`)
        } catch (e) {
            e = e.toString().replace(/\n/g, "<br>")
            fail(`Critical error. Can not parse the resource info: ${resource}. Error: \`${e}\``)
            continue
        }

        try {
            const resourceContentPath = `${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}`
            const sections = new fdir()
                .withBasePath()
                .withRelativePaths()
                .withMaxDepth(15)
                .glob(`${resourceContentPath}/**/${SECTION_INFO_FILENAME}`)
                .crawl(".")
                .sync()

            for (let section of sections) {
                const sectionInfo = await getSectionInfo(`${section}`)

                let validateResult = validator.validate(sectionInfo, sectionSchema)
                if (validateResult.errors.length) {
                    let errors = ""
                    validateResult.errors.map(e => {
                        errors += `${e.stack} <br/>`
                    })
                    fail(`Critical error. Found section ${section} on ${resource} but validation failed - ${errors}`)
                }
            }
        } catch (e) {
            e = e.toString().replace(/\n/g, "<br>")
            fail(`Critical error. Error checking sections of ${resource}. Error: \`${e}\``)
            continue
        }

        try {
            const documents = new fdir()
                .withBasePath()
                .withRelativePaths()
                .withMaxDepth(5)
                .glob(`${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/*/**/info.yml`)
                .crawl(SOURCE_DIR)
                .sync()

            // console.log(documents)

            let prevDate

            for (let document of documents) {
                let documentInfo
                let documentPathInfo

                try {
                    documentPathInfo = parseResourcePath(document)
                } catch (e) {
                    e = e.toString().replace(/\n/g, "<br>")
                    fail(`Critical error. Can not parse the document path: ${document}. Error: \`${e}\``)
                    continue
                }

                try {
                    documentInfo = await getDocumentInfoYml(`${SOURCE_DIR}/${document}`)
                } catch (e) {
                    e = e.toString().replace(/\n/g, "<br>")
                    fail(`Critical error. Can not parse the document info: ${document}. Error: \`${e}\``)
                    continue
                }

                if (prevDate) {
                    let startDate = dayjs(documentInfo.startDate)
                    let endDate = dayjs(documentInfo.endDate)

                    if (!startDate.isSame(endDate, 'day')) {
                        console.log(`${document} not same start and end date`)
                    }

                    if (startDate.diff(prevDate, 'd') !== 1) {
                        console.log(`${document} date range more than 1, got ${startDate.diff(prevDate, 'd')}`)
                    }
                    prevDate = dayjs(documentInfo.startDate, "DD/MM/YYYY")
                } else {
                    prevDate = dayjs(documentInfo.startDate, "DD/MM/YYYY")
                }

                const segments = new fdir()
                    .withBasePath()
                    .withRelativePaths()
                    .withMaxDepth(7)
                    .glob(`${document.replace(/info.yml/g, '')}*${SEGMENT_FILENAME_EXTENSION}`)
                    .crawl(`${SOURCE_DIR}`)
                    .sync();

                for (let segment of segments) {
                    let segmentInfo
                    let segmentPathInfo

                    try {
                        segmentPathInfo = parseResourcePath(segment)
                    } catch (e) {
                        e = e.toString().replace(/\n/g, "<br>")
                        fail(`Critical error. Can not parse the segment path: ${segment}. Error: \`${e}\``)
                        continue
                    }

                    try {
                        segmentInfo = await getSegmentInfo(`${SOURCE_DIR}/${segment}`)
                    } catch (e) {
                        e = e.toString().replace(/\n/g, "<br>")
                        fail(`Critical error. Can not parse the segment info: ${segment}. Error: \`${e}\``)
                        continue
                    }

                    if (segmentInfo.date) {

                        try {
                            let segmentDate = dayjs(segmentInfo.date, "DD/MM/YYYY")

                            console.log(segmentDate)

                            if (!documentInfo.startDate) {
                                fail(`Segment has a date, but document does not: ${segment}. Error: \`${e}\``)
                            } else {
                                let documentStartDate = dayjs(documentInfo.startDate, "DD/MM/YYYY")
                                let documentEndDate = dayjs(documentInfo.endDate, "DD/MM/YYYY")

                                if (!segmentDate.isBetween(documentStartDate, documentEndDate, null, '[]')) {
                                    console.log(`${segment} date if off`)
                                }
                            }

                        } catch (e) {
                            console.log(e)
                            fail(`Error parsing segment date: ${segment}. Error: \`${e}\``)
                        }

                    }
                }
            }

            if (resourceInfo.kind !== RESOURCE_KIND.EXTERNAL) {
                if (!documents.length) {
                    fail(`Critical error. Did not find any documents in ${resource}.`)
                    continue
                }
            }
        } catch (e) {
            e = e.toString().replace(/\n/g, "<br>")
            fail(`Critical error. Can not determine documents for ${resource}. Error: \`${e}\``)
            continue
        }

        if (resourceInfo.kind === RESOURCE_KIND.EXTERNAL
            && !resourceInfo.externalURL) {
            fail(`Critical error. External resource found without the external URL value: ${resource}`)
            continue
        }

        try {
            let validateResult = validator.validate(resourceInfo, resourceSchema)
            if (validateResult.errors.length) {
                let errors = ""
                validateResult.errors.map(e => {
                    errors += `${e.stack} <br/>`
                })
                fail(`Critical error. Resource validation error: on ${resource} - ${errors}`)
                continue
            }
        } catch (e) {
            fail(`Critical error. Resource validation error: ${resource}, ${e}`)
            continue
        }

        try {
            if (!resourceInfo && !resourceInfo.portrait && !fs.pathExistsSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${RESOURCE_ASSETS_DIRNAME}/${RESOURCE_COVERS.PORTRAIT}`)) {
                fail(`Portrait cover not found for resource: ${resource}`)
            }

            if (!resourceInfo && !resourceInfo.landscape && !fs.pathExistsSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${RESOURCE_ASSETS_DIRNAME}/${RESOURCE_COVERS.LANDSCAPE}`)) {
                fail(`Landscape cover not found for resource: ${resource}`)
            }

            if (!resourceInfo && !resourceInfo.square && !fs.pathExistsSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${RESOURCE_ASSETS_DIRNAME}/${RESOURCE_COVERS.SQUARE}`)) {
                fail(`Square cover not found for resource: ${resource}`)
            }
        } catch (e) {
            fail(`Critical error. Checking covers validation error: ${resource}, ${e}`)
        }
    }
}

if (isMainModule(import.meta)) {
    try {
        await runValidation(arg, validateResources)
    } catch (error) {
        fail(`Critical error. Validation did not complete: ${error}`)
    }

    if (failMessages.length) {
        let pullRequestComment = "Ooops! Issues were found\n"
        pullRequestComment += "||Error description |\n| ----------- | ----------- |"

        for (let message of failMessages) {
            pullRequestComment += `\n|🛑| ${message}|`
        }
        console.error(pullRequestComment)
        process.exitCode = 1
    }
}
