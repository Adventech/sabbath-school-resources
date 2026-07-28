"use strict"

import crypto from "node:crypto"

const RELEASE_SCHEMA_VERSION = 1
const POINTER_SCHEMA_VERSION = 1
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

class ReleaseIntegrityError extends Error {
    constructor(message, options) {
        super(message, options)
        this.name = "ReleaseIntegrityError"
        this.code = "ERR_RELEASE_INTEGRITY"
    }
}

const sha256 = value => crypto.createHash("sha256").update(value).digest("hex")

const canonicalBytes = value => Buffer.from(JSON.stringify(value), "utf8")

const versionsEqual = (left, right) => Object.is(left, right)

const requirePointerVersion = (version, label) => {
    if (version === null || version === undefined) {
        throw new Error(`${label} omitted a durable pointer generation`)
    }
    return version
}

const copyBytes = (value, label) => {
    if (typeof value === "string") {
        return Buffer.from(value, "utf8")
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return Buffer.from(value)
    }
    throw new TypeError(`${label} must be a string or byte array`)
}

const assertExactKeys = (value, expected, label) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`)
    }

    const actual = Object.keys(value).sort()
    const wanted = [...expected].sort()
    if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
        throw new Error(`${label} has an unsupported shape`)
    }
}

const normalizeNamespace = namespace => {
    if (typeof namespace !== "string" || !NAMESPACE_PATTERN.test(namespace)) {
        throw new Error("Release namespace must be a lowercase, path-safe identifier")
    }
    return namespace
}

const normalizeSourceSha = sourceSha => {
    if (typeof sourceSha !== "string" || !SOURCE_SHA_PATTERN.test(sourceSha.toLowerCase())) {
        throw new Error("Release source SHA must be an exact 40-character Git commit")
    }
    return sourceSha.toLowerCase()
}

const normalizeObjectPath = objectPath => {
    if (typeof objectPath !== "string" || objectPath.length === 0) {
        throw new Error("Object path must be a non-empty string")
    }
    if (objectPath.startsWith("/") || objectPath.includes("\\") || CONTROL_CHARACTER_PATTERN.test(objectPath)) {
        throw new Error(`Object path is unsafe: ${objectPath}`)
    }

    const normalizedSegments = []
    for (const segment of objectPath.split("/")) {
        if (segment === "" || segment === ".") {
            continue
        }
        if (segment === "..") {
            throw new Error(`Object path traversal is forbidden: ${objectPath}`)
        }
        normalizedSegments.push(segment)
    }

    if (normalizedSegments.length === 0) {
        throw new Error(`Object path is empty after normalization: ${objectPath}`)
    }
    return normalizedSegments.join("/")
}

const descriptorFor = ({ namespace, sourceSha, releaseId, manifestKey, manifestDigest }) => ({
    namespace,
    sourceSha,
    releaseId,
    manifestKey,
    manifestDigest
})

const descriptorsEqual = (left, right) => (
    left.namespace === right.namespace
    && left.sourceSha === right.sourceSha
    && left.releaseId === right.releaseId
    && left.manifestKey === right.manifestKey
    && left.manifestDigest === right.manifestDigest
)

const releaseIdFor = (sourceSha, manifestDigest) => `${sourceSha}-${manifestDigest}`

const releasePrefixFor = (namespace, releaseId) => `_releases/${namespace}/${releaseId}`

const pointerKeyFor = namespace => `_deploy/${namespace}/current.json`

const assertDescriptor = descriptor => {
    assertExactKeys(
        descriptor,
        ["namespace", "sourceSha", "releaseId", "manifestKey", "manifestDigest"],
        "Release descriptor"
    )

    const namespace = normalizeNamespace(descriptor.namespace)
    const sourceSha = normalizeSourceSha(descriptor.sourceSha)
    if (typeof descriptor.manifestDigest !== "string" || !SHA256_PATTERN.test(descriptor.manifestDigest)) {
        throw new Error("Release descriptor has an invalid manifest SHA-256")
    }

    const releaseId = releaseIdFor(sourceSha, descriptor.manifestDigest)
    const manifestKey = `${releasePrefixFor(namespace, releaseId)}/manifest.json`
    if (descriptor.releaseId !== releaseId || descriptor.manifestKey !== manifestKey) {
        throw new Error("Release descriptor does not match its immutable release identity")
    }

    return descriptorFor({
        namespace,
        sourceSha,
        releaseId,
        manifestKey,
        manifestDigest: descriptor.manifestDigest
    })
}

const requireStore = store => {
    for (const method of ["get", "putIfAbsent", "compareAndSwap"]) {
        if (!store || typeof store[method] !== "function") {
            throw new TypeError(`Release store must implement ${method}()`)
        }
    }
    return store
}

const readRecord = async (store, key) => {
    const record = await store.get(key)
    if (record === null || record === undefined) {
        return null
    }
    if (typeof record !== "object" || !("version" in record)) {
        throw new Error(`Store returned an invalid versioned record for ${key}`)
    }
    return {
        bytes: copyBytes(record.bytes, `Stored value for ${key}`),
        version: record.version
    }
}

const writeImmutable = async (store, key, value) => {
    const bytes = copyBytes(value, `Immutable value for ${key}`)
    const result = await store.putIfAbsent(key, bytes)
    if (!result || typeof result.inserted !== "boolean") {
        throw new Error(`Store returned an invalid putIfAbsent result for ${key}`)
    }
    if (result.inserted) {
        return
    }

    const existing = await readRecord(store, key)
    if (!existing || !existing.bytes.equals(bytes)) {
        throw new Error(`Immutable release collision at ${key}`)
    }
}

const validateManifest = manifest => {
    assertExactKeys(manifest, ["schemaVersion", "namespace", "sourceSha", "objects"], "Release manifest")
    if (manifest.schemaVersion !== RELEASE_SCHEMA_VERSION) {
        throw new Error(`Unsupported release manifest schema ${manifest.schemaVersion}`)
    }

    const namespace = normalizeNamespace(manifest.namespace)
    const sourceSha = normalizeSourceSha(manifest.sourceSha)
    if (!Array.isArray(manifest.objects)) {
        throw new Error("Release manifest objects must be an array")
    }

    let previousPath = null
    const objects = manifest.objects.map((object, index) => {
        assertExactKeys(object, ["path", "bytes", "sha256"], `Release manifest object ${index}`)
        const objectPath = normalizeObjectPath(object.path)
        if (objectPath !== object.path) {
            throw new Error(`Release manifest object path is not canonical: ${object.path}`)
        }
        if (previousPath !== null && objectPath <= previousPath) {
            throw new Error(`Release manifest object paths are duplicate or unsorted: ${objectPath}`)
        }
        previousPath = objectPath

        if (!Number.isSafeInteger(object.bytes) || object.bytes < 0) {
            throw new Error(`Release manifest byte length is invalid for ${objectPath}`)
        }
        if (typeof object.sha256 !== "string" || !SHA256_PATTERN.test(object.sha256)) {
            throw new Error(`Release manifest SHA-256 is invalid for ${objectPath}`)
        }
        return { path: objectPath, bytes: object.bytes, sha256: object.sha256 }
    })

    return {
        schemaVersion: RELEASE_SCHEMA_VERSION,
        namespace,
        sourceSha,
        objects
    }
}

const parseCanonicalManifest = bytes => {
    let parsed
    try {
        parsed = JSON.parse(bytes.toString("utf8"))
    } catch (error) {
        throw new Error(`Release manifest is not valid JSON: ${error.message}`)
    }

    const manifest = validateManifest(parsed)
    if (!canonicalBytes(manifest).equals(bytes)) {
        throw new Error("Release manifest is not in canonical byte form")
    }
    return manifest
}

const pointerFromDescriptor = (descriptor, previous) => ({
    schemaVersion: POINTER_SCHEMA_VERSION,
    namespace: descriptor.namespace,
    sourceSha: descriptor.sourceSha,
    releaseId: descriptor.releaseId,
    manifestKey: descriptor.manifestKey,
    manifestDigest: descriptor.manifestDigest,
    previous
})

const parseCanonicalPointer = bytes => {
    let parsed
    try {
        parsed = JSON.parse(bytes.toString("utf8"))
    } catch (error) {
        throw new Error(`Release pointer is not valid JSON: ${error.message}`)
    }

    assertExactKeys(
        parsed,
        ["schemaVersion", "namespace", "sourceSha", "releaseId", "manifestKey", "manifestDigest", "previous"],
        "Release pointer"
    )
    if (parsed.schemaVersion !== POINTER_SCHEMA_VERSION) {
        throw new Error(`Unsupported release pointer schema ${parsed.schemaVersion}`)
    }

    const descriptor = assertDescriptor(descriptorFor(parsed))
    const previous = parsed.previous === null ? null : assertDescriptor(parsed.previous)
    if (previous && previous.namespace !== descriptor.namespace) {
        throw new Error("Release pointer previous descriptor belongs to a different namespace")
    }
    if (previous && descriptorsEqual(previous, descriptor)) {
        throw new Error("Release pointer previous descriptor is self-referential")
    }
    const pointer = pointerFromDescriptor(descriptor, previous)
    if (!canonicalBytes(pointer).equals(bytes)) {
        throw new Error("Release pointer is not in canonical byte form")
    }
    return pointer
}

const descriptorFromPointer = pointer => descriptorFor(pointer)

const requireExpectedVersion = options => {
    if (!options || !Object.prototype.hasOwnProperty.call(options, "expectedVersion")) {
        throw new Error("Pointer update requires an explicit expectedVersion")
    }
    return options.expectedVersion
}

const readPointerRecord = async (store, pointerKey) => {
    const record = await readRecord(store, pointerKey)
    if (!record) {
        return null
    }
    requirePointerVersion(record.version, `Stored release pointer ${pointerKey}`)
    return record
}

const reconcilePointerWrite = async ({
    store,
    pointerKey,
    expectedVersion,
    intendedBytes,
    reportedVersion,
    operation
}) => {
    const record = await readPointerRecord(store, pointerKey)
    if (!record) {
        throw new Error(`Release pointer ${operation} read-back found no pointer`)
    }
    if (versionsEqual(record.version, expectedVersion)) {
        throw new Error(`Release pointer ${operation} did not produce a new durable generation`)
    }
    if (!record.bytes.equals(intendedBytes)) {
        throw new Error(`Release pointer ${operation} read-back found different pointer bytes`)
    }
    if (reportedVersion !== undefined) {
        requirePointerVersion(reportedVersion, `Release pointer ${operation} result`)
        if (versionsEqual(reportedVersion, expectedVersion)) {
            throw new Error(`Release pointer ${operation} returned an unchanged generation`)
        }
        if (!versionsEqual(record.version, reportedVersion)) {
            throw new Error(`Release pointer ${operation} read-back generation does not match the store result`)
        }
    }
    return record.version
}

const writePointerConditionally = async ({ store, pointerKey, expectedVersion, pointer, operation }) => {
    // Store adapters must provide strongly consistent read-back and a unique generation per write.
    // A content ETag is insufficient because it permits ABA when identical pointer bytes recur.
    const intendedBytes = canonicalBytes(pointer)
    let result
    try {
        result = await store.compareAndSwap(pointerKey, expectedVersion, intendedBytes)
    } catch (error) {
        try {
            const version = await reconcilePointerWrite({
                store,
                pointerKey,
                expectedVersion,
                intendedBytes,
                operation
            })
            return { pointerKey, pointer, version }
        } catch (reconciliationError) {
            throw new Error(
                `Release pointer ${operation} failed and could not be reconciled: ${error.message}; ${reconciliationError.message}`,
                { cause: error }
            )
        }
    }

    if (!result || typeof result.swapped !== "boolean") {
        throw new Error(`Store returned an invalid conditional result during pointer ${operation}`)
    }
    if (result.swapped !== true) {
        try {
            const version = await reconcilePointerWrite({
                store,
                pointerKey,
                expectedVersion,
                intendedBytes,
                operation
            })
            return { pointerKey, pointer, version }
        } catch (error) {
            throw new Error(`Release pointer conflict during conditional ${operation}: ${error.message}`, {
                cause: error
            })
        }
    }

    const reportedVersion = requirePointerVersion(
        result.version,
        `Release pointer ${operation} result`
    )
    if (versionsEqual(reportedVersion, expectedVersion)) {
        throw new Error(`Release pointer ${operation} returned an unchanged generation`)
    }
    const version = await reconcilePointerWrite({
        store,
        pointerKey,
        expectedVersion,
        intendedBytes,
        reportedVersion,
        operation
    })
    return { pointerKey, pointer, version }
}

const readAndVerifyObject = async (store, key, object) => {
    const record = await readRecord(store, key)
    if (!record) {
        throw new ReleaseIntegrityError(`Release verification found a missing object: ${object.path}`)
    }
    if (record.bytes.byteLength !== object.bytes) {
        throw new ReleaseIntegrityError(`Release verification found an invalid byte length: ${object.path}`)
    }
    if (sha256(record.bytes) !== object.sha256) {
        throw new ReleaseIntegrityError(`Release verification found a SHA-256 mismatch: ${object.path}`)
    }
    return record.bytes
}

export const createReleaseManifest = ({ namespace, sourceSha, objects }) => {
    const normalizedNamespace = normalizeNamespace(namespace)
    const normalizedSourceSha = normalizeSourceSha(sourceSha)
    if (!Array.isArray(objects)) {
        throw new Error("Release input objects must be an array")
    }

    const seenPaths = new Set()
    const objectEntries = objects.map((object, index) => {
        assertExactKeys(object, ["path", "bytes"], `Release input object ${index}`)
        const objectPath = normalizeObjectPath(object.path)
        if (seenPaths.has(objectPath)) {
            throw new Error(`Release input contains a duplicate object path: ${objectPath}`)
        }
        seenPaths.add(objectPath)

        const bytes = copyBytes(object.bytes, `Release input bytes for ${objectPath}`)
        return {
            path: objectPath,
            bytes,
            sha256: sha256(bytes)
        }
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

    const manifest = {
        schemaVersion: RELEASE_SCHEMA_VERSION,
        namespace: normalizedNamespace,
        sourceSha: normalizedSourceSha,
        objects: objectEntries.map(object => ({
            path: object.path,
            bytes: object.bytes.byteLength,
            sha256: object.sha256
        }))
    }
    const manifestBytes = canonicalBytes(manifest)
    const manifestDigest = sha256(manifestBytes)
    const releaseId = releaseIdFor(normalizedSourceSha, manifestDigest)
    const manifestKey = `${releasePrefixFor(normalizedNamespace, releaseId)}/manifest.json`

    return {
        namespace: normalizedNamespace,
        sourceSha: normalizedSourceSha,
        releaseId,
        manifest,
        manifestBytes,
        manifestDigest,
        manifestKey,
        objectEntries
    }
}

export const stageImmutableRelease = async (store, release) => {
    requireStore(store)
    if (!release || !Array.isArray(release.objectEntries)) {
        throw new TypeError("A release created by createReleaseManifest() is required")
    }

    const descriptor = assertDescriptor(descriptorFor(release))
    const manifest = validateManifest(release.manifest)
    const manifestBytes = copyBytes(release.manifestBytes, "Release manifest bytes")
    if (!canonicalBytes(manifest).equals(manifestBytes) || sha256(manifestBytes) !== descriptor.manifestDigest) {
        throw new Error("Release plan manifest verification failed before staging")
    }
    if (manifest.namespace !== descriptor.namespace || manifest.sourceSha !== descriptor.sourceSha) {
        throw new Error("Release plan identity does not match its manifest namespace and source")
    }

    const entryByPath = new Map()
    for (const [index, entry] of release.objectEntries.entries()) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new TypeError(`Release plan entry ${index} must be an object`)
        }
        const objectPath = normalizeObjectPath(entry.path)
        if (objectPath !== entry.path) {
            throw new Error(`Release plan entry path is not canonical: ${entry.path}`)
        }
        if (entryByPath.has(objectPath)) {
            throw new Error(`Release plan contains a duplicate object entry: ${objectPath}`)
        }
        entryByPath.set(objectPath, entry)
    }
    if (entryByPath.size !== manifest.objects.length) {
        throw new Error("Release plan object entries do not match the manifest path set")
    }

    const preparedObjects = []
    for (const object of manifest.objects) {
        const entry = entryByPath.get(object.path)
        if (!entry) {
            throw new Error(`Release plan is missing bytes for ${object.path}`)
        }
        const bytes = copyBytes(entry.bytes, `Release bytes for ${object.path}`)
        if (bytes.byteLength !== object.bytes || sha256(bytes) !== object.sha256) {
            throw new Error(`Release plan bytes do not match the manifest for ${object.path}`)
        }
        if (entry.sha256 !== object.sha256) {
            throw new Error(`Release plan entry SHA-256 does not match the manifest for ${object.path}`)
        }
        const key = `${releasePrefixFor(descriptor.namespace, descriptor.releaseId)}/objects/${object.path}`
        preparedObjects.push({ object, bytes, key })
    }

    const objectKeys = Object.create(null)
    for (const { object, bytes, key } of preparedObjects) {
        await writeImmutable(store, key, bytes)
        objectKeys[object.path] = key
    }
    await writeImmutable(store, descriptor.manifestKey, manifestBytes)

    return {
        ...descriptor,
        objectKeys
    }
}

export const verifyStagedRelease = async (store, releaseDescriptor) => {
    requireStore(store)
    const descriptor = assertDescriptor(descriptorFor(releaseDescriptor))
    const manifestRecord = await readRecord(store, descriptor.manifestKey)
    if (!manifestRecord) {
        throw new ReleaseIntegrityError("Release verification found a missing manifest")
    }
    if (sha256(manifestRecord.bytes) !== descriptor.manifestDigest) {
        throw new ReleaseIntegrityError("Release verification found a manifest SHA-256 mismatch")
    }

    let manifest
    try {
        manifest = parseCanonicalManifest(manifestRecord.bytes)
    } catch (error) {
        throw new ReleaseIntegrityError(`Release verification found an invalid manifest: ${error.message}`, {
            cause: error
        })
    }
    if (manifest.namespace !== descriptor.namespace || manifest.sourceSha !== descriptor.sourceSha) {
        throw new ReleaseIntegrityError("Release verification found a manifest identity mismatch")
    }

    const objectKeys = Object.create(null)
    for (const object of manifest.objects) {
        const key = `${releasePrefixFor(descriptor.namespace, descriptor.releaseId)}/objects/${object.path}`
        await readAndVerifyObject(store, key, object)
        objectKeys[object.path] = key
    }

    return {
        ...descriptor,
        manifest,
        objectKeys
    }
}

export const promoteReleasePointer = async (store, releaseDescriptor, options) => {
    requireStore(store)
    const expectedVersion = requireExpectedVersion(options)
    const verified = await verifyStagedRelease(store, releaseDescriptor)
    const pointerKey = pointerKeyFor(verified.namespace)
    const currentRecord = await readPointerRecord(store, pointerKey)
    const actualVersion = currentRecord?.version ?? null
    if (!versionsEqual(actualVersion, expectedVersion)) {
        throw new Error(`Release pointer conflict: expected ${expectedVersion}, found ${actualVersion}`)
    }

    let previous = null
    if (currentRecord) {
        const currentPointer = parseCanonicalPointer(currentRecord.bytes)
        if (currentPointer.namespace !== verified.namespace) {
            throw new Error("Current release pointer belongs to a different namespace")
        }
        const currentDescriptor = descriptorFromPointer(currentPointer)
        if (descriptorsEqual(currentDescriptor, verified)) {
            return { pointerKey, pointer: currentPointer, version: currentRecord.version }
        }

        try {
            const verifiedCurrent = await verifyStagedRelease(store, currentDescriptor)
            previous = assertDescriptor(descriptorFor(verifiedCurrent))
        } catch (currentError) {
            if (!(currentError instanceof ReleaseIntegrityError)) {
                throw currentError
            }
            // Corrupt releases are excluded from rollback history; provider failures remain fatal.
            if (currentPointer.previous) {
                try {
                    const verifiedFallback = await verifyStagedRelease(store, currentPointer.previous)
                    previous = assertDescriptor(descriptorFor(verifiedFallback))
                } catch (fallbackError) {
                    if (!(fallbackError instanceof ReleaseIntegrityError)) {
                        throw fallbackError
                    }
                    previous = null
                }
            }
        }
    }

    const pointer = pointerFromDescriptor(verified, previous)
    return writePointerConditionally({
        store,
        pointerKey,
        expectedVersion,
        pointer,
        operation: "promotion"
    })
}

export const resolveCurrentRelease = async (store, namespace) => {
    requireStore(store)
    const normalizedNamespace = normalizeNamespace(namespace)
    const pointerKey = pointerKeyFor(normalizedNamespace)
    const pointerRecord = await readPointerRecord(store, pointerKey)
    if (!pointerRecord) {
        return null
    }

    const pointer = parseCanonicalPointer(pointerRecord.bytes)
    if (pointer.namespace !== normalizedNamespace) {
        throw new Error("Current release pointer belongs to a different namespace")
    }
    const verified = await verifyStagedRelease(store, descriptorFromPointer(pointer))
    const objects = new Map(verified.manifest.objects.map(object => [
        object.path,
        Object.freeze({ ...object })
    ]))
    const manifest = Object.freeze({
        schemaVersion: verified.manifest.schemaVersion,
        namespace: verified.manifest.namespace,
        sourceSha: verified.manifest.sourceSha,
        objects: Object.freeze(verified.manifest.objects.map(object => Object.freeze({ ...object })))
    })

    return {
        pointerKey,
        pointer,
        version: pointerRecord.version,
        manifest,
        readObject: async objectPath => {
            const normalizedPath = normalizeObjectPath(objectPath)
            const object = objects.get(normalizedPath)
            if (!object) {
                return null
            }
            return readAndVerifyObject(store, verified.objectKeys[normalizedPath], object)
        }
    }
}

export const rollbackReleasePointer = async (store, namespace, options) => {
    requireStore(store)
    const normalizedNamespace = normalizeNamespace(namespace)
    const expectedVersion = requireExpectedVersion(options)
    const pointerKey = pointerKeyFor(normalizedNamespace)
    const currentRecord = await readPointerRecord(store, pointerKey)
    const actualVersion = currentRecord?.version ?? null
    if (!currentRecord || !versionsEqual(actualVersion, expectedVersion)) {
        throw new Error(`Release pointer conflict: expected ${expectedVersion}, found ${actualVersion}`)
    }

    const currentPointer = parseCanonicalPointer(currentRecord.bytes)
    if (currentPointer.namespace !== normalizedNamespace) {
        throw new Error("Current release pointer belongs to a different namespace")
    }
    if (!currentPointer.previous) {
        throw new Error("Current release pointer has no previous verified release")
    }

    const previous = await verifyStagedRelease(store, currentPointer.previous)
    // Preserve one-step redo history without rereading the release being recovered from.
    // A future rollback verifies this descriptor before it can become current again.
    const rollbackPrevious = descriptorFromPointer(currentPointer)
    const rollbackPointer = pointerFromDescriptor(previous, rollbackPrevious)
    return writePointerConditionally({
        store,
        pointerKey,
        expectedVersion,
        pointer: rollbackPointer,
        operation: "rollback"
    })
}
