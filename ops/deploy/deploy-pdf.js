import process from "node:process"
import yargs from "yargs"
import yaml from "js-yaml"
import fs from "fs-extra"
import crypto from "crypto"
import { hideBin } from "yargs/helpers"
import { fdir } from "fdir"
import { isMainModule, getCurrentQuarterGlob, parseResourcePath } from "../helpers/helpers.js"
import {
    MEDIA_URL,
    SOURCE_DIR,
    RESOURCE_TYPE,
    RESOURCE_PDF_FILENAME,
    API_DIST,
    DEPLOY_ENV, DOCUMENT_INFO_FILENAME
} from "../helpers/constants.js"
import { getDocumentInfoYml, getSegmentInfo } from "./deploy-documents.js"

const args = yargs(hideBin(process.argv))
    .option("mode", {
        alias: "m",
        describe: "Mode of operation",
        default: "gen",
    })
    .argv

const mode = args.mode

let deployPdf = async function () {
    let curlConfig = ""

    const pdfInfoFiles = new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(4)
        // TODO: reduce AIJ to the current quarter
        // Here we match current quarter for SS and all pdf.yml files for other resource types
        .glob(`*/{${RESOURCE_TYPE.SS}/${getCurrentQuarterGlob()},${RESOURCE_TYPE.AIJ}/*,${RESOURCE_TYPE.DEVO}/*,${RESOURCE_TYPE.PM}/*}/${RESOURCE_PDF_FILENAME}`)
        .crawl(SOURCE_DIR)
        .sync()

    for (let pdfInfoFile of pdfInfoFiles) {
        let pdfs = yaml.load(fs.readFileSync(`${SOURCE_DIR}/${pdfInfoFile}`, 'utf-8')),
            pdfPathInfo = parseResourcePath(pdfInfoFile)

        // empty or incorrectly formatted pdf
        if (!pdfs || !pdfs.pdf) { continue }

        let pdfsForAPI = []

        for (let [i, pdf] of pdfs.pdf.entries()) {
            if (!pdf.src) { continue }
            if (!pdf.target) {
                pdf.target = `${pdfPathInfo.language}/${pdfPathInfo.type}/${pdfPathInfo.title}/${String(i+1).padStart(2, '0')}`
            }
            pdf.id = crypto.createHash('sha256').update(pdf.target + pdf.src).digest('hex')
            pdf.targetIndex = pdf.target.replace(/\//g, '-')

            if (!pdf.title) {
                let pdfTargetInfo = parseResourcePath(`${SOURCE_DIR}/${pdf.target}`)

                if (!pdfTargetInfo.document) {
                    continue
                }

                if (pdfTargetInfo.segment) {
                    let segment = await getSegmentInfo(`${SOURCE_DIR}/${pdf.target}`)
                    if (!segment.title) { continue }
                    pdf.title = segment.title
                } else {
                    if (fs.pathExistsSync(`${SOURCE_DIR}/${pdf.target}/${DOCUMENT_INFO_FILENAME}`)) {
                        let document = await getDocumentInfoYml(`${SOURCE_DIR}/${pdf.target}/${DOCUMENT_INFO_FILENAME}`)
                        if (!document.title) { continue }
                        pdf.title = document.title
                    } else {
                        continue
                    }
                }
            }

            let extname = ".pdf"

            // Generate mode
            // Used in the CI/CD to create download list of PDFs but only if not already downloaded
            if (mode === "gen"
                && !fs.pathExistsSync(`media/pdf/${pdfPathInfo.language}/${pdfPathInfo.type}/${pdfPathInfo.title}/${pdf.id}/`)) {
                curlConfig += `
url = "${pdf.src}"
output = "media/pdf/${pdfPathInfo.language}/${pdfPathInfo.type}/${pdfPathInfo.title}/${pdf.id}/${pdf.id}${extname}"
-C -
--create-dirs
-L
`
            }

            // Keep mode
            // Used in CI/CD to create and empty .keep file for the newly downloaded PDFs which file size is non zero
            if (mode === "keep") {
                pdf.src = `${MEDIA_URL}/pdf/${pdfPathInfo.language}/${pdfPathInfo.type}/${pdfPathInfo.title}/${pdf.id}/${pdf.id}${extname}`
                if (fs.pathExistsSync(`media/pdf/${pdfPathInfo.language}/${pdfPathInfo.type}/${pdfPathInfo.title}/${pdf.id}/${pdf.id}${extname}`)) {
                    let stats = fs.statSync(`media/pdf/${pdfPathInfo.language}/${pdfPathInfo.type}/${pdfPathInfo.title}/${pdf.id}/${pdf.id}${extname}`)
                    if (stats.size > 0) {
                        fs.outputFileSync(`media/pdf/${pdfPathInfo.language}/${pdfPathInfo.type}/${pdfPathInfo.title}/${pdf.id}/.keep`, "")
                    }
                }

                if (fs.pathExistsSync(`media/pdf/${pdfPathInfo.language}/${pdfPathInfo.type}/${pdfPathInfo.title}/${pdf.id}/.keep`)
                    || DEPLOY_ENV === "local"
                ) {
                    pdfsForAPI.push(pdf)
                }
            }
        }

        if (mode === "keep") {
            fs.outputFileSync(`${API_DIST}/${pdfPathInfo.language}/${pdfPathInfo.type}/${pdfPathInfo.title}/pdf.json`, JSON.stringify(pdfsForAPI))
        }
    }

    if (mode === "gen" && curlConfig.trim().length > 1) {
        fs.outputFileSync(`curl-config.txt`, curlConfig)
    }
}

if (isMainModule(import.meta)) {
    await deployPdf()
}