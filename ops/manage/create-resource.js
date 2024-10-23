import fs from "fs-extra"
import yargs from "yargs"
import yaml from "js-yaml"
import process from "node:process"
import { fdir } from "fdir"
import { hideBin } from "yargs/helpers"
import { slug, pad } from "../helpers/helpers.js"
import {
    RESOURCE_TYPE,
    RESOURCE_KIND,
    SOURCE_DIR,
    OPS_DIR_MANAGE_LANGUAGE_INFO,
    BIBLES_LOCATION,
    RESOURCE_INFO_FILENAME,
    LANGUAGE_INFO_FILENAME,
    OPS_DIR_MANAGE_RESOURCE_ASSETS,
    RESOURCE_ASSETS_DIRNAME
} from "../helpers/constants.js"

const args = yargs(hideBin(process.argv))
    .option("lang", {
        alias: "l",
        describe: "Language of the resource",
        default: "en",
    })
    .option("title", {
        alias: "t",
        describe: "Title of the resource",
        default: "Title",
    })
    .option("subtitle", {
        alias: "s",
        describe: "Subtitle of the resource",
        default: "Subtitle",
    })
    .option("description", {
        alias: "d",
        describe: "Description of the resource",
        default: "Description",
    })
    .option("kind", {
        alias: "k",
        describe: "Subtitle of the resource",
        default: RESOURCE_KIND.BOOK,
        choices: [
            RESOURCE_KIND.BOOK,
            RESOURCE_KIND.DEVOTIONAL,
            RESOURCE_KIND.PLAN,
            RESOURCE_KIND.EXTERNAL,
            RESOURCE_KIND.BLOG,
            RESOURCE_KIND.MAGAZINE,
        ]
    })
    .option("type", {
        alias: "a",
        describe: "Type of the resource",
        default: RESOURCE_TYPE.DEVO,
        choices: [
            RESOURCE_TYPE.DEVO,
            RESOURCE_TYPE.PM,
        ]
    })
    .option("documents_num", {
        alias: "n",
        describe: "Number of documents",
        default: 10,
    })
    .option("prefix", {
        alias: "p",
        describe: "Document prefix",
        default: "",
    })
    .option("sections", {
        alias: "m",
        describe: "Number of sections",
        default: 1,
    })
    .argv

// TODO: support document type PDF, video

let createResource = async function () {
    const title = args.title
    const subtitle = args.subtitle
    const description = args.description
    const titleSlug = slug(title)
    const lang = args.lang
    const type = args.type
    const kind = args.kind
    const resourcePath = `${SOURCE_DIR}/${lang}/${type}/${titleSlug}`
    const numDocuments = args.documents_num
    const documentPrefix = args.prefix
    const sections = args.sections

    const resourceInfo = {
        title,
        kind,
        subtitle,
        description
    }

    if (fs.pathExistsSync(`${resourcePath}`)) {
        console.error("Specified resource already exists. Exiting", resourcePath)
        return
    }

    if (!fs.pathExistsSync(`./src/${lang}`)) {
        console.log("Specified language does not exist. Creating...", lang)
        const languageInfo = yaml.load(fs.readFileSync(OPS_DIR_MANAGE_LANGUAGE_INFO, "utf8"))
        languageInfo.code = lang
        languageInfo.name = "Language name in English"
        languageInfo.native = "Language name in language"
        languageInfo.kinds = Object.keys(RESOURCE_KIND).reduce((obj, key) => ({ ...obj, [RESOURCE_KIND[key]]: RESOURCE_KIND[key] }), {})
        languageInfo.bible = languageInfo.bible || []

        if (fs.pathExistsSync(`${BIBLES_LOCATION}/${lang}`)) {
            const bibles = new fdir()
                .withBasePath()
                .withRelativePaths()
                .withMaxDepth(1)
                .glob("**/info.js")
                .crawl(`${BIBLES_LOCATION}/${lang}`)
                .sync()
            for (let bible of bibles) {
                const bibleInfo = await import(`../../${BIBLES_LOCATION}/${lang}/${bible}`)
                languageInfo.bible.push(bibleInfo.default.version)
            }
        }

        fs.outputFileSync(`./src/${lang}/${LANGUAGE_INFO_FILENAME}`, yaml.dump(languageInfo))
    }

    fs.copySync(OPS_DIR_MANAGE_RESOURCE_ASSETS, `${resourcePath}/${RESOURCE_ASSETS_DIRNAME}/`)

    fs.outputFileSync(`${resourcePath}/${RESOURCE_INFO_FILENAME}`, yaml.dump(resourceInfo))

    let createDocs = function (sectionName) {
        for (let i = 1; i <= numDocuments; i++) {
            fs.outputFileSync(
                `${resourcePath}/${sectionName ? `${sectionName}/` : ""}${documentPrefix}${pad(i, (Math.max(2, (numDocuments+"").length)))}.md`,
                `---\ntitle: Document ${i}\n---`
            )
        }
    }

    // TODO: gen annual devotional split by month
    // TODO: gen weekly devotional split by week
    if (sections > 1) {
        for (let s = 1; s <= sections; s++) {
            createDocs(`section-${pad(s, (Math.max(2, (sections+"").length)))}`)
        }
    } else {
        createDocs()
    }
}

await createResource()