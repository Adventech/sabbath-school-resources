#!/usr/bin/env node
"use strict"
import process from "node:process"
import fs from "fs-extra"
import yaml from "js-yaml"
import ttfMeta from "ttfmeta"
import { fdir } from "fdir"
import { getCategoryInfo } from "../deploy/deploy-categories.js"
import { parseResourcePath, getResourceTypesGlob, getPositiveCoverImagesGlob, getFontsGlob, determineFontWeight } from "../helpers/helpers.js"
import {
    ASSETS_URL,
    SOURCE_DIR,
    RESOURCE_COVERS,
    CATEGORIES_DIRNAME,
    CATEGORY_INFO_FILENAME,
    CATEGORY_ASSETS_DIRNAME,
    AUTHORS_DIRNAME,
    AUTHORS_INFO_FILENAME,
    AUTHORS_ASSETS_DIRNAME,
    RESOURCE_INFO_FILENAME,
    RESOURCE_ASSETS_DIRNAME, DIST_DIR, API_DIST,
} from "../helpers/constants.js"

let mode = "local"

if (process && process.env && process.env.GITHUB_TOKEN) {
    mode = "remote"
}

let getCoverKey = function (cover) {
    return Object.keys(RESOURCE_COVERS).find(k => RESOURCE_COVERS[k] === cover).toLowerCase()
}

let groupResourceAssetsByResourceName = async function (resourceAssets) {
    return resourceAssets.reduce((resource, assetPath) => {
        const resourcePath = parseResourcePath(assetPath)
        const resourceKey = `${resourcePath.language}/${resourcePath.type}/${resourcePath.title}`
        resource[resourceKey] = resource[resourceKey] || []
        resource[resourceKey].push(assetPath)
        return resource
    }, {})
}

let transferCategoriesAssets = async function () {
    const categoriesImageAssets = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(4)
        .glob(`**/${CATEGORIES_DIRNAME}/**/assets/${getPositiveCoverImagesGlob()}`)
        .crawl(SOURCE_DIR)
        .sync();

    const categories = categoriesImageAssets.reduce((category, assetPath) => {
        const categoryPath = parseResourcePath(assetPath)
        const categoryKey = `${categoryPath.language}/${CATEGORIES_DIRNAME}/${categoryPath.title}`
        category[categoryKey] = category[categoryKey] || []
        category[categoryKey].push(assetPath)
        return category
    }, {})


    for (let category of Object.keys(categories)) {
        const categoryPath = parseResourcePath(category)
        const categoryInfoFile = `${SOURCE_DIR}/${categoryPath.language}/${CATEGORIES_DIRNAME}/${categoryPath.title}/${CATEGORY_INFO_FILENAME}`
        const categoryInfo = await getCategoryInfo(categoryInfoFile)

        if (!categoryInfo.covers) {
            categoryInfo.covers = {}
        }

        for (let categoryImageAsset of categories[category]) {
            const imageAssetPath = parseResourcePath(categoryImageAsset)

            Object.keys(RESOURCE_COVERS).map(k => {
                if (imageAssetPath.section === RESOURCE_COVERS[k]) {
                    categoryInfo.covers[getCoverKey(RESOURCE_COVERS[k])] = `${ASSETS_URL}/${categoryPath.language}/${CATEGORIES_DIRNAME}/${categoryPath.title}/${CATEGORY_ASSETS_DIRNAME}/${imageAssetPath.section}`
                    if (mode === "remote") fs.removeSync(`${SOURCE_DIR}/${categoryImageAsset}`)
                }
            })
        }
        if (mode === "remote") fs.outputFileSync(categoryInfoFile, yaml.dump(categoryInfo))
    }
}

let transferAuthorsAssets = async function () {
    const authorsImageAssets = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(4)
        .glob(`**/${AUTHORS_DIRNAME}/**/assets/${getPositiveCoverImagesGlob()}`)
        .crawl(SOURCE_DIR)
        .sync();

    const authors = authorsImageAssets.reduce((author, assetPath) => {
        const authorPath = parseResourcePath(assetPath)
        const authorKey = `${authorPath.language}/${AUTHORS_DIRNAME}/${authorPath.title}`
        author[authorKey] = author[authorKey] || []
        author[authorKey].push(assetPath)
        return author
    }, {})


    for (let author of Object.keys(authors)) {
        const authorPath = parseResourcePath(author)
        const authorInfoFile = `${SOURCE_DIR}/${authorPath.language}/${AUTHORS_DIRNAME}/${authorPath.title}/${AUTHORS_INFO_FILENAME}`
        const authorInfo = await getCategoryInfo(authorInfoFile)

        if (!authorInfo.covers) {
            authorInfo.covers = {}
        }

        for (let authorImageAsset of authors[author]) {
            const imageAssetPath = parseResourcePath(authorImageAsset)

            Object.keys(RESOURCE_COVERS).map(k => {
                if (imageAssetPath.section === RESOURCE_COVERS[k]) {
                    authorInfo.covers[getCoverKey(RESOURCE_COVERS[k])] = `${ASSETS_URL}/${authorPath.language}/${AUTHORS_DIRNAME}/${authorPath.title}/${AUTHORS_ASSETS_DIRNAME}/${imageAssetPath.section}`
                    if (mode === "remote") fs.removeSync(`${SOURCE_DIR}/${authorImageAsset}`)
                }
            })
        }

        if (mode === "remote") fs.outputFileSync(authorInfoFile, yaml.dump(authorInfo))
    }
}

