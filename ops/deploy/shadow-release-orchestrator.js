"use strict"

import crypto from "node:crypto"

import {
    createReleaseManifest,
    promoteReleasePointer,
    rollbackReleasePointer,
    stageImmutableRelease,
    verifyStagedRelease
} from "./release-protocol.js"

const PLAN_SCHEMA_VERSION = 1
const internalPlans = new WeakMap()

const canonicalBytes = value => Buffer.from(JSON.stringify(value), "utf8")
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex")

const releasePrefix = release => `_releases/${release.namespace}/${release.releaseId}`

const descriptorOf = release => ({
    namespace: release.namespace,
    sourceSha: release.sourceSha,
    releaseId: release.releaseId,
    manifestKey: release.manifestKey,
    manifestDigest: release.manifestDigest
})

const requirePlan = plan => {
    const release = internalPlans.get(plan)
    if (!release) {
        throw new TypeError("A plan created by createShadowReleasePlan() is required")
    }
    return release
}

const requireExpectedVersion = options => {
    if (!options || !Object.prototype.hasOwnProperty.call(options, "expectedVersion")) {
        throw new Error("Shadow release promotion requires an explicit expectedVersion")
    }
    return options.expectedVersion
}

export const createShadowReleasePlan = input => {
    // createReleaseManifest copies and validates every input before this function
    // exposes a plan or permits a transport call.
    const release = createReleaseManifest(input)
    const prefix = releasePrefix(release)
    const operations = [
        ...release.manifest.objects.map(object => Object.freeze({
            operation: "create-immutable-object",
            key: `${prefix}/objects/${object.path}`,
            bytes: object.bytes,
            sha256: object.sha256
        })),
        Object.freeze({
            operation: "create-immutable-manifest",
            key: release.manifestKey,
            bytes: release.manifestBytes.byteLength,
            sha256: release.manifestDigest
        })
    ]
    const document = {
        schemaVersion: PLAN_SCHEMA_VERSION,
        ...descriptorOf(release),
        operations
    }
    const planBytes = canonicalBytes(document)
    const plan = Object.freeze({
        ...document,
        operations: Object.freeze(operations),
        planBytes,
        planDigest: sha256(planBytes)
    })
    internalPlans.set(plan, release)
    return plan
}

export const stageShadowRelease = async (store, plan) => {
    const release = requirePlan(plan)
    const staged = await stageImmutableRelease(store, release)
    const descriptor = await verifyStagedRelease(store, staged)
    return Object.freeze({ plan, descriptor })
}

export const promoteShadowRelease = async (store, plan, options) => {
    const expectedVersion = requireExpectedVersion(options)
    const staged = await stageShadowRelease(store, plan)
    const promotion = await promoteReleasePointer(store, staged.descriptor, {
        expectedVersion
    })
    return Object.freeze({
        plan,
        descriptor: staged.descriptor,
        promotion
    })
}

export const runShadowRelease = async (store, input, options) => {
    // Plan first so path, identity, duplicate, byte, and manifest failures result
    // in zero provider calls.
    const plan = createShadowReleasePlan(input)
    return promoteShadowRelease(store, plan, options)
}

export const rollbackShadowRelease = async (store, namespace, options) => {
    const expectedVersion = requireExpectedVersion(options)
    return rollbackReleasePointer(store, namespace, { expectedVersion })
}
