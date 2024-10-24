import process from "process"
import https from "https"
import { imageSize } from "image-size"
import { fileURLToPath } from "url"
import { createRequire } from "module"
import yargParser from "yargs-parser"
import fs from "fs-extra"
import { hideBin } from "yargs/helpers"
import {
    SOURCE_DIR,
    RESOURCE_TYPE,
    RESOURCE_COVERS,
    RESOURCE_FONTS_DIRNAME,
    RESOURCE_ASSETS_DIRNAME,
    OPS_SYNC_ASSET_EXTENSIONS,
    SEGMENT_FILENAME_EXTENSION,
    DOCUMENT_INFO_FILENAME,
    SECTION_INFO_FILENAME, LANGUAGE_INFO_FILENAME, RESOURCE_FEED_FILENAME
} from "./constants.js"

const options = {
    alias: {
        lang: 'l',
        types: 't',
        resource: 'r',
    },
    default: {
        lang: '*',
        types: '*',
        resource: '*',
    },
    description: {
        lang: 'Language',
        types: 'Types',
        resource: 'Resource',
    }
};

const args = yargParser.detailed(hideBin(process.argv), options)

async function getBufferFromUrl(url) {
    return new Promise((resolve) => {
        https.get(url, (response) => {
            const body = []
            response
                .on("data", (chunk) => {
                    body.push(chunk)
                })
                .on("end", () => {
                    resolve(Buffer.concat(body))
                })
        })
    })
}

let determineFontWeight = async function (fontStr) {
    const weights = {
        100: /Thin|Hairline/i,
        200: /(Extra|Ultra)([- _])?Light/i,
        300: /Light/i,
        400: /Normal|Regular/i,
        500: /Medium/i,
        600: /(Semi|Demi)([- _])?Bold/i,
        700: /Bold/i,
        800: /((Extra|Ultra)([- _])?Bold)|Heavy/i,
        900: /Black/i,
    }
    for (let weight of Object.keys(weights)) {
        if (weights[weight].test(fontStr)) {
            return weight
        }
    }
    return 400
}

let getImageRatio = async function (src) {
    const DEFAULT_IMAGE_RATIO = 16/9
    const DECIMAL_POINTS = 3
    try {
        const dimensions = await imageSize(src)
        return parseFloat((dimensions.width / dimensions.height).toFixed(DECIMAL_POINTS))
    } catch (e) {
        return parseFloat(DEFAULT_IMAGE_RATIO.toFixed(DECIMAL_POINTS))
    }
}

let isURL = function (src) {
    return /^http/.test(src.trim())
}

let slug = function (input) {
    return input.replace(/\s|—/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/-+$/g, "").toLowerCase()
};

let pad = function(num, size) {
    let s = num + ""
    while (s.length < size) s = "0" + s
    return s
}

