import searchEGW from "@Adventech/egw-tools"
import { getLanguageInfoSync } from "../deploy/deploy-languages.js"

let languageInfoGlobal = {}

export const getEGWData = async function (resourcePath, text) {
    if (!languageInfoGlobal[resourcePath.language]) {
        const languageInfo = getLanguageInfoSync(resourcePath.language)
        languageInfoGlobal[resourcePath.language] = languageInfo
    }

    if (languageInfoGlobal[resourcePath.language].egw) {
        return await searchEGW.searchEGW(resourcePath.language, text)
    }

    return null
}

