#!/usr/bin/env node
"use strict"

import fs from "fs-extra"
import yaml from "js-yaml"
import { fdir } from "fdir"
import { getResourceInfo } from "./deploy-resources.js"
import { getDocumentInfoYml, processPDFOnlyResource } from "./deploy-documents.js"
import { arg, isMainModule, parseResourcePath } from "../helpers/helpers.js"
import {
    SOURCE_DIR,
    API_DIST,
    RESOURCE_INFO_FILENAME,
    SECTION_INFO_FILENAME,
    RESOURCE_ORDER,
    SECTION_DEFAULT_NAME,
    SECTION_DIRNAME, SECTION_VIEWS, RESOURCE_PDF_FILENAME,
} from "../helpers/constants.js"
import { getLanguageInfo } from "./deploy-languages.js"

let getSectionInfo = async function (section) {
    const sectionInfo = yaml.load(fs.readFileSync(section, "utf8"))
    const sectionPathInfo = parseResourcePath(section)
    sectionInfo.name = sectionPathInfo.section ?? SECTION_DEFAULT_NAME
    return sectionInfo
}

let processSection = async function (resourceInfo, section) {
    let documents = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(1)
        .glob("*/**/info.yml")
        .crawl(section)
        .sync()

    if (resourceInfo.order && resourceInfo.order === RESOURCE_ORDER.DESC) {
        documents = documents.reverse()
    }

    let sectionDocuments = []

    for (let document of documents) {
        const documentInfo = await getDocumentInfoYml(`${section}/${document}`)
        sectionDocuments.push(documentInfo)
    }

    return sectionDocuments
}

let processSections = async function (language, resourceType, resourceGlob) {
    const resources = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(3)
        .glob(`${language}/${resourceType}/${resourceGlob}/${RESOURCE_INFO_FILENAME}`)
        .crawl(SOURCE_DIR)
        .sync();

    for (let resource of resources) {
        let totalDocuments = 0
        const resourceInfo = await getResourceInfo(`${SOURCE_DIR}/${resource}`, 1)
        const resourcePathInfo = parseResourcePath(`${SOURCE_DIR}/${resource}`)
        const resourceContentPath = `${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}`
        const languageInfo = await getLanguageInfo(resourcePathInfo.language)

        const sections = new fdir()
            .withBasePath()
            .withRelativePaths()
            .withMaxDepth(1)
            .glob("**/section.yml")
            .crawl(resourceContentPath)
            .sync()

        // TODO: use language default name
        let sectionDocuments = await processSection(resourceInfo, `${resourceContentPath}`)
        const resourceSectionData = {}

        if (sectionDocuments.length) {
            totalDocuments += sectionDocuments.length
            resourceSectionData[SECTION_DEFAULT_NAME] = {
                id: `${resourcePathInfo.language}-${resourcePathInfo.type}-${resourcePathInfo.title}-${SECTION_DEFAULT_NAME}`,
                name: SECTION_DEFAULT_NAME,
                title: languageInfo.sections?.default || SECTION_DEFAULT_NAME,
                isRoot: true,
                documents: await processSection(resourceInfo, `${resourceContentPath}`)
            }
        }

        for (let section of sections) {
            let sectionInfo = await getSectionInfo(`${resourceContentPath}/${section}`)

            let documents = await processSection(resourceInfo, `${resourceContentPath}/${sectionInfo.name}`)
            totalDocuments += documents.length

            if (documents.length) {
                resourceSectionData[`${section.replace(`/${SECTION_INFO_FILENAME}`, "")}`] = {
                    id: `${resourcePathInfo.language}-${resourcePathInfo.type}-${resourcePathInfo.title}-${section.replace(`/${SECTION_INFO_FILENAME}`, "")}`,
                    isRoot: false,
                    documents,
                    ...sectionInfo
                }
            }
        }

        resourceInfo.sections = Object.values(resourceSectionData)

        const pdfFilePath = `${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${RESOURCE_PDF_FILENAME}`

        if (!resourceInfo.sections.length && fs.pathExistsSync(pdfFilePath)) {
            const documents = await processPDFOnlyResource(`${SOURCE_DIR}/${resource}`, true)
            resourceInfo.sections = [{
                id: `${resourcePathInfo.language}-${resourcePathInfo.type}-${resourcePathInfo.title}-${SECTION_DEFAULT_NAME}`,
                name: SECTION_DEFAULT_NAME,
                title: languageInfo.sections?.default || SECTION_DEFAULT_NAME,
                isRoot: true,
                documents,
            }]
        }

        // TODO: consider number of sections and type of resource to determine the section view
        resourceInfo.sectionView = totalDocuments < 100 ? SECTION_VIEWS.NORMAL : SECTION_VIEWS.DROPDOWN

        fs.outputFileSync(`${API_DIST}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${SECTION_DIRNAME}/index.json`, JSON.stringify(resourceInfo))
    }
}

if (isMainModule(import.meta)) {
    Object.keys(arg).map(async (argLanguage) => {
        Object.keys(arg[argLanguage]).map(async (argType) => {
            await processSections(argLanguage, argType, arg[argLanguage][argType].resources)
        })
    })
}

export {
    getSectionInfo
}