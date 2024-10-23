export const superscript = function (text) {
    let ret = text
    if (ret) {
        let sspmSuperscript = /(<sup>)(.*?)(<\/sup>)/img
        let sspmSuperscriptMatch = ret.match(sspmSuperscript)

        if (sspmSuperscriptMatch && sspmSuperscriptMatch.length > 0) {
            for (let match of sspmSuperscriptMatch) {
                let superscript = match.replace(sspmSuperscript, "$2")

                ret = ret.replace(match, `^[${superscript}]({"style":{"text":{"offset": "sup"}}})`).trim()
            }
        }

        let sspmSubscript = /(<sub>)(.*?)(<\/sub>)/img
        let sspmSubscriptMatch = ret.match(sspmSubscript)

        if (sspmSubscriptMatch && sspmSubscriptMatch.length > 0) {
            for (let match of sspmSubscriptMatch) {
                let subscript = match.replace(sspmSubscript, "$2")
                ret = ret.replace(match, `^[${subscript}]({"style":{"text":{"offset": "sub"}}})`).trim()
            }
        }
    }

    return ret
}