let transferResourcesAssets = async function () {
    const resourceImageAssets = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(4)
        .glob(`**/${getResourceTypesGlob()}/**/${RESOURCE_ASSETS_DIRNAME}/${getPositiveCoverImagesGlob()}`)
        .crawl(SOURCE_DIR)
        .sync();

    const resources = await groupResourceAssetsByResourceName(resourceImageAssets)

    for (let resource of Object.keys(resources)) {
        const resourcePath = parseResourcePath(resource)
        const resourceInfoFile = `${SOURCE_DIR}/${resourcePath.language}/${resourcePath.type}/${resourcePath.title}/${RESOURCE_INFO_FILENAME}`
        const resourceInfo = yaml.load(fs.readFileSync(resourceInfoFile, "utf8"));

        if (!resourceInfo.covers) {
            resourceInfo.covers = {}
        }

        for (let resourceImageAsset of resources[resource]) {
            const imageAssetPath = parseResourcePath(resourceImageAsset)

            Object.keys(RESOURCE_COVERS).map(k => {
                if (imageAssetPath.document === RESOURCE_COVERS[k]) {
                    resourceInfo.covers[getCoverKey(RESOURCE_COVERS[k])] = `${ASSETS_URL}/${resourcePath.language}/${resourcePath.type}/${resourcePath.title}/${RESOURCE_ASSETS_DIRNAME}/${imageAssetPath.document}`
                    if (mode === "remote") fs.removeSync(`${SOURCE_DIR}/${resourceImageAsset}`)
                    if (mode === "local") {
                        fs.copySync(`${SOURCE_DIR}/${resourceImageAsset}`,
                                    `${API_DIST}/${resourceImageAsset}`)
                    }
                }
            })
        }
        if (mode === "remote") fs.outputFileSync(resourceInfoFile, yaml.dump(resourceInfo))
    }
}

let transferResourcesFonts = async function () {
    const resourceFontAssets = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(6)
        .glob(`**/${getResourceTypesGlob()}/**/${RESOURCE_ASSETS_DIRNAME}/${getFontsGlob()}`)
        .crawl(SOURCE_DIR)
        .sync();

    const resources = await groupResourceAssetsByResourceName(resourceFontAssets)

    for (let resource of Object.keys(resources)) {
        const resourcePath = parseResourcePath(resource)
        const resourceInfoFile = `${SOURCE_DIR}/${resourcePath.language}/${resourcePath.type}/${resourcePath.title}/${RESOURCE_INFO_FILENAME}`
        const resourceInfo = yaml.load(fs.readFileSync(resourceInfoFile, "utf8"));

        if (!resourceInfo.fonts) {
            resourceInfo.fonts = []
        }

        for (let resourceFontAsset of resources[resource]) {
            const remoteURL = `${ASSETS_URL}/${resourceFontAsset}`

            if (!resourceInfo.fonts.find(f => f.src === remoteURL)) {
                try {
                    let fontInfo = await ttfMeta.promise(`${SOURCE_DIR}/${resourceFontAsset}`)
                    let postScriptName = fontInfo.meta.property.find(p => p.name === "postscript-name")
                    if (postScriptName) {
                        postScriptName = postScriptName.text.replaceAll("\x00", "")
                        let weight = await determineFontWeight(postScriptName)
                        if (weight) {
                            // weird bug of the ttfInfo library, replacing \x00 with nothing
                            resourceInfo.fonts.push({
                                name: postScriptName,
                                weight: parseInt(weight),
                                src: remoteURL.replace(/ /g, '%20'),
                            })
                            if (mode === "remote") fs.removeSync(`${SOURCE_DIR}/${resourceFontAsset}`)
                        }
                    }
                } catch (e) {
                    console.error(`Skipping adding font`, e)
                }
            }
        }

        if (mode === "remote")
            fs.outputFileSync(resourceInfoFile, yaml.dump(resourceInfo))
    }
}

let transferResourceAssets = async function () {
    await transferCategoriesAssets()
    await transferAuthorsAssets()
    await transferResourcesAssets()
    await transferResourcesFonts()
}

await transferResourceAssets()