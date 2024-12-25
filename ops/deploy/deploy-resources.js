#!/usr/bin/env node
"use strict"

import fetch from "node-fetch"
import crypto from "crypto"
import yaml from "js-yaml"
import fs from "fs-extra"
import picomatch from "picomatch"
import { fdir } from "fdir"
import { database } from "../helpers/firebase.js"
import { getDocumentInfoYml } from "./deploy-documents.js"
import { getLanguageInfo } from "./deploy-languages.js"
import { arg, isMainModule, parseResourcePath, sortResourcesByPattern } from "../helpers/helpers.js"
import {
    SOURCE_DIR,
    API_DIST,
    GLOBAL_ASSETS_DIR,
    RESOURCE_COLOR_PRIMARY,
    RESOURCE_COLOR_PRIMARY_DARK,
    RESOURCE_KIND,
    RESOURCE_INFO_FILENAME,
    RESOURCE_FEED_FILENAME,
    FEED_SCOPES,
    FEED_VIEWS,
    FEED_DIRECTION,
    FIREBASE_DATABASE_RESOURCES,
    API_URL,
    API_PREFIX,
    ASSETS_URL,
    DOCUMENT_INFO_FILENAME,
    DEPLOY_ENV,
    RESOURCE_AUDIO_FILENAME,
    RESOURCE_VIDEO_FILENAME,
    RESOURCE_PDF_FILENAME,
    RESOURCE_COVER_PLACEHOLDER, RESOURCE_PROGRESS_TRACKING, AUTHORS_DIRNAME
} from "../helpers/constants.js"
import { getAuthorInfo } from "./deploy-authors.js"
import { getCategoryInfo } from "./deploy-categories.js"

