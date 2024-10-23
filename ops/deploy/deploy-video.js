import crypto from "crypto"
import yaml from "js-yaml"
import fs from "fs-extra"
import path from "path"
import picomatch from "picomatch"
import yargs from "yargs"
import process from "node:process"
import { hideBin } from "yargs/helpers"
import { fdir } from "fdir"
import { getDocumentInfoYml, getSegmentInfo } from "./deploy-documents.js"
import { isMainModule, getCurrentQuarterGlob, parseResourcePath } from "../helpers/helpers.js"
import {
    RESOURCE_VIDEO_FILENAME,
    RESOURCE_TYPE,
    SOURCE_DIR,
    LANGUAGE_INFO_FILENAME,
    RESOURCE_FEED_FILENAME,
    MEDIA_URL, MEDIA_URL_LEGACY, ASSETS_URL, RESOURCE_ASSETS_DIRNAME,
    RESOURCE_COVERS, DOCUMENT_INFO_FILENAME, API_DIST
} from "../helpers/constants.js"

const args = yargs(hideBin(process.argv))
    .option("mode", {
        alias: "m",
        describe: "Mode of operation",
        default: "sync",
    })
    .argv

const mode = args.mode

let videoAPI = async function (mode) {
    console.log('Deploying video API');

    const allowedVideoItemKeys = ['title', 'src', 'thumbnail', 'target']
    let availableLanguages = []
    let curlConfig = []

    const videoLanguages = new fdir()
        .withBasePath()
        .withRelativePaths()
        .glob(`*/${LANGUAGE_INFO_FILENAME}`)
        .crawl(SOURCE_DIR)
        .sync()

    for (let videoLanguage of videoLanguages) {
        const languageInfo = parseResourcePath(videoLanguage)

        let languageVideos = []
        let videosPerResourceType = {}
        new fdir()
            .withBasePath()
            .withRelativePaths()
            .withMaxDepth(3)
            .glob(`${languageInfo.language}/{${RESOURCE_TYPE.SS}/${getCurrentQuarterGlob()},${RESOURCE_TYPE.AIJ}/*,${RESOURCE_TYPE.DEVO}/*,${RESOURCE_TYPE.PM}/*}/${RESOURCE_VIDEO_FILENAME}`)
            .crawl(SOURCE_DIR)
            .sync()
            .map(v => {
                const rawVideoPathInfo = parseResourcePath(v)
                if (!videosPerResourceType[rawVideoPathInfo.type]) {
                    videosPerResourceType[rawVideoPathInfo.type] = []
                }
                videosPerResourceType[rawVideoPathInfo.type].push(v)
            })


        for (let videoResourceType of Object.keys(videosPerResourceType)) {
            const feedFile = yaml.load(fs.readFileSync(`${SOURCE_DIR}/${languageInfo.language}/${videoResourceType}/${RESOURCE_FEED_FILENAME}`, "utf8"))

            let videos = videosPerResourceType[videoResourceType]
            let patterns = []

            feedFile.groups.forEach(group => {
                if (group.resources) {
                    patterns = patterns.concat(group.resources)
                }
            })

            // Normalizing sorting to make non-postfix resource like (en/ss/2025-01) to be above
            // resources with postfix, such as (en/ss/2025-01-cq) by default
            // In case if the the actual priority is different, that will be handled by the second sorting
            videos = videos.sort((a, b) => {
                const aPath = parseResourcePath(a)
                const bPath = parseResourcePath(b)

                let aTitle = aPath.title
                let bTitle = bPath.title

                if (/^\d{4}-\d{2}$/.test(aPath.title)) aTitle = aTitle + "_"
                if (/^\d{4}-\d{2}$/.test(bPath.title)) bTitle = bTitle + "_"

                if (aTitle < bTitle) return -1
                if (aTitle > bTitle) return 1
                return 0
            }).reverse()

            // Sorting by its priority based on the feed settings
            videos = videos.sort((a, b) => {
                const aPath = parseResourcePath(a)
                const bPath = parseResourcePath(b)

                let aPriority = patterns.findIndex(pattern => picomatch(pattern)(`${aPath.language}-${aPath.type}-${aPath.title}`))
                let bPriority = patterns.findIndex(pattern => picomatch(pattern)(`${bPath.language}-${bPath.type}-${bPath.title}`))

                aPriority = (aPriority === -1) ? Infinity : aPriority
                bPriority = (bPriority === -1) ? Infinity : bPriority

                if (aPriority < bPriority) return -1
                if (aPriority > bPriority) return 1
                return 0
            })

            for (let videoFilePath of videos) {
                const videoFile = yaml.load(fs.readFileSync(`${SOURCE_DIR}/${videoFilePath}`, "utf8"))
                const videoPathInfo = parseResourcePath(videoFilePath)
                let videoAPIJson = []

                for (let artist of videoFile.video) {
                    if (!artist.artist) { continue }

                    let artistVideo = {
                        artist: artist.artist,
                        clips: []
                    }

                    if (artist.thumbnail) {
                        artistVideo.thumbnail = artist.thumbnail
                    }

                    // Processing each clip found for an artist
                    for (let [i, clip] of artist.clips.entries()) {
                        if (!clip['src']) { continue }

                        if (!clip['target']) {
                            clip['target'] = `${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}}/${String(i+1).padStart(2, '0')}`
                        }

                        let videoItem = {
                            artist: artistVideo.artist
                        }

                        let targetForId = clip.target

                        // For already uploaded and processed videos from sabbath-school-lessons
                        // Generate matching ID
                        if (videoPathInfo.type === "ss") {
                            targetForId = targetForId.replace(/^([a-z]{2,3})\/ss\//, '$1/')
                        }

                        videoItem.id = crypto.createHash('sha256').update(artistVideo.artist + targetForId + clip['src']).digest('hex');

                        for (let k of Object.keys(clip)) {
                            if (allowedVideoItemKeys.indexOf(k) >= 0) {
                                videoItem[k] = clip[k]
                            }
                        }

                        let extname = path.extname(videoItem.src)

                        if (!extname.length || extname.length <= 1 || extname.length > 4 || !/^\./.test(extname)) {
                            extname = ".mp4"
                        }

                        videoItem.src = `${MEDIA_URL}/video/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/${videoItem.id}/${videoItem.id}${extname}`

                        // For already uploaded and processed videos from sabbath-school-lessons
                        // set the src to point to legacy storage
                        if (videoPathInfo.type === "ss") {
                            videoItem.src = `${MEDIA_URL_LEGACY}/video/${videoPathInfo.language}/${videoPathInfo.title}/${videoItem.id}/${videoItem.id}${extname}`
                        }

                        videoItem.targetIndex = videoItem.target.replace(/\//g, '-')

                        if (!videoItem.thumbnail) {
                            videoItem.thumbnail = artistVideo.thumbnail || `${ASSETS_URL}/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/${RESOURCE_ASSETS_DIRNAME}/${RESOURCE_COVERS.PORTRAIT}`
                        }

                        let thumbnailSrc = videoItem.thumbnail

                        let thumbExtname = path.extname(videoItem.thumbnail)

                        if (!thumbExtname.length || thumbExtname.length <= 1 || thumbExtname.length > 5 || !/^\./.test(thumbExtname)) {
                            thumbExtname = ".png"
                        }

                        videoItem.thumbnail = `${MEDIA_URL}/video/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/${videoItem.id}/thumb/${videoItem.id}${thumbExtname}`

                        if (videoPathInfo.type === "ss") {
                            videoItem.thumbnail = `${MEDIA_URL_LEGACY}/video/${videoPathInfo.language}/${videoPathInfo.title}/${videoItem.id}/thumb/${videoItem.id}${thumbExtname}`
                        }

                        // If no title specified, obtain the title
                        if (!videoItem.title) {
                            let videoItemInfo = parseResourcePath(`${SOURCE_DIR}/${videoItem.target}`)

                            if (!videoItemInfo.document) {
                                continue
                            }

                            if (videoItemInfo.segment) {
                                let segment = await getSegmentInfo(`${SOURCE_DIR}/${videoItem.target}`)
                                if (!segment.title) { continue }
                                videoItem.title = segment.title
                            } else {
                                if (fs.pathExistsSync(`${SOURCE_DIR}/${videoItem.target}/${DOCUMENT_INFO_FILENAME}`)) {
                                    let document = await getDocumentInfoYml(`${SOURCE_DIR}/${videoItem.target}/${DOCUMENT_INFO_FILENAME}`)
                                    if (!document.title) { continue }
                                    videoItem.title = document.title
                                } else {
                                    continue
                                }
                            }
                        }

                        artistVideo.clips.push(videoItem)

                        const videoClipLocalPath = `media/video/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/${videoItem.id}/`
                        const videoThumbnailLocalPath = `media/video/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/${videoItem.id}/thumb/`
                        const videoClipLocalFile = `media/video/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/${videoItem.id}/${videoItem.id}${extname}`
                        const videoThumbnailLocalFile = `media/video/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/${videoItem.id}/thumb/${videoItem.id}${thumbExtname}`
                        const videoDotKeepLocalFile = `media/video/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/${videoItem.id}/.keep`
                        const videoDotKeepThumbnailLocalFile = `media/video/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/${videoItem.id}/thumb/.keep`

                        // For already uploaded and processed videos from sabbath-school-lessons
                        // set paths that
                        if (videoPathInfo.type === "ss") {
                            videoItem.src = `${MEDIA_URL_LEGACY}/video/${videoPathInfo.language}/${videoPathInfo.title}/${videoItem.id}/${videoItem.id}${extname}`
                        }

                        // Keep mode. i.e creating .keep files for the downloaded videos & thumbnails
                        if (mode === "keep" && videoPathInfo.type !== "ss") {
                            if (fs.pathExistsSync(videoClipLocalFile)) {
                                let stats = fs.statSync(videoClipLocalFile)
                                if (stats.size > 0) {
                                    fs.outputFileSync(videoDotKeepLocalFile, "")
                                }
                            }

                            if (fs.pathExistsSync(videoThumbnailLocalFile)) {
                                let stats = fs.statSync(videoThumbnailLocalFile)
                                if (stats.size > 0) {
                                    fs.outputFileSync(videoDotKeepThumbnailLocalFile, "")
                                }
                            }
                        }

                        if (mode === "gen" && videoPathInfo.type !== "ss") {
                            if (!fs.pathExistsSync(videoClipLocalPath)) {
                                curlConfig.push(`
url = "${clip.src}"
output = "${videoClipLocalFile}"
-C -
--create-dirs
--globoff
--insecure
-L
`)
                            }
                            if (!fs.pathExistsSync(videoThumbnailLocalPath)) {
                                curlConfig.push(`
url = "${thumbnailSrc}"
output = "${videoThumbnailLocalFile}"
-C -
--create-dirs
--globoff
--insecure
-L
`)
                            }
                        }
                    }

                    if (artistVideo.clips.length) {
                        artistVideo.clips = artistVideo.clips.reverse()
                        videoAPIJson.push(artistVideo)

                        let languageVideoArtist = languageVideos.find(a => a.artist === artistVideo.artist)

                        if (!videoFile.skipFromLatest) {
                            if (languageVideoArtist) {
                                languageVideoArtist.clips = artistVideo.clips.concat(languageVideoArtist.clips)
                            } else {
                                languageVideos.push(artistVideo)
                            }
                        }
                    }
                }

                if (mode === "sync"
                    && videoAPIJson.length) {
                    fs.outputFileSync(`${API_DIST}/${videoPathInfo.language}/${videoPathInfo.type}/${videoPathInfo.title}/video.json`, JSON.stringify(videoAPIJson))
                }
            }
        }

        if (languageVideos.length) {
            for (let languageVideo of languageVideos) {
                languageVideo.clips = languageVideo.clips.slice(0, 14)
            }
            availableLanguages.push(languageInfo.language)
            fs.outputFileSync(`${API_DIST}/${languageInfo.language}/video/latest.json`, JSON.stringify(languageVideos))
        }
    }

    if (mode === "gen" && curlConfig.length >= 1) {
        const chunkSize = 10
        let iterator = 0
        for (let i = 0; i < curlConfig.length; i+=chunkSize) {
            const chunk = curlConfig.slice(i, i+chunkSize)
            fs.outputFileSync(`curl-config-${iterator}.txt`, chunk.join("\n\n"))
            iterator++
        }
    }

    if (availableLanguages.length) {
        fs.outputFileSync(`${API_DIST}/video/languages.json`, JSON.stringify(availableLanguages));
    }
};

if (isMainModule(import.meta)) {
    await videoAPI(mode)
}
