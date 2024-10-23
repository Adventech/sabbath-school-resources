import crypto from "crypto"
import yaml from "js-yaml"
import fs from "fs-extra"
import path from "path"
import yargs from "yargs"
import process from "node:process"
import { hideBin } from "yargs/helpers"
import { fdir } from "fdir"
import { getDocumentInfoYml, getSegmentInfo } from "./deploy-documents.js"
import { isMainModule, getCurrentQuarterGlob, parseResourcePath } from "../helpers/helpers.js"
import {
    RESOURCE_TYPE,
    SOURCE_DIR,
    MEDIA_URL,
    ASSETS_URL,
    RESOURCE_ASSETS_DIRNAME,
    RESOURCE_COVERS,
    DOCUMENT_INFO_FILENAME,
    API_DIST,
    RESOURCE_AUDIO_FILENAME,
    MEDIA_URL_LEGACY
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
    console.log('Deploying audio API');

    const allowedAudioItemKeys = ['title', 'src', 'image', 'imageRatio', 'target']
    let curlConfig = ""

    let audios = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(3)
        .glob(`*/{${RESOURCE_TYPE.SS}/${getCurrentQuarterGlob()},${RESOURCE_TYPE.AIJ}/*,${RESOURCE_TYPE.DEVO}/*,${RESOURCE_TYPE.PM}/*}/${RESOURCE_AUDIO_FILENAME}`)
        .crawl(SOURCE_DIR)
        .sync()


    for (let audio of audios) {
        let audioInfo = []
        let audioSource = yaml.load(fs.readFileSync(`${SOURCE_DIR}/${audio}`, "utf-8"));
        let info = parseResourcePath(audio)

        for (let artist of audioSource.audio) {
            let weekIterator = 1;
            for (let [i, track] of artist.tracks.entries()) {
                let audioItem = {
                    artist: artist.artist
                }
                if (!track['src'] || (!track['target'] && !artist['target'])) { continue }

                if (!track['target']) {
                    if (artist['target'] === 'daily') {
                        track['target'] = `${info.language}/${info.type}/${info.title}/${String(weekIterator).padStart(2, '0')}/${String(i+1 - ((weekIterator-1) * 7)).padStart(2, '0')}`
                    } else {
                        track['target'] = `${info.language}/${info.type}/${info.title}/${String(i+1).padStart(2, '0')}`
                    }
                    if ((i+1) % 7 === 0) {
                        weekIterator++
                    }
                }

                let targetForId = track.target

                // For already uploaded and processed videos from sabbath-school-lessons
                // Generate matching ID
                if (info.type === "ss") {
                    targetForId = targetForId.replace(/^([a-z]{2,3})\/ss\//, '$1/')
                }

                audioItem.id = crypto.createHash('sha256').update(artist.artist + targetForId + track['src']).digest('hex')

                for (let k of Object.keys(track)) {
                    if (allowedAudioItemKeys.indexOf(k) >= 0) {
                        audioItem[k] = track[k]
                    }
                }

                let extname = path.extname(audioItem.src)

                if (!extname.length || extname.length <= 1 || extname.length > 4 || !/^\./.test(extname)) {
                    extname = ".mp3"
                }

                audioItem.src = `${MEDIA_URL}/audio/${info.language}/${info.type}/${info.title}/${audioItem.id}/${audioItem.id}${extname}`

                // For already uploaded and processed videos from sabbath-school-lessons
                // set the src to point to legacy storage
                if (info.type === "ss") {
                    audioItem.src = `${MEDIA_URL_LEGACY}/audio/${info.language}/${info.title}/${audioItem.id}/${audioItem.id}${extname}`
                }

                audioItem.targetIndex = audioItem.target.replace(/\//g, '-')

                if (!audioItem.image) {
                    audioItem.image = artist.image || `${ASSETS_URL}/${info.language}/${info.type}/${info.title}/${RESOURCE_ASSETS_DIRNAME}/${RESOURCE_COVERS.PORTRAIT}`
                }

                if (!audioItem.imageRatio) {
                    audioItem.imageRatio = artist.imageRatio || "portrait"
                }

                if (!audioItem.title) {
                    let audioItemInfoTarget = audioItem.target

                    if (/^[a-z]{2,3}\/(.*?)\/(.*?)\/(.*?)\/(.*?)/.test(audioItemInfoTarget)) {
                        audioItemInfoTarget = `${audioItemInfoTarget}.md`
                    }

                    let audioItemInfo = parseResourcePath(`${audioItemInfoTarget}`)

                    if (!audioItemInfo.document) {
                        continue
                    }

                    if (audioItemInfo.segment) {
                        let segment = await getSegmentInfo(`${SOURCE_DIR}/${audioItemInfoTarget}`)
                        audioItem.title = segment.title
                    } else {

                        if (fs.pathExistsSync(`${SOURCE_DIR}/${audioItem.target}/${DOCUMENT_INFO_FILENAME}`)) {
                            let document = await getDocumentInfoYml(`${SOURCE_DIR}/${audioItem.target}/${DOCUMENT_INFO_FILENAME}`)
                            if (!document.title) { continue }
                            audioItem.title = document.title
                        } else {
                            continue
                        }
                    }
                }

                const audioClipLocalPath = `media/audio/${info.language}/${info.type}/${info.title}/${info.id}/`
                const audioClipLocalFile = `media/audio/${info.language}/${info.type}/${info.title}/${audioItem.id}/${audioItem.id}${extname}`
                const audioDotKeepLocalFile = `media/audio/${info.language}/${info.type}/${info.title}/${audioItem.id}/.keep`

                audioInfo.push(audioItem)

                if (mode === "keep"
                    && info.type !== "ss"
                    && fs.pathExistsSync(audioClipLocalFile)) {
                    let stats = fs.statSync(audioClipLocalFile);
                    if (stats.size > 0) {
                        fs.outputFileSync(audioDotKeepLocalFile, "");
                    }
                }

                if (mode === "gen"
                    && info.type !== "ss"
                    && !fs.pathExistsSync(audioClipLocalPath)) {
                    curlConfig += `
url = "${track.src.replace(/ /g, "\%20")}"
output = "${audioClipLocalFile}"
-C -
--create-dirs
-L
`
                }
            }
        }

        audioInfo = audioInfo.sort(function(a, b){
            if (a.targetIndex < b.targetIndex) {
                return (a.targetIndex.length < b.targetIndex.length) && a.targetIndex.length === 13 ? 1 : -1
            }

            if (a.targetIndex > b.targetIndex) {
                return (a.targetIndex.length > b.targetIndex.length) && a.targetIndex.length === 13 ? -1 : 1
            }
            return 0
        })

        if (mode === "sync") {
            if (audioInfo.length) {
                fs.outputFileSync(`${API_DIST}/${info.language}/${info.type}/${info.title}/audio.json`, JSON.stringify(audioInfo))
            }
        }
    }

    if (mode === "gen" && curlConfig.length >= 1) {
        fs.outputFileSync(`curl-config.txt`, curlConfig);
    }
};

if (isMainModule(import.meta)) {
    await videoAPI(mode)
}
