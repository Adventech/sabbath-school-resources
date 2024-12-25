#!/usr/bin/env node
"use strict"

import yaml from "js-yaml"
import fs from "fs-extra"
import { fdir } from "fdir"
import { getResourceInfo } from "./deploy-resources.js"
import { isMainModule, parseResourcePath, sortResourcesByPattern } from "../helpers/helpers.js"
import {
    API_DIST,
    SOURCE_DIR,
    RESOURCE_INFO_FILENAME,
    RESOURCE_TYPE,
    AUTHORS_DIRNAME,
    AUTHORS_FEED_FILENAME,
    AUTHORS_INFO_FILENAME,
    FEED_VIEWS,
    FEED_SCOPES, FEED_DIRECTION,
} from "../helpers/constants.js"
import crypto from "crypto"
import { getLanguageInfo } from "./deploy-languages.js"
import picomatch from "picomatch"

let getAuthorInfo = async function (author, full) {
    const authorInfo = yaml.load(fs.readFileSync(author, "utf8"))
    if (!full) {
        delete authorInfo.details
        delete authorInfo.links
    }
    return authorInfo
}

let getAuthorFeed = async function (author) {
    let authorFeed = yaml.load(fs.readFileSync(author, "utf8"))
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
        resources: []
    }

    for (let resource of resources) {
        try {
            let resourceInfo = await getResourceInfo(`${SOURCE_DIR}/${resource}`)
            if (resourceInfo.authors) {
                allTaggedResources["resources"].push(resourceInfo)
            }
        } catch (e) {
            console.error(`Error processing tagged resource: ${e}`);
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
    const allAuthors = {}

    for (let author of authors) {

        try {
            const authorInfo = await getAuthorInfo(`${SOURCE_DIR}/${author}`, true)
            const authorInfoDetail = { ...authorInfo }
            const authorPathInfo = parseResourcePath(`${SOURCE_DIR}/${author}`)
            const languageInfo = await getLanguageInfo(authorPathInfo.language)
            const authorFeed = await getAuthorFeed(`${SOURCE_DIR}/${authorPathInfo.language}/${AUTHORS_DIRNAME}/${authorPathInfo.title}/${AUTHORS_FEED_FILENAME}`)

            authorInfoDetail.feed = {}
            authorInfoDetail.feed.title = authorInfo.title
            authorInfoDetail.feed.groups = []

            const authorResources = allTaggedResources.resources.filter(r => r.authors.find((a) => a.id === authorInfo.id))

            authorFeed.groups.map((g, index) => {
                authorInfoDetail.feed.groups.push({
                    ...g,
                    title: g.group,
                    resources: [],
                    author: g.author || null,
                    resourceIds: g.resources || [],
                    scope: g.scope || null,
                    view: g.view || FEED_VIEWS.FOLIO,
                    direction: g.direction || FEED_DIRECTION.HORIZONTAL,
                    type: "author",
                    seeAll: languageInfo.feedSeeAll ?? "See All",
                    id: crypto.createHash("sha256").update(
                        `${authorPathInfo.language}-authors-${g.group}-${index}`
                    ).digest("hex"),
                })
            })

            for (let authorResource of authorResources) {
                // name
                let groupByName = authorInfoDetail.feed.groups.find(g => g.resourceIds.some(i => picomatch(i)(authorResource.id) ))

                if (groupByName) {
                    groupByName.resources.push(authorResource)
                    groupByName.resources = sortResourcesByPattern(groupByName.resources, groupByName.resourceIds)
                    continue
                }

                let groupByAuthor = authorInfoDetail.feed.groups.find(g => g.author === authorResource.author)
                if (groupByAuthor) {
                    groupByAuthor.resources.push(authorResource)
                    groupByAuthor.resources = sortResourcesByPattern(groupByAuthor.resources, groupByAuthor.resourceIds)
                    continue
                }

                let groupByKind = authorInfoDetail.feed.groups.find(g => g.kind === authorResource.kind)
                if (groupByKind) {
                    groupByKind.resources.push(authorResource)
                    groupByKind.resources = sortResourcesByPattern(groupByKind.resources, groupByKind.resourceIds)
                    continue
                }

                let groupByScope = authorInfoDetail.feed.groups.find(g => g.scope === FEED_SCOPES.RESOURCE)
                if (groupByScope) {
                    groupByScope.resources.push(authorResource)
                    groupByScope.resources = sortResourcesByPattern(groupByScope.resources, groupByScope.resourceIds)
                }
            }

            authorInfoDetail.feed.groups = authorInfoDetail.feed.groups.filter(g => {
                // filter feed groups that do not have any resources or docs
                return g.resources.length
            }).map(g => {
                // remove unnecessary params
                delete g.kind
                delete g.resourceIds
                delete g.documentIds
                delete g.author
                delete g.group
                if (!g.scope && g.resources.length) {
                    g.scope = FEED_SCOPES.RESOURCE
                }
                return g
            })

            if (!allAuthors[authorPathInfo.language]) {
                allAuthors[authorPathInfo.language] = [authorInfo]
            } else {
                allAuthors[authorPathInfo.language].push(authorInfo)
            }

            if (authorInfoDetail.feed.groups.length === 1) {
                authorInfoDetail.feed.groups[0].direction = FEED_DIRECTION.VERTICAL
                delete authorInfoDetail.feed.groups[0].seeAll
            }

            for(let authorFeedGroup of authorInfoDetail.feed.groups) {
                let authorFeedGroupFinal = JSON.parse(JSON.stringify(authorFeedGroup))
                authorFeedGroupFinal.direction = FEED_DIRECTION.VERTICAL
                delete authorFeedGroupFinal.seeAll

                fs.outputFileSync(`${API_DIST}/${authorPathInfo.language}/${authorPathInfo.type}/${authorPathInfo.title}/feeds/${authorFeedGroup.id}/index.json`, JSON.stringify(authorFeedGroupFinal))

                if (authorInfoDetail.feed.groups.length > 1 && authorFeedGroup["resources"].length > 10) {
                    authorFeedGroup["resources"] = authorFeedGroup["resources"].slice(0, 10)
                }
            }

            fs.outputFileSync(`${API_DIST}/${authorPathInfo.language}/${authorPathInfo.type}/${authorPathInfo.title}/index.json`, JSON.stringify(authorInfoDetail))
        } catch (e) {
            console.error(`Error processing authors: ${e}`);
        }
    }

    for (let language of Object.keys(allAuthors)) {
        fs.outputFileSync(`${API_DIST}/${language}/${AUTHORS_DIRNAME}/index.json`, JSON.stringify(allAuthors[language]))
    }
}

if (isMainModule(import.meta)) {
    await processAuthors()
}

export {
    getAuthorInfo
}