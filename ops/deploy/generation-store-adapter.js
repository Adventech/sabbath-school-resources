"use strict"

import crypto from "node:crypto"

const MAX_GENERATION_LENGTH = 1024
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/
const TRANSPORT_ERROR_KINDS = new Set(["not-found", "precondition-failed"])

const EXPECTED_CAPABILITIES = Object.freeze({
    conditionalCreate: true,
    conditionalReplace: "generation-match",
    generationSemantics: "unique-per-write",
    readConsistency: "strong"
})

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex")

const copyBytes = (value, label) => {
    if (typeof value === "string") {
        return Buffer.from(value, "utf8")
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return Buffer.from(value)
    }
    throw new TypeError(`${label} must be a string or byte array`)
}

const requireKey = key => {
    if (typeof key !== "string" || key.length === 0 || CONTROL_CHARACTER_PATTERN.test(key)) {
        throw new TypeError("Transport object key must be a non-empty string without controls")
    }
    return key
}

const requireGeneration = (generation, label) => {
    if (
        typeof generation !== "string"
        || generation.length === 0
        || generation.length > MAX_GENERATION_LENGTH
        || CONTROL_CHARACTER_PATTERN.test(generation)
    ) {
        throw new Error(`${label} omitted a valid unique durable generation`)
    }
    return generation
}

const requireObject = (value, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} returned an invalid response`)
    }
    return value
}

const requireCapabilities = transport => {
    const capabilities = requireObject(transport.capabilities, "Generation transport capabilities")
    for (const [name, expected] of Object.entries(EXPECTED_CAPABILITIES)) {
        if (capabilities[name] !== expected) {
            throw new Error(
                `Generation transport capability ${name} must be ${JSON.stringify(expected)}; `
                + `ETag-only, absent, or weaker semantics are unsupported`
            )
        }
    }
}

const requireTransport = transport => {
    if (!transport || typeof transport !== "object") {
        throw new TypeError("A generation-aware object transport is required")
    }
    requireCapabilities(transport)
    for (const method of ["readObject", "createObject", "replaceObject"]) {
        if (typeof transport[method] !== "function") {
            throw new TypeError(`Generation transport must implement ${method}()`)
        }
    }
    return transport
}

export class GenerationTransportError extends Error {
    constructor(kind, message, options) {
        if (!TRANSPORT_ERROR_KINDS.has(kind)) {
            throw new TypeError(`Unsupported generation transport error kind: ${kind}`)
        }
        super(message, options)
        this.name = "GenerationTransportError"
        this.code = kind === "not-found"
            ? "ERR_GENERATION_OBJECT_NOT_FOUND"
            : "ERR_GENERATION_PRECONDITION_FAILED"
        this.kind = kind
    }
}

const hasTransportKind = (error, kind) => (
    error instanceof GenerationTransportError && error.kind === kind
)

export const createGenerationStoreAdapter = ({ transport }) => {
    const provider = requireTransport(transport)
    const observations = new Map()
    const contractViolations = new Map()

    const requireHealthyKey = key => {
        const violation = contractViolations.get(key)
        if (violation) {
            throw violation
        }
    }

    const poisonKey = (key, error) => {
        const violation = error instanceof Error
            ? error
            : new Error(`Generation transport contract violation for ${key}: ${error}`)
        contractViolations.set(key, violation)
        throw violation
    }

    const observeGeneration = (key, generationValue, body, label) => {
        const generation = requireGeneration(generationValue, label)
        const digest = sha256(body)
        const state = observations.get(key)
        if (!state) {
            observations.set(key, {
                active: generation,
                digests: new Map([[generation, digest]])
            })
            return generation
        }

        const knownDigest = state.digests.get(generation)
        if (knownDigest !== undefined && knownDigest !== digest) {
            throw new Error(
                `Generation transport changed bytes without a new durable generation for ${key}`
            )
        }
        if (generation !== state.active && knownDigest !== undefined) {
            throw new Error(`Generation transport reused an observed generation (ABA) for ${key}`)
        }
        if (knownDigest === undefined) {
            state.digests.set(generation, digest)
        }
        state.active = generation
        return generation
    }

    const read = async keyValue => {
        const key = requireKey(keyValue)
        requireHealthyKey(key)
        let response
        try {
            response = await provider.readObject({ key })
        } catch (error) {
            if (hasTransportKind(error, "not-found")) {
                return null
            }
            throw error
        }

        try {
            const record = requireObject(response, `Generation transport read for ${key}`)
            if (!Object.prototype.hasOwnProperty.call(record, "body")) {
                throw new Error(`Generation transport read for ${key} omitted object bytes`)
            }
            const body = copyBytes(record.body, `Generation transport read body for ${key}`)
            const generation = observeGeneration(
                key,
                record.generation,
                body,
                `Generation transport read for ${key}`
            )
            return { bytes: body, version: generation }
        } catch (error) {
            return poisonKey(key, error)
        }
    }

    const putIfAbsent = async (keyValue, value) => {
        const key = requireKey(keyValue)
        requireHealthyKey(key)
        const body = copyBytes(value, `Immutable transport body for ${key}`)
        let response
        try {
            response = await provider.createObject({ key, body: Buffer.from(body) })
        } catch (error) {
            if (hasTransportKind(error, "precondition-failed")) {
                return { inserted: false }
            }
            throw error
        }

        try {
            if (observations.has(key)) {
                throw new Error(`Conditional immutable create unexpectedly replaced observed key ${key}`)
            }
            const result = requireObject(response, `Generation transport create for ${key}`)
            const generation = observeGeneration(
                key,
                result.generation,
                body,
                `Generation transport create for ${key}`
            )
            return { inserted: true, version: generation }
        } catch (error) {
            return poisonKey(key, error)
        }
    }

    const compareAndSwap = async (keyValue, expectedVersion, value) => {
        const key = requireKey(keyValue)
        requireHealthyKey(key)
        const body = copyBytes(value, `Conditional transport body for ${key}`)
        const expected = expectedVersion === null
            ? null
            : requireGeneration(expectedVersion, `Expected generation for ${key}`)

        let response
        try {
            response = expected === null
                ? await provider.createObject({ key, body: Buffer.from(body) })
                : await provider.replaceObject({
                    key,
                    body: Buffer.from(body),
                    ifGenerationMatch: expected
                })
        } catch (error) {
            if (hasTransportKind(error, "precondition-failed")) {
                return { swapped: false }
            }
            throw error
        }

        try {
            const result = requireObject(response, `Generation transport conditional write for ${key}`)
            const generation = requireGeneration(
                result.generation,
                `Generation transport conditional write for ${key}`
            )
            if (generation === expected) {
                throw new Error(`Generation transport returned an unchanged or reused generation for ${key}`)
            }
            if (expected === null && observations.has(key)) {
                throw new Error(`Conditional create unexpectedly replaced observed pointer ${key}`)
            }
            observeGeneration(
                key,
                generation,
                body,
                `Generation transport conditional write for ${key}`
            )
            return { swapped: true, version: generation }
        } catch (error) {
            return poisonKey(key, error)
        }
    }

    return Object.freeze({
        get: read,
        putIfAbsent,
        compareAndSwap
    })
}