let getResourceInfo = async function (resource, depth = 0) {
    const resourceInfo = yaml.load(fs.readFileSync(resource, "utf8"));
    const resourcePathInfo = parseResourcePath(resource)
    const languageInfo = await getLanguageInfo(resourcePathInfo.language)

    resourceInfo.id = `${resourcePathInfo.language}-${resourcePathInfo.type}-${resourcePathInfo.title}`
    resourceInfo.index = `${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}`
    resourceInfo.name = `${resourcePathInfo.title}`
    resourceInfo.type = `${resourcePathInfo.type}`

    // Setting up defaults if not present in the info.yml
    resourceInfo.credits = resourceInfo.credits ?? []
    resourceInfo.features = resourceInfo.features ?? []
    resourceInfo.kind = resourceInfo.kind ?? RESOURCE_KIND.BOOK
    resourceInfo.primaryColor = resourceInfo.primaryColor ?? (resourceInfo.color_primary ?? RESOURCE_COLOR_PRIMARY)
    resourceInfo.primaryColorDark = resourceInfo.primaryColorDark ?? (resourceInfo.color_primary_dark ?? RESOURCE_COLOR_PRIMARY_DARK)

    if (resourceInfo.start_date) {
        resourceInfo.startDate = resourceInfo.start_date
        delete resourceInfo.start_date
    }

    if (resourceInfo.end_date) {
        resourceInfo.endDate = resourceInfo.end_date
        delete resourceInfo.end_date
    }

    if (!resourceInfo.progressTracking && (resourceInfo.kind === RESOURCE_KIND.DEVOTIONAL || resourceInfo.kind === RESOURCE_KIND.PLAN)) {
        resourceInfo.progressTracking =
            resourceInfo.startDate && resourceInfo.endDate
                ? RESOURCE_PROGRESS_TRACKING.AUTOMATIC
                : RESOURCE_PROGRESS_TRACKING.MANUAL
        resourceInfo.displayProgress = true
    }

    if (resourceInfo.splash) {
        delete resourceInfo.splash
    }

    if (resourceInfo.color_primary) {
        delete resourceInfo.color_primary
    }

    if (resourceInfo.color_primary_dark) {
        delete resourceInfo.color_primary_dark
    }

    if (resourceInfo.human_date) {
        resourceInfo.subtitle = resourceInfo.human_date
        delete resourceInfo.human_date
    }

    const introductionFile = `${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/introduction.md`

    if (fs.pathExistsSync(introductionFile)) {
        resourceInfo.introduction = fs.readFileSync(introductionFile, "utf-8")
    }

    if (depth && resourceInfo.featuredResources) {
        let featuredResources = await Promise.all(resourceInfo.featuredResources.map(async featuredResource => {
            const featuredResourcePath = `${SOURCE_DIR}/${featuredResource}/${RESOURCE_INFO_FILENAME}`
            if (fs.pathExistsSync(featuredResourcePath)) {
                return await getResourceInfo(featuredResourcePath)
            }
        }))
        resourceInfo.feeds = [{
            name: "featured",
            id: crypto.createHash("sha256").update(
                `${resource}-featured`
            ).digest("hex"),
            direction: featuredResources.length > 1 ? FEED_DIRECTION.HORIZONTAL : FEED_DIRECTION.VERTICAL,
            scope: FEED_SCOPES.RESOURCE,
            view: resourceInfo.featuredResourcesView ?? FEED_VIEWS.FOLIO,
            title: languageInfo.featuredResources.title,
            resources: featuredResources.filter(r => r)
        }]
    }

    delete resourceInfo.featuredResources

    if (DEPLOY_ENV === "local" && !resourceInfo.covers) {
        resourceInfo.covers = {
            portrait: `http://localhost:3002${API_PREFIX}${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/assets/cover.png`,
        }

        // copy file
        fs.copySync(
            `${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/assets/cover.png`,
            `${API_DIST}${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/assets/cover.png`
        )
    }

    if (!resourceInfo.covers || !resourceInfo.covers.portrait) {
        resourceInfo.covers = {
            portrait: RESOURCE_COVER_PLACEHOLDER
        }
    }

    let resourceTitleForSplash = resourcePathInfo.title.replace(/-er$/, '').replace(/-(ay|inv)$/, '-cq')

    if (!resourceInfo.covers.splash && fs.pathExistsSync(`${GLOBAL_ASSETS_DIR}/images/${resourcePathInfo.type}/${resourceTitleForSplash}/splash.png`)) {
        resourceInfo.covers.splash = `${ASSETS_URL}/assets/images/${resourcePathInfo.type}/${resourceTitleForSplash}/splash.png`
    }

    if (resourceInfo.covers) {
        resourceInfo.covers.square ??= resourceInfo.covers.portrait
        resourceInfo.covers.landscape ??= resourceInfo.covers.portrait
    }

    const documents = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(2)
        .glob(`*/**/${DOCUMENT_INFO_FILENAME}`)
        .crawl(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}`)
        .sync();

    // If resource only contains one document, add documentId and documentIndex to resource level
    // to launch document without individual view screen

    if (documents.length === 1) {
        let document = documents[0]
        let documentInfo = await getDocumentInfoYml(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${document}`)
        resourceInfo.documentId = documentInfo.id
        resourceInfo.documentIndex = documentInfo.index
    }

    if (resourceInfo.externalURL) {
        resourceInfo.kind = RESOURCE_KIND.EXTERNAL
    }

    if (languageInfo.features) {
        let features = { ...languageInfo.features }
        let resourceFeatures = []

        for (let key of Object.keys(features)) {
            features[key].image = `${API_URL()}${API_PREFIX}${features[key].image}`
        }

        if (resourceInfo.features && resourceInfo.features.length) {
            for (let feature of resourceInfo.features) {
                if (feature && features[feature]) {
                    resourceFeatures.push(features[feature])
                }
            }
        }

        let inside_stories = fs.pathExistsSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/01/inside-story.md`)

        if (inside_stories && features['inside-story']) {
            resourceFeatures.push(features['inside-story'])
        }

        let teacher_comments = fs.pathExistsSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/01/teacher-comments.md`)

        if (teacher_comments && features['teacher-comments']) {
            resourceFeatures.push(features['teacher-comments'])
        }

        let audio = fs.pathExistsSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${RESOURCE_AUDIO_FILENAME}`)

        if (audio && features['audio']) {
            resourceFeatures.push(features['audio'])
        }

        let video = fs.pathExistsSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${RESOURCE_VIDEO_FILENAME}`)

        if (video && features['video']) {
            resourceFeatures.push(features['video'])
        }

        let pdf = fs.pathExistsSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/${RESOURCE_PDF_FILENAME}`)

        if (pdf && features['original_layout']) {
            resourceFeatures.push(features['original_layout'])
        }

        resourceInfo.features = resourceFeatures.filter((thing, index) => {
            const _thing = JSON.stringify(thing)
            return index === resourceFeatures.findIndex(obj => {
                return JSON.stringify(obj) === _thing
            })
        })
    }

    if (resourceInfo.author) {
        try {
            if (Array.isArray(resourceInfo.author)) {
                resourceInfo.authors = []

                for (let author of resourceInfo.author) {
                    let authorInfo = await getAuthorInfo(`${SOURCE_DIR}/${resourcePathInfo.language}/${AUTHORS_DIRNAME}/${author}/info.yml`)
                    resourceInfo.authors.push(authorInfo)
                }

                if (!resourceInfo.authors.length) {
                    delete resourceInfo.authors
                }
            } else {
                let authorInfo = await getAuthorInfo(`${SOURCE_DIR}/${resourcePathInfo.language}/${AUTHORS_DIRNAME}/${resourceInfo.author}/info.yml`)
                resourceInfo.authors = [authorInfo]
            }
        } catch (e) {
            console.log(`Error processing ${resourceInfo.title} ${resourceInfo.author} ${e}`)
        }
        delete resourceInfo.author
    }

    return resourceInfo
}

let getResourceFeed = async function (resource) {
    return yaml.load(fs.readFileSync(resource, "utf8"))
}

let processResources = async function (languageGlob, resourceType, resourceGlob) {
    const languages = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(2)
        .glob(`${languageGlob}/info.yml`)
        .crawl(SOURCE_DIR)
        .sync().map(l => l.replace(/\/info.yml$/, ''))

    for (let language of languages) {
        console.log(`Processing language ${language}`)
        const languageInfo = await getLanguageInfo(language)

        const resourceFeedConfigs = {}

        let resources = new fdir()
            .withBasePath()
            .withRelativePaths()
            .withMaxDepth(3)
            .glob(`${language}/${resourceType}/${resourceGlob}/${RESOURCE_INFO_FILENAME}`)
            .crawl(SOURCE_DIR)
            .sync().reverse()

        for (let resource of resources) {
            console.log(`Processing resource ${resource}`)
            try {
                const resourceInfo = await getResourceInfo(`${SOURCE_DIR}/${resource}`)
                const resourcePathInfo = parseResourcePath(resource)

                if (!fs.pathExistsSync(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${RESOURCE_FEED_FILENAME}`)) {
                    continue
                }

                if (!resourceFeedConfigs[resourcePathInfo.language]
                    || !resourceFeedConfigs[resourcePathInfo.language][resourcePathInfo.type]) {

                    const resourceFeedConfig = await getResourceFeed(`${SOURCE_DIR}/${resourcePathInfo.language}/${resourcePathInfo.type}/${RESOURCE_FEED_FILENAME}`)

                    if (!resourceFeedConfigs[resourcePathInfo.language]) {
                        resourceFeedConfigs[resourcePathInfo.language] = {}
                    }

                    resourceFeedConfigs[resourcePathInfo.language] = {
                        ...resourceFeedConfigs[resourcePathInfo.language],
                        ...{
                            [resourcePathInfo.type]: {
                                title: resourceFeedConfig.title,
                                groups: []
                            }
                        }
                    }

                    resourceFeedConfig.groups.map((g, index) => {
                        resourceFeedConfigs[resourcePathInfo.language][resourcePathInfo.type].groups.push({
                            ...g,
                            title: g.group || null,
                            author: g.author || null,
                            scope: g.scope || null,
                            resources: [],
                            authors: [],
                            categories: [],
                            resourceIds: g.resources || [],
                            authorIds: g.authors || [],
                            categoryIds: g.categories || [],
                            view: g.view || FEED_VIEWS.FOLIO,
                            recent: g.recent || null,
                            type: resourcePathInfo.type,
                            direction: g.direction || FEED_DIRECTION.HORIZONTAL,
                            id: crypto.createHash("sha256").update(
                                `${language}-${resourcePathInfo.type}-${g.group}-${index}`
                            ).digest("hex"),
                            seeAll: g.noSeeAll ? null : (languageInfo.feedSeeAll ?? "See All"),
                        })
                    })
                }

                let resourceFeed = resourceFeedConfigs[resourcePathInfo.language][resourcePathInfo.type]

                let groupByName = resourceFeed.groups.find(g => g.resourceIds.some(i => picomatch(i)(resourceInfo.id) ))
                let groupByAuthor = resourceFeed.groups.find(g => g.author === resourceInfo.author)
                let groupByKind = resourceFeed.groups.find(g => g.kind === resourceInfo.kind)
                let groupByType = resourceFeed.groups.find(g => g.scope === FEED_SCOPES.RESOURCE)

                if (groupByName) {
                    groupByName.resources.push(resourceInfo)
                    groupByName.resources = sortResourcesByPattern(groupByName.resources, groupByName.resourceIds)
                } else if (groupByAuthor) {
                    groupByAuthor.resources.push(resourceInfo)
                    groupByAuthor.resources = sortResourcesByPattern(groupByAuthor.resources, groupByAuthor.resourceIds)
                } else if (groupByKind) {
                    groupByKind.resources.push(resourceInfo)
                    groupByKind.resources = sortResourcesByPattern(groupByKind.resources, groupByKind.resourceIds)
                } else if (groupByType) {
                    groupByType.resources.push(resourceInfo)
                    groupByType.resources = sortResourcesByPattern(groupByType.resources, groupByType.resourceIds)
                }

                await database.collection(FIREBASE_DATABASE_RESOURCES).doc(resourceInfo.id).set(resourceInfo);

                fs.outputFileSync(`${API_DIST}/${resourcePathInfo.language}/${resourcePathInfo.type}/${resourcePathInfo.title}/index.json`, JSON.stringify(resourceInfo))
            } catch (e) {
                console.log(`Error processing resources: ${e}`);
            }
        }

        if (
            resourceFeedConfigs[language] &&
            resourceFeedConfigs[language][resourceType].groups.find((g) => g.scope === FEED_SCOPES.AUTHOR)
        ) {
            let authors = new fdir()
                .withBasePath()
                .withRelativePaths()
                .withMaxDepth(3)
                .glob(`${language}/authors/*/${RESOURCE_INFO_FILENAME}`)
                .crawl(SOURCE_DIR)
                .sync().reverse()

            for (let author of authors) {
                console.log(`Processing author ${author}`)
                try {
                    const authorInfo = await getAuthorInfo(`${SOURCE_DIR}/${author}`, false)

                    let resourceFeed = resourceFeedConfigs[language][resourceType]
                    let groupByName = resourceFeed.groups.find(g => g.authorIds.some(i => picomatch(i)(authorInfo.id) ))

                    if (groupByName) {
                        groupByName.authors.push(authorInfo)
                        groupByName.authors = sortResourcesByPattern(groupByName.authors, groupByName.authorIds)
                    }
                } catch (e) {
                    console.log(`Error processing categories: ${e}`);
                }
            }
        }

        if (
            resourceFeedConfigs[language] &&
            resourceFeedConfigs[language][resourceType].groups.find((g) => g.scope === FEED_SCOPES.CATEGORY)
        ) {
            let categories = new fdir()
                .withBasePath()
                .withRelativePaths()
                .withMaxDepth(3)
                .glob(`${language}/categories/*/${RESOURCE_INFO_FILENAME}`)
                .crawl(SOURCE_DIR)
                .sync().reverse()

            for (let category of categories) {
                console.log(`Processing category ${category}`)
                try {
                    const categoryInfo = await getCategoryInfo(`${SOURCE_DIR}/${category}`)

                    let resourceFeed = resourceFeedConfigs[language][resourceType]
                    let groupByName = resourceFeed.groups.find(g => g.categoryIds.some(i => picomatch(i)(categoryInfo.id) ))

                    if (groupByName) {
                        groupByName.categories.push(categoryInfo)
                        groupByName.categories = sortResourcesByPattern(groupByName.categories, groupByName.categoryIds)
                    }
                } catch (e) {
                    console.log(`Error processing categories: ${e}`);
                }
            }
        }

        // TODO: use this when the recent is implemented, potentially it should not be tied to a specific feed but be recent for the user
        //
        // const recentFeedGroup = resourceFeed.groups.find(g => g.recent)
        //
        // if (recentFeedGroup && recentFeedGroup.group) {
        //     const recentFeedGroupAPI = {
        //         title: recentFeedGroup.group,
        //         view: recentFeedGroup.view || FEED_VIEWS.SQUARE,
        //         scope: recentFeedGroup.scope || FEED_SCOPES.RESOURCE,
        //         resources: [],
        //         type: resourceType,
        //         direction: recentFeedGroup.direction || FEED_DIRECTION.HORIZONTAL,
        //         id: crypto.createHash("sha256").update(
        //             `${language}-${resourceType}-recent`
        //         ).digest("hex")
        //     }
        //     await database.collection(FIREBASE_DATABASE_LANGUAGES).doc(language).collection("feed").doc("recent").set(recentFeedGroupAPI);
        // }

        for (let resourceFeedLanguage of Object.keys(resourceFeedConfigs)) {
            for (let resourceFeedForType of Object.keys(resourceFeedConfigs[resourceFeedLanguage])) {
                let resourceFeed = resourceFeedConfigs[resourceFeedLanguage][resourceFeedForType]

                let originalResourceFeed = JSON.parse(JSON.stringify(resourceFeedConfigs[resourceFeedLanguage][resourceFeedForType]))

                resourceFeed.groups = resourceFeed.groups.filter(g => g.resources.length || g.authors.length || g.categories.length).map(g => {
                    delete g.kind
                    delete g.resourceIds
                    delete g.authorIds
                    delete g.documentIds
                    delete g.categoryIds
                    delete g.author
                    delete g.group
                    if (!g.scope && g.resources.length) {
                        g.scope = FEED_SCOPES.RESOURCE
                    }
                    delete g.recent

                    if (g.noSeeAll) {
                        delete g.noSeeAll
                    }

                    if (g.reverse) {
                        g.resources = g.resources.reverse()
                        g.authors = g.authors.reverse()
                        g.categories = g.categories.reverse()
                        delete g.reverse
                    }

                    if (g.scope === FEED_SCOPES.RESOURCE) {
                        delete g.authors
                        delete g.categories
                    }

                    if (g.scope === FEED_SCOPES.AUTHOR) {
                        delete g.resources
                        delete g.categories
                    }

                    if (g.scope === FEED_SCOPES.CATEGORY) {
                        delete g.resources
                        delete g.authors
                    }

                    return g
                })

                for (let feedGroup of resourceFeed.groups) {
                    let feedGroupAll = { ...feedGroup }
                    feedGroupAll.direction = FEED_DIRECTION.VERTICAL

                    delete feedGroupAll.backgroundColor

                    let key = "resources"
                    let sortingKey = "resourceIds"

                    if (feedGroup.scope === FEED_SCOPES.RESOURCE) {
                        key = "resources"
                        sortingKey = "resourceIds"
                    } else if (feedGroup.scope === FEED_SCOPES.AUTHOR) {
                        key = "authors"
                        sortingKey = "authorIds"
                    } else if (feedGroup.scope === FEED_SCOPES.CATEGORY) {
                        key = "categories"
                        sortingKey = "categoryIds"
                    }

                    // Get existing feed for non-global deployments
                    if (resourceGlob !== "*") {
                        let existingFeedResponse
                        let existingFeed
                        try {
                            existingFeedResponse = await fetch(`${API_URL()}${API_PREFIX}${language}/${resourceFeedForType}/feeds/${feedGroup.id}/index.json`)
                            existingFeed = await existingFeedResponse.json()
                        } catch (e) {
                            if (feedGroup.scope === FEED_SCOPES.RESOURCE) {
                                existingFeed = { resources: [] }
                            } else if (feedGroup.scope === FEED_SCOPES.AUTHOR) {
                                existingFeed = { authors: [] }
                            } else if (feedGroup.scope === FEED_SCOPES.CATEGORY) {
                                existingFeed = { categories: []}
                            }
                        }

                        for (let feedGroupResource of feedGroup[key]) {
                            let found = false

                            existingFeed[key] = existingFeed[key].map((existingResource) => {
                                if (existingResource.id === feedGroupResource.id) {
                                    found = true
                                    existingResource = feedGroupResource
                                }
                                return existingResource
                            })

                            if (!found) {
                                existingFeed[key].unshift(feedGroupResource)
                                let originalResourceFeedGroup = originalResourceFeed.groups.find((g) => g.id === feedGroup.id)

                                if (originalResourceFeedGroup) {
                                    existingFeed[key] = sortResourcesByPattern(existingFeed[key], originalResourceFeedGroup[sortingKey])
                                }
                            }
                        }

                        feedGroupAll[key] = existingFeed[key]
                        feedGroup[key] = existingFeed[key]
                    }

                    let feedGroupAllFinal = JSON.parse(JSON.stringify(feedGroupAll))
                    delete feedGroupAllFinal.seeAll

                    fs.outputFileSync(`${API_DIST}/${language}/${resourceFeedForType}/feeds/${feedGroup.id}/index.json`, JSON.stringify(feedGroupAllFinal))

                    if (resourceFeed.groups.length > 1 && feedGroup[key].length > 10) {
                        feedGroup[key] = feedGroup[key].slice(0, 10)
                    }
                }

                // Get existing feed for non-global deployments
                if (resourceGlob !== "*") {
                    let existingMainFeedResponse
                    let existingMainFeed
                    try {
                        existingMainFeedResponse = await fetch(`${API_URL()}${API_PREFIX}${language}/${resourceFeedForType}/index.json`)
                        existingMainFeed = await existingMainFeedResponse.json()

                        existingMainFeed.groups = existingMainFeed.groups.map((existingMainFeedGroup) => {
                            for (let feedGroup of resourceFeed.groups) {
                                if (feedGroup.id === existingMainFeedGroup.id) {
                                    existingMainFeedGroup = feedGroup
                                }
                            }
                            return existingMainFeedGroup
                        })

                        for (let resourceFeedGroup of resourceFeed.groups) {
                            if (!existingMainFeed.groups.find((g) => g.id === resourceFeedGroup.id)) {
                                existingMainFeed.groups.push(resourceFeedGroup)
                            }
                        }

                        resourceFeed.groups = existingMainFeed.groups
                    } catch (e) {
                        existingMainFeed = { groups: [] }
                    }
                }

                fs.outputFileSync(`${API_DIST}/${language}/${resourceFeedForType}/index.json`, JSON.stringify(resourceFeed))
            }
        }
    }
}

if (isMainModule(import.meta)) {
    Object.keys(arg).map(async (argLanguage) => {
        Object.keys(arg[argLanguage]).map(async (argType) => {
            await processResources(argLanguage, argType, arg[argLanguage][argType].resources)
        })
    })
}

export {
    getResourceInfo
}