let escapeAssetPathForSed = function (assetPath) {
    return assetPath.replace(/([\[\]()\\\/*&])/g, `\\$1`)
}

let getResourceTypesGlob = function () {
    return `+(${Object.values(RESOURCE_TYPE).join("|")})`
}

let getPositiveCoverImagesGlob = function () {
    return `+(${Object.values(RESOURCE_COVERS).join("|")})`
}

let getFontsGlob = function () {
    return `${RESOURCE_FONTS_DIRNAME}/*.ttf`
}

let getNegativeCoverImagesGlob = function () {
    return `!(${Object.values(RESOURCE_COVERS).join("|")})`
}

let parseResourcePath = function (resourcePath) {

    if (/^\.?\/?src\//.test(resourcePath)) {
        resourcePath = resourcePath.replace(`${SOURCE_DIR}/`, "")
    }

                 //   1           2           3          4            5         6
                 //   /en         /devo       /title     /document    /segment
                 //   /en         /devo       /title     /section    /document  /segment
    let pathRegExp = /^([^\/]+)?\/?([^\/]+)?\/?([^\/]+)?\/?([^\/]+)?\/?([^\/]+)?\/?([^\/]+)?/mg,
        matches = pathRegExp.exec(resourcePath),
        info = {};


    try {
        info.language = matches[1] || null
        info.type = matches[2] || null
        info.title = matches[3] || null
        info.section = null
        info.document = null
        info.segment = null

        if (matches[4] && matches[4] === RESOURCE_ASSETS_DIRNAME){
            info.section = matches[4]

            if (matches[5] && new RegExp(`(${OPS_SYNC_ASSET_EXTENSIONS.join("|")})$`).test(matches[5])) {
                info.document = matches[5]
            }
            return info
        }

        if (matches[4] && !matches[5]) {
            info.section = null
            info.document = matches[4]
        }

        if (matches[4] && matches[5] && !matches[6] && !(new RegExp(`${DOCUMENT_INFO_FILENAME}|${SEGMENT_FILENAME_EXTENSION}$`).test(matches[5]))) {
            info.section = null
            info.document = matches[4]
        }

        if (matches[4] && matches[5]) {
            // info.section = null
            // info.document = matches[4]
            // info.segment = matches[5]

            // Only section info
            // ex: en/devo/resource/section-name/section.yml
            if (new RegExp(`${SECTION_INFO_FILENAME}$`).test(matches[5])) {
                info.section = matches[4]
            }

            // Root level document
            // ex: en/devo/resource/document-name/info.yml
            if (new RegExp(`${DOCUMENT_INFO_FILENAME}$`).test(matches[5])) {
                info.section = null
                info.document = matches[4]
            }

            // Root level document segment or asset
            // ex: en/devo/resource/content/document-name/segment.md
            let regex = new RegExp(`(${OPS_SYNC_ASSET_EXTENSIONS.map(ext => ext.replace('.', '\\.')).join('|')})$`, 'i')

            if (new RegExp(`${SEGMENT_FILENAME_EXTENSION}$`).test(matches[5]) || regex.test(matches[5])) {
                info.section = null
                info.document = matches[4]
                info.segment = matches[5]
            }

            if (matches[6]) {
                // Document info
                // ex: en/devo/resource/content/section-name/document-name/info.yml
                if (new RegExp(`${DOCUMENT_INFO_FILENAME}$`).test(matches[6])) {
                    info.section = matches[4]
                    info.document = matches[5]
                }

                // Document Segment
                // ex: en/devo/resource/content/section-name/document-name/segment.md
                if (new RegExp(`${SEGMENT_FILENAME_EXTENSION}$`).test(matches[6]) || regex.test(matches[6])) {
                    info.section = matches[4]
                    info.document = matches[5]
                    info.segment = matches[6]
                }
            } else if (!new RegExp(`${DOCUMENT_INFO_FILENAME}|${SEGMENT_FILENAME_EXTENSION}$`).test(matches[5]) && !regex.test(matches[5])) {
                info.section = matches[4]
                info.document = matches[5]
            }
        }

        if (info.document) { info.document = info.document.replace(SECTION_INFO_FILENAME, "") }
        if (info.document) { info.document = info.document.replace(DOCUMENT_INFO_FILENAME, "") }
        if (info.segment) { info.segment = info.segment.replace(SEGMENT_FILENAME_EXTENSION, "") }

    } catch (e) {
        console.error(`Error parsing resource path: ${e}`);
    }

    return info;
}

let isMainModule = function (meta) {
    if (!meta || !process.argv[1]) {
        return false;
    }
    const require = createRequire(meta.url)
    const scriptPath = require.resolve(process.argv[1])
    const modulePath = fileURLToPath(meta.url)

    return modulePath === scriptPath
}

let getCurrentQuarterGlob = function (d, strict, includePrevious, postfix) {
    d = d || new Date()
    let quarterIndex = (Math.ceil((d.getMonth() + 1) / 3)),
        nextQuarter = (quarterIndex <= 3) ? d.getFullYear() + "-0" + (quarterIndex + 1) : (d.getFullYear() + 1) + "-01"

    let ret = `+(${includePrevious ? getPreviousQuarter() + "|" : ''}${d.getFullYear()}-0${quarterIndex}|${nextQuarter}${postfix ? '|'+postfix : ''})`
    if (!strict) {
        ret = `${ret}*`
    }

    return ret
}

let getCurrentQuarter = function () {
    let d = new Date();
    let quarterIndex = (Math.ceil((d.getMonth() + 1) / 3))

    return `${d.getFullYear()}-0${quarterIndex}`
}

let getPreviousQuarter = function () {
    let d = new Date()
    let quarterIndex = (Math.ceil((d.getMonth() + 1) / 3))
    let prevQuarter = (quarterIndex === 1) ? (d.getFullYear() - 1) + "-04" : (d.getFullYear()) + `-0${(quarterIndex - 1)}`

    return `${prevQuarter}`
};

let getNextQuarter = function () {
    let d = new Date();
    let quarterIndex = (Math.ceil((d.getMonth() + 1) / 3));
    let nextQuarter = (quarterIndex <= 3) ? d.getFullYear() + "-0" + (quarterIndex + 1) : (d.getFullYear() + 1) + "-01";

    return `${nextQuarter}`
};

let deepMerge = function (target, source) {
    const output = { ...target }; // Create a shallow copy of the target object
    if (typeof target === 'object' && typeof source === 'object') {
        for (const key in source) {
            if (source[key] instanceof Object && !(source[key] instanceof Array)) {
                // If the property is an object, recursively merge it
                output[key] = deepMerge(target[key] || {}, source[key]);
            } else {
                // Otherwise, just copy the value (arrays are shallowly copied)
                output[key] = source[key];
            }
        }
    }
    return output;
}

export const arg = {}

if (!args.defaulted.lang
    || !args.defaulted.lang
    || !args.defaulted.lang) {
    arg[args.argv.lang] = {
        [args.argv.types] : {
            resources: args.argv.resource,
        }
    }
} else if (fs.pathExistsSync('./.github/outputs/all_changed_files.json')) {
    const data = await fs.readFile('./.github/outputs/all_changed_files.json', 'utf-8')

    try {
        const changedFiles = JSON.parse(data)

        if (changedFiles && changedFiles.length) {
            changedFiles.filter((f) => /^src\//.test(f))
                .map((f) => {
                    const p = f.replace(/\.?\/?src\//, '')
                    const changedFilePath = parseResourcePath(p)

                    const language = changedFilePath.language
                    let type = changedFilePath.type
                    let r = changedFilePath.title

                    if (r === RESOURCE_FEED_FILENAME) {
                        r = "*"
                    } else {
                        if (type === LANGUAGE_INFO_FILENAME) {
                            type = "ss"
                        }

                        // TODO: consider not having the forced current quarter
                        if (type === "ss") {
                            r = getCurrentQuarterGlob()
                        }
                    }

                    if (!arg[language]) {
                        arg[language] = {
                            [type]: {
                                resources: [r],
                            }
                        }
                    } else {
                        if (!arg[language][type]) {
                            arg[language][type] = {
                                resources: []
                            }
                        }
                        arg[language][type].resources.push(r)
                    }
                }
            )
        }

        for (let argLanguage of Object.keys(arg)) {
            for (let argType of Object.keys(arg[argLanguage])) {
                arg[argLanguage][argType].resources = [...new Set(arg[argLanguage][argType].resources)]

                if (arg[argLanguage][argType].resources.length > 1) {
                    arg[argLanguage][argType].resources = `(${arg[argLanguage][argType].resources.join('|')})`
                } else {
                    arg[argLanguage][argType].resources = arg[argLanguage][argType].resources.join('')
                }
            }
        }
    } catch (e) {
        console.log(e)
    }
} else {
    // Default if nothing is provided
    arg['**'] = {
        '**': {
            resources: getCurrentQuarterGlob()
        }
    }
}

export {
    parseResourcePath,
    isMainModule,
    slug,
    pad,
    getResourceTypesGlob,
    getPositiveCoverImagesGlob,
    getNegativeCoverImagesGlob,
    getFontsGlob,
    escapeAssetPathForSed,
    getImageRatio,
    isURL,
    getBufferFromUrl,
    determineFontWeight,
    getCurrentQuarterGlob,
    getPreviousQuarter,
    getCurrentQuarter,
    getNextQuarter,
    deepMerge,
}