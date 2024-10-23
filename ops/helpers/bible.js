import bibleSearchBCV from "@Adventech/bible-tools/bible_tools_bcv.js"
import { superscript } from "./blocks/index.js"
import { getLanguageInfoSync } from "../deploy/deploy-languages.js"

let languageInfoGlobal = {}

export const getBibleData = function (resourcePath, text) {
    let outputText
    let bibleData = []
    let bibleVersionsArray = []
    if (languageInfoGlobal[resourcePath.language]) {
        bibleVersionsArray = bibleVersionsArray.concat(languageInfoGlobal[resourcePath.language].bible ?? [])
    } else {
        const languageInfo = getLanguageInfoSync(resourcePath.language)
        languageInfoGlobal[languageInfo.code] = languageInfo
        bibleVersionsArray = bibleVersionsArray.concat(languageInfo.bible ?? [])
    }

    for (let bibleVersion of bibleVersionsArray) {
        let bibleCopyright = null
        let bibleVersionName = bibleVersion

        if (bibleVersion.name) {
            bibleCopyright = bibleVersion.copyright;
            bibleVersionName = bibleVersion.name;
        }

        let bibleSearchResult

        try {
            bibleSearchResult = bibleSearchBCV.search(resourcePath.language, bibleVersionName, text, true)

            if (!outputText) {
                outputText = bibleSearchResult.output
            }
        } catch (e) {
            bibleSearchResult = null
        }

        if (!bibleSearchResult) continue;

        if (bibleSearchResult.verses.length) {
            let newBibleData = {}
            newBibleData["name"] = bibleVersionName.toUpperCase()
            newBibleData["verses"] = bibleSearchResult.verses.reduce(function (result, item) {
                let key = Object.keys(item)[0]
                const verse = item[key]
                result[key] = superscript(verse)
                if (bibleCopyright) {
                    result[key] = result[key] + bibleCopyright
                }
                return result;
            }, {});

            bibleData.push(newBibleData)
        }
    }

    return {text: outputText ?? text, bibleData}
}

