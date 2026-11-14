import {
    RESOURCE_KIND,
    RESOURCE_PROGRESS_TRACKING,
    RESOURCE_ORDER,
    FEED_VIEWS,
    FEED_DIRECTION,
    FEED_SCOPES,
    SEGMENT_TYPES,
} from "../../helpers/constants.js"
import { styleSchema } from "../../helpers/blocks/style.js"

// NOTE: every object uses `additionalProperties: false`. The reporter downgrades
// "additionalProperties" violations to warnings (unknown keys are ignored by the
// deploy, but usually indicate a typo), while every other violation is an error.

const str = { type: "string" }
const bool = { type: "boolean" }
const strArray = { type: "array", items: str }
const color = { type: "string", pattern: "^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$" }

const textStyle = {
    type: "object",
    additionalProperties: false,
    properties: {
        typeface: str,
        color: color,
        size: { type: "string", enum: ["xs", "sm", "base", "lg", "xl"] },
        align: { type: "string", enum: ["start", "end", "center"] },
        offset: { type: "string", enum: ["sup", "sub"] },
    },
}

const textOnly = {
    type: "object",
    additionalProperties: false,
    properties: { text: textStyle },
}

const blockStyleGroup = {
    type: "object",
    additionalProperties: false,
    properties: {
        all: styleSchema,
        blocks: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["type", "style"],
                properties: {
                    type: str,
                    style: styleSchema,
                },
            },
        },
    },
}

// `style:` in resource info.yml, document info.yml and segment front matter
export const documentStyleSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        blocks: {
            type: "object",
            additionalProperties: false,
            properties: {
                inline: blockStyleGroup,
                nested: blockStyleGroup,
            },
        },
        resource: {
            type: "object",
            additionalProperties: false,
            properties: { title: textOnly, subtitle: textOnly, description: textOnly },
        },
        segment: {
            type: "object",
            additionalProperties: false,
            properties: { title: textOnly, subtitle: textOnly, date: textOnly },
        },
    },
}

// Inline `{"style": ...}` block prefix. Mirrors the schema used by the deploy so
// that "valid here" means "applied by the deploy".
export { styleSchema as inlineStyleSchema }

const share = {
    type: "object",
    properties: {
        shareCTA: bool,
        nolink: bool,
        personalize: bool,
        shareText: str,
        shareGroups: {
            type: "array",
            items: {
                type: "object",
                required: ["type"],
                properties: {
                    type: { type: "string", enum: ["link", "file"] },
                    title: str,
                    links: { type: "array", items: { type: "object", required: ["src"], properties: { title: str, src: str } } },
                    files: { type: "array", items: { type: "object", required: ["src"], properties: { title: str, src: str } } },
                },
            },
        },
    },
}

export const languageSchema = {
    type: "object",
    additionalProperties: false,
    required: ["name", "native", "code"],
    properties: {
        name: str,
        native: str,
        code: str,
        sections: { type: "object", properties: { default: str } },
        featuredResources: { type: "object", properties: { title: str } },
        egw: bool,
        bible: {
            type: "array",
            items: {
                anyOf: [
                    str,
                    { type: "object", required: ["name"], properties: { name: str, copyright: str } },
                ],
            },
        },
        features: {
            type: "object",
            additionalProperties: {
                type: "object",
                required: ["name", "title", "image"],
                properties: { name: str, title: str, description: str, image: str },
            },
        },
        feedSeeAll: str,
        deploymentReplacements: {
            type: "object",
            additionalProperties: false,
            properties: { collapse: strArray },
        },
        share: {
            type: "object",
            additionalProperties: false,
            properties: { shareText: str, shareLink: str, autoCTAPatterns: strArray },
        },
    },
}

