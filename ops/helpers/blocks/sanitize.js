import sanitizeHtml from 'sanitize-html';

export const sanitize = function (text) {
    let ret = text
    if (ret) {
        ret = sanitizeHtml(text, {
            allowedTags: [ ]
        })
    }
    return ret
}