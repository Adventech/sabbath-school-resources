#!/usr/bin/env node
"use strict"

import fs from "fs-extra"
import yaml from "js-yaml"
import { fdir } from "fdir"
import { isMainModule } from "../helpers/helpers.js"
import { API_DIST, LANGUAGE_INFO_FILENAME, RESOURCE_TYPE, SOURCE_DIR } from "../helpers/constants.js"

let getLanguageInfo = async function (language) {
    return yaml.load(fs.readFileSync(`${SOURCE_DIR}/${language}/${LANGUAGE_INFO_FILENAME}`, "utf8"))
}

let getLanguageInfoSync = function (language) {
    return yaml.load(fs.readFileSync(`${SOURCE_DIR}/${language}/${LANGUAGE_INFO_FILENAME}`, "utf8"))
}

let getLanguages = async function () {
    return new fdir()
        .filter(d => d !== `${SOURCE_DIR}/`)
        .withMaxDepth(1)
        .onlyDirs()
        .crawl(SOURCE_DIR)
        .sync().map(l => l.replace(`${SOURCE_DIR}/`, "").replace(/\/$/, ""));
}

let processLanguages = async function () {
    const languages = await getLanguages()
    const languagesInfo = []
    for (let language of languages) {
        const languageInfo = await getLanguageInfo(language)
        const languageInfoDist = {
            name: languageInfo.name,
            code: languageInfo.code,
        }

        for (let resourceType of Object.keys(RESOURCE_TYPE)) {
            const resourceTypePath = `${SOURCE_DIR}/${language}/${RESOURCE_TYPE[resourceType]}`
            let resourceTypeExists = fs.pathExistsSync(resourceTypePath)
            let feedHidden = false
            if (resourceTypeExists) {
                let feedInfo = yaml.load(fs.readFileSync(`${resourceTypePath}/feed.yml`, "utf8"))
                feedHidden = feedInfo.hidden ?? false
            }
            languageInfoDist[RESOURCE_TYPE[resourceType]] = resourceTypeExists && !feedHidden
        }
        languagesInfo.push(languageInfoDist)
    }
    fs.outputFileSync(`${API_DIST}/resources/index.json`, JSON.stringify(languagesInfo))
}

if (isMainModule(import.meta)) {
    await processLanguages()
}

export {
    getLanguages,
    getLanguageInfo,
    getLanguageInfoSync
}