export const resourceSchema = {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
        title: str,
        subtitle: str,
        description: str,
        markdownTitle: str,
        markdownSubtitle: str,
        markdownDescription: str,
        human_date: str,
        quarterly_name: str,
        start_date: str,
        end_date: str,
        startDate: str,
        endDate: str,
        color_primary: color,
        color_primary_dark: color,
        primaryColor: color,
        primaryColorDark: color,
        covers: {
            type: "object",
            additionalProperties: false,
            properties: { portrait: str, landscape: str, square: str, splash: str },
        },
        splash: bool,
        credits: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "value"],
                properties: { name: str, value: str },
            },
        },
        kind: { type: "string", enum: Object.values(RESOURCE_KIND) },
        features: strArray,
        featuredResources: strArray,
        featuredResourcesView: { type: "string", enum: Object.values(FEED_VIEWS) },
        preferredCover: { type: "string", enum: ["portrait", "landscape", "square", "splash"] },
        progressTracking: { type: "string", enum: Object.values(RESOURCE_PROGRESS_TRACKING) },
        displayProgress: bool,
        displaySequence: bool,
        displayCoversInTableOfContents: bool,
        skipFeed: bool,
        order: { type: "string", enum: Object.values(RESOURCE_ORDER) },
        externalURL: { type: "string", pattern: "^https?://" },
        author: { anyOf: [str, strArray] },
        categories: strArray,
        cta: {
            type: "object",
            additionalProperties: false,
            properties: { hidden: bool, text: str },
        },
        share,
        fonts: {
            type: "array",
            items: {
                type: "object",
                additionalProperties: false,
                required: ["name", "src"],
                properties: { name: str, src: str, weight: { type: "number" }, attributes: str },
            },
        },
        style: documentStyleSchema,
    },
}

export const sectionSchema = {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
        title: str,
        displaySequence: bool,
        isRoot: bool,
    },
}

export const documentSchema = {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
        title: str,
        subtitle: str,
        markdownTitle: str,
        markdownSubtitle: str,
        start_date: str,
        end_date: str,
        startDate: str,
        endDate: str,
        cover: str,
        background: str,
        titleBelowCover: bool,
        chips: bool,
        categories: strArray,
        externalURL: { type: "string", pattern: "^https?://" },
        share,
        style: documentStyleSchema,
    },
}

export const segmentSchema = {
    type: "object",
    additionalProperties: false,
    required: ["title"],
    properties: {
        title: str,
        subtitle: str,
        markdownTitle: str,
        markdownSubtitle: str,
        date: str,
        startDate: str,
        endDate: str,
        type: { type: "string", enum: Object.values(SEGMENT_TYPES) },
        cover: str,
        background: str,
        titleBelowCover: bool,
        categories: strArray,
        style: documentStyleSchema,
        audio: {
            type: "object",
            required: ["src"],
            properties: { src: str, title: str, artist: str },
        },
        video: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                required: ["src"],
                properties: { src: str, hls: str, title: str, artist: str, thumbnail: str },
            },
        },
        pdf: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                required: ["src"],
                properties: { src: str, title: str },
            },
        },
    },
}

export const pdfFileSchema = {
    type: "object",
    additionalProperties: false,
    required: ["pdf"],
    properties: {
        pdf: {
            type: "array",
            minItems: 1,
            items: {
                type: "object",
                required: ["src"],
                properties: {
                    src: str,
                    title: str,
                    target: str,
                    start_date: str,
                    end_date: str,
                },
            },
        },
    },
}

const feedGroup = {
    type: "object",
    additionalProperties: false,
    properties: {
        group: str,
        view: { type: "string", enum: Object.values(FEED_VIEWS) },
        direction: { type: "string", enum: Object.values(FEED_DIRECTION) },
        scope: { type: "string", enum: Object.values(FEED_SCOPES) },
        kind: { type: "string", enum: Object.values(RESOURCE_KIND) },
        author: str,
        resources: strArray,
        authors: strArray,
        categories: strArray,
        noSeeAll: bool,
        reverse: bool,
        showTitle: bool,
        recent: bool,
        backgroundColor: color,
    },
}

// <lang>/<type>/feed.yml, <lang>/<type>/feed-<env>.yml, <lang>/authors/<id>/feed.yml
export const feedSchema = {
    type: "object",
    additionalProperties: false,
    required: ["groups"],
    properties: {
        title: str,
        hidden: bool,
        groups: { type: "array", items: feedGroup },
    },
}

// <lang>/categories/<id>/feed.yml is a bare list of groups
export const categoryFeedSchema = {
    type: "array",
    items: feedGroup,
}

const entityCovers = {
    type: "object",
    additionalProperties: false,
    properties: { portrait: str, landscape: str, square: str, splash: str },
}

export const authorSchema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "title"],
    properties: {
        id: str,
        title: str,
        subtitle: str,
        description: str,
        primaryColor: color,
        primaryColorDark: color,
        covers: entityCovers,
        logo: str,
        links: {
            type: "array",
            items: { type: "object", required: ["title", "url"], properties: { title: str, url: str } },
        },
        details: {
            type: "array",
            items: { type: "object", required: ["title", "content"], properties: { title: str, content: str } },
        },
    },
}

export const categorySchema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "title"],
    properties: {
        id: str,
        title: str,
        subtitle: str,
        description: str,
        primaryColor: color,
        primaryColorDark: color,
        covers: entityCovers,
    },
}
