#!/usr/bin/env node
"use strict"

import { isMainModule, parseResourcePath } from '../helpers/helpers.js'
import { fdir } from "fdir"
import yaml from "js-yaml"
import fs from "fs-extra"
import {
    API_DIST,
    SOURCE_DIR,
    RESOURCE_INFO_FILENAME,
    RESOURCE_TYPE,
    AUTHORS_DIRNAME,
    AUTHORS_FEED_FILENAME,
    AUTHORS_FEED_RESOURCE_TYPE,
    AUTHORS_INFO_FILENAME
} from "../helpers/constants.js"
import { getResourceInfo } from "./deploy-resources.js"

let getAuthorInfo = async function (author) {
    const authorInfo = yaml.load(fs.readFileSync(author, 'utf8'))
    return authorInfo
}

let getAuthorFeed = async function (author) {
    let authorFeed = yaml.load(fs.readFileSync(author, 'utf8'))
    return authorFeed
}

let getAllTaggedResources = async function () {
    const resources = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(3)
        .glob(`**/+(${Object.values(RESOURCE_TYPE).join("|")})/**/${RESOURCE_INFO_FILENAME}`)
        .crawl(SOURCE_DIR)
        .sync();

    let allTaggedResources = {
        'resources': []
    }

    for (let resource of resources) {
        try {
            let resourceInfo = await getResourceInfo(`${SOURCE_DIR}/${resource}`)
            if (resourceInfo.author) {
                allTaggedResources['resources'].push(resourceInfo)
            }
        } catch (e) {
            console.error(e);
        }
    }

    return allTaggedResources
}

let processAuthors = async function () {
    const authors = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(4)
        .glob(`**/${AUTHORS_DIRNAME}/**/${AUTHORS_INFO_FILENAME}`)
        .crawl(SOURCE_DIR)
        .sync();

    const allTaggedResources = await getAllTaggedResources()
    const allCategories = {}

    for (let author of authors) {
        try {
            const authorInfo = await getAuthorInfo(`${SOURCE_DIR}/${author}`)
            const authorInfoDetail = { ...authorInfo }
            const authorPathInfo = parseResourcePath(`${SOURCE_DIR}/${author}`)
            const authorFeed = await getAuthorFeed(`${SOURCE_DIR}/${authorPathInfo.language}/${AUTHORS_DIRNAME}/${authorPathInfo.title}/${AUTHORS_FEED_FILENAME}`)

            authorInfoDetail.feed = []

            const authorResources = allTaggedResources.resources.filter(r => r.author === authorPathInfo.title)

            authorFeed.map(g => {
                authorInfoDetail.feed.push({
                    ...g,
                    title: g.group,
                    resources: [],
                    author: g.author || null,
                    resourceIds: g.resources || [],
                    type: g.type || null
                })
            })


            // console.log(allTaggedResources)

            for (let authorResource of authorResources) {
                // name
                let groupByName = authorInfoDetail.feed.find(g => g.resourceIds.indexOf(authorResource.id) >= 0)
                if (groupByName) {
                    groupByName.resources.push(authorResource)
                    continue
                }

                let groupByAuthor = authorInfoDetail.feed.find(g => g.author === authorResource.author)
                if (groupByAuthor) {
                    groupByAuthor.resources.push(authorResource)
                    continue
                }

                let groupByKind = authorInfoDetail.feed.find(g => g.kind === authorResource.kind)
                if (groupByKind) {
                    groupByKind.resources.push(authorResource)
                    continue
                }

                let groupByType = authorInfoDetail.feed.find(g => g.type === AUTHORS_FEED_RESOURCE_TYPE)
                if (groupByType) {
                    groupByType.resources.push(authorResource)
                }
            }


            authorInfoDetail.feed = authorInfoDetail.feed.filter(g => {
                // filter feed groups that do not have any resources or docs
                return g.resources.length
            }).map(g => {
                // remove unnecessary params
                delete g.kind
                delete g.resourceIds
                delete g.documentIds
                delete g.author
                delete g.group
                if (!g.type && g.resources.length) {
                    g.type = AUTHORS_FEED_RESOURCE_TYPE
                }
                return g
            })

            if (!allCategories[authorPathInfo.language]) {
                allCategories[authorPathInfo.language] = [authorInfo]
            } else {
                allCategories[authorPathInfo.language].push(authorInfo)
            }

            fs.outputFileSync(`${API_DIST}/${authorPathInfo.language}/${authorPathInfo.type}/${authorPathInfo.title}/index.json`, JSON.stringify(authorInfoDetail))
        } catch (e) {
            console.error(e);
        }
    }

    for (let language of Object.keys(allCategories)) {
        fs.outputFileSync(`${API_DIST}/${language}/${AUTHORS_DIRNAME}/index.json`, JSON.stringify(allCategories[language]))
    }
}

if (isMainModule(import.meta)) {
    await processAuthors()
}

export {
    getAuthorInfo
}