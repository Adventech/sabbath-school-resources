import crypto from "crypto"

export const completion = {
    process: async function (text, blockId) {
        const completionRegex = /\[([^\]]+)\](\(\))/g

        let ret = {
            text,
            data: null,
        }

        const matches = [...text.matchAll(completionRegex)]

        let matchIterator = 0

        if (matches.length > 0) {
            matches.forEach((completionMatch) => {

                if (completionMatch[1] && completionMatch[2]) {
                    let correctCompletion = completionMatch[1]
                    let length = correctCompletion.length

                    if (/^_*$/.test(correctCompletion)) {
                        if (correctCompletion.length < 5) {
                            length = -1
                        }
                        correctCompletion = null
                    }

                    const id = crypto.createHash('sha256').update(`${blockId}-${matchIterator}-${correctCompletion ?? ''}`).digest('hex')

                    ret.text = ret.text.replace(completionMatch[0], `[](sspmCompletion://${id})`)

                    if (!ret.data) { ret.data = {} }

                    ret.data[id] = {
                        length,
                        placeholder: '_',
                        correctCompletion, // if null there is no correct answer
                    }
                }

                matchIterator++
            })

            return ret
        }

        return false
    },
}