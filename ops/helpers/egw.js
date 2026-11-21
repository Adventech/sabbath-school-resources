import searchEGW from "@Adventech/egw-tools"
import { getLanguageInfoSync } from "../deploy/deploy-languages.js"
import { protectLinks, restoreLinks } from "./links.js"

let languageInfoGlobal = {}

export const getEGWData = async function (resourcePath, text) {
    if (!languageInfoGlobal[resourcePath.language]) {
        const languageInfo = getLanguageInfoSync(resourcePath.language)
        languageInfoGlobal[resourcePath.language] = languageInfo
    }

    if (languageInfoGlobal[resourcePath.language].egw) {
        // Do not detect EGW references inside existing hyperlinks
        const { text: maskedText, links } = protectLinks(text)
        const result = await searchEGW.searchEGW(resourcePath.language, maskedText)
        if (result && typeof result.output === "string") {
            result.output = restoreLinks(result.output, links)
        }
        return result
    }

    return null
}

