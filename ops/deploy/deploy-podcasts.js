#!/usr/bin/env node
"use strict"

import fs from "fs-extra"
import yaml from "js-yaml"
import { fdir } from "fdir"
import {dateToRFC822, getCurrentQuarterGlob, parseResourcePath} from "../helpers/helpers.js"
import {
    API_DIST,
    API_URL_AIJ_BEGINNER, API_URL_AIJ_KINDERGARTEN, API_URL_AIJ_PRIMARY, API_URL_INVERSE,
    API_URL_SS, DIST_DIR,
    DOCUMENT_INFO_FILENAME, MEDIA_URL, MEDIA_URL_LEGACY,
    RESOURCE_AUDIO_FILENAME,
    RESOURCE_TYPE,
    SOURCE_DIR
} from "../helpers/constants.js";
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import crypto from "crypto";
import path from "path";

let getAllAudioYmlForPodcast = function () {
    return new fdir()
        .withBasePath()
        .withRelativePaths()
        .withMaxDepth(3)
        .glob(`*/*/${getCurrentQuarterGlob(null, true)}*/${RESOURCE_AUDIO_FILENAME}`)
        .crawl(SOURCE_DIR)
        .sync()
        .map(i => `${SOURCE_DIR}/${i}`)
}

let processAudioYml = async function () {
    let audioYmls = getAllAudioYmlForPodcast()
    for (let audioYml of audioYmls) {
        let audioSource = yaml.load(fs.readFileSync(audioYml, "utf-8"));

        for (let artist of audioSource?.audio) {
            if (artist.podcast) {
                await processPodcast(audioYml, artist)
            }
        }
    }
}

let filterExactDuplicates = function(items) {
    const seen = new Set()

    return items.reduce((acc, item) => {
        if (!seen.has(item.target)) {
            seen.add(item.target)
            acc.push(item)
        }
        return acc
    }, [])
}

let isTodayOrPast = function(startDateStr) {
    const [day, month, year] = startDateStr.split('/').map(Number)
    const startDate = new Date(year, month - 1, day)
    const today = new Date()

    startDate.setHours(0, 0, 0, 0)
    today.setHours(0, 0, 0, 0)

    return startDate <= today
}

let constructPodcastItemObject = function(title, image, duration, description, url, contentLink) {
    if (!title || !url) {
        return null
    }

    return {
        title,
        'itunes:title': title,
        ...(image && {
            'itunes:image': {
                '@_href': image
            }
        }),
        ...(duration && {
            'itunes:duration': duration
        }),
        'itunes:explicit': 'No',
        'itunes:subtitle': {
            '#cdata': ` ${description || title} `,
        },
        'itunes:summary': {
            '#cdata': ` ${description || title} `,
        },
        description: {
            '#cdata': ` ${description || title} `,
        },
        pubDate: (new Date()).toUTCString(),
        guid: url,
        contentLink: contentLink || url,
        enclosure: {
            '@_url': url,
            '@_length': '0',
            '@_type': 'audio/mpeg'
        },
    }
}

let getContentLinkFromTarget = function (target) {
    let resourcePath = parseResourcePath(target)
    if (resourcePath.type === RESOURCE_TYPE.AIJ) {
        if (/-bg$/.test(resourcePath.title)) {
            return `${API_URL_AIJ_BEGINNER()}/resources/${target}`
        }
        if (/-kd$/.test(resourcePath.title)) {
            return `${API_URL_AIJ_KINDERGARTEN()}/resources/${target}`
        }
        if (/-pr$/.test(resourcePath.title)) {
            return `${API_URL_AIJ_PRIMARY()}/resources/${target}`
        }
    } else if (resourcePath.type === RESOURCE_TYPE.SS) {
        if (/-cq$/.test(resourcePath.title)) {
            return `${API_URL_INVERSE()}/${target.replace(/ss\//, '')}`
        }
        return `${API_URL_SS()}/${target.replace(/ss\//, '')}`
    }
    return null
}

let getEnclosureUrl = function (artist, track) {
    let resourcePath = parseResourcePath(track.target)

    let targetForId = track.target

    if (resourcePath.type === RESOURCE_TYPE.SS) {
        targetForId = track.target.replace(/^([a-z]{2,3})\/ss\//, '$1/')
    }

    let extname = path.extname(track.src)

    if (!extname.length || extname.length <= 1 || extname.length > 4 || !/^\./.test(extname)) {
        extname = ".mp3"
    }

    let audioId = crypto.createHash('sha256').update(artist.artist + targetForId + track['src']).digest('hex')

    if (resourcePath.type === RESOURCE_TYPE.SS) {
        return `${MEDIA_URL_LEGACY}/audio/${resourcePath.language}/${resourcePath.title}/${audioId}/${audioId}${extname}`
    }

    return `${MEDIA_URL}/audio/${resourcePath.language}/${resourcePath.type}/${resourcePath.title}/${audioId}/${audioId}${extname}`
}

let processPodcast = async function (audioYml, artist) {
    let seedXML = await (await fetch(`https://absg.sspmadventist.org/assets/xml/${artist.podcast?.source}`)).text()

    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        cdataPropName: '#cdata'

    })

    const builder = new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        cdataPropName: '#cdata',
        suppressEmptyNode: true,
        format: true
    })

    const podcastDataOriginal = parser.parse(seedXML)
    const podcastData = parser.parse(seedXML)

    let changes = false

    // Take all podcast URLs
    let existingURLs = new Set(
        podcastData.rss?.channel?.item.map(item => item.enclosure?.['@_url']).filter(Boolean)
    )

    // Filter the diff with tracks
    let tracks = filterExactDuplicates(artist.tracks).filter(track => {
        return !existingURLs.has(getEnclosureUrl(artist, track))
    })

    for (let track of tracks) {
        let documentPath = `${SOURCE_DIR}/${track.target}/${DOCUMENT_INFO_FILENAME}`
        let document = yaml.load(fs.readFileSync(documentPath, "utf-8"))

        if (document.start_date && isTodayOrPast(document.start_date)) {
            const newPodcastData = constructPodcastItemObject(
                track.podcast?.title ?? track.title,
                artist.podcast?.image ?? track.podcast?.image,
                track.podcast?.duration,
                track.podcast?.description,
                getEnclosureUrl(artist, track),
                getContentLinkFromTarget(track.target) || track.src,
            )
            if (newPodcastData) {
                if (!changes) {
                    changes = true
                }
                console.log(`Finding podcast to add to ${audioYml}. ${track.target}`)
                podcastData.rss?.channel?.item.unshift(newPodcastData)
            }
        }
    }

    if (changes) {
        if (podcastData.rss?.channel?.lastBuildDate) {
            podcastData.rss.channel.lastBuildDate = (new Date()).toUTCString()
        }

        const xml = builder.build(podcastData)
        const xmlOriginal = builder.build(podcastDataOriginal)
        const dateString = new Date().toISOString().slice(0, 10).replace(/-/g, '/');

        fs.outputFileSync(`${DIST_DIR}/${artist.podcast?.source}`, xml)
        fs.outputFileSync(`${DIST_DIR}/${dateString}/${artist.podcast?.source}`, xmlOriginal)
    }
}

await processAudioYml()