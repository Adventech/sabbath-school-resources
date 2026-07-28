"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const test = require("node:test")

const NAMESPACE = "synthetic"
const SOURCE_A = "a".repeat(40)
const SOURCE_B = "b".repeat(40)
const SOURCE_C = "c".repeat(40)

const byteString = value => Buffer.from(value, "utf8")

const loadProtocol = () => import("../ops/deploy/release-protocol.js")

class MemoryStore {
    constructor() {
        this.records = new Map()
        this.nextVersion = 1
        this.putCalls = 0
        this.casCalls = 0
        this.failPutAt = null
        this.failGetKey = null
    }

    async get(key) {
        if (key === this.failGetKey) {
            throw new Error(`synthetic store read failure at ${key}`)
        }
        const record = this.records.get(key)
        if (!record) {
            return null
        }

        return {
            bytes: Buffer.from(record.bytes),
            version: record.version
        }
    }

    async putIfAbsent(key, value) {
        this.putCalls += 1
        if (this.putCalls === this.failPutAt) {
            throw new Error(`injected put failure at ${key}`)
        }

        const current = this.records.get(key)
        if (current) {
            return { inserted: false, version: current.version }
        }

        const version = String(this.nextVersion++)
        this.records.set(key, { bytes: Buffer.from(value), version })
        return { inserted: true, version }
    }

    async compareAndSwap(key, expectedVersion, value) {
        this.casCalls += 1
        const current = this.records.get(key)
        const actualVersion = current?.version ?? null
        if (actualVersion !== expectedVersion) {
            return { swapped: false, version: actualVersion }
        }

        const version = String(this.nextVersion++)
        this.records.set(key, { bytes: Buffer.from(value), version })
        return { swapped: true, version }
    }

    delete(key) {
        this.records.delete(key)
    }

    tamper(key, value) {
        const current = this.records.get(key)
        assert.ok(current, `cannot tamper with missing key ${key}`)
        this.records.set(key, {
            bytes: Buffer.from(value),
            version: current.version
        })
    }
}

class FaultyCasStore extends MemoryStore {
    constructor(mode) {
        super()
        this.mode = mode
    }

    async compareAndSwap(key, expectedVersion, value) {
        if (this.mode === "false-success") {
            return { swapped: true, version: "not-written" }
        }
        if (this.mode === "wrong-bytes") {
            const version = String(this.nextVersion++)
            this.records.set(key, { bytes: byteString("{}"), version })
            return { swapped: true, version }
        }
        if (this.mode === "null-version") {
            this.records.set(key, { bytes: Buffer.from(value), version: null })
            return { swapped: true, version: null }
        }
        if (this.mode === "unchanged-version") {
            this.records.set(key, { bytes: Buffer.from(value), version: expectedVersion })
            return { swapped: true, version: expectedVersion }
        }
        if (this.mode === "commit-then-timeout") {
            await super.compareAndSwap(key, expectedVersion, value)
            throw new Error("synthetic response timeout")
        }
        if (this.mode === "false-after-commit") {
            const result = await super.compareAndSwap(key, expectedVersion, value)
            return { ...result, swapped: false }
        }
        if (this.mode === "version-mismatch") {
            const result = await super.compareAndSwap(key, expectedVersion, value)
            return { ...result, version: `reported-${result.version}` }
        }
        return super.compareAndSwap(key, expectedVersion, value)
    }
}

const legacyRecursiveCopy = (live, entries, stopAfter = Infinity) => {
    let writes = 0
    for (const [path, value] of entries) {
        if (writes === stopAfter) {
            throw new Error("injected legacy copy interruption")
        }
        live.set(path, value)
        writes += 1
    }
}

const releaseInput = (sourceSha, entries) => ({
    namespace: NAMESPACE,
    sourceSha,
    objects: entries.map(([path, value]) => ({
        path,
        bytes: byteString(value)
    }))
})

const descriptorOf = release => ({
    namespace: release.namespace,
    sourceSha: release.sourceSha,
    releaseId: release.releaseId,
    manifestKey: release.manifestKey,
    manifestDigest: release.manifestDigest
})

const canonicalPointerBytes = (release, previous) => byteString(JSON.stringify({
    schemaVersion: 1,
    ...descriptorOf(release),
    previous
}))

test("legacy recursive copy retains a key removed by the next release", () => {
    const live = new Map()
    legacyRecursiveCopy(live, [
        ["api/index.json", "A:index"],
        ["api/withdrawn.json", "A:withdrawn"]
    ])
    legacyRecursiveCopy(live, [["api/index.json", "B:index"]])

    assert.equal(live.get("api/index.json"), "B:index")
    assert.equal(live.get("api/withdrawn.json"), "A:withdrawn")
})

test("interrupted legacy copy exposes objects from two releases", () => {
    const live = new Map()
    legacyRecursiveCopy(live, [
        ["api/index.json", "A:index"],
        ["api/detail.json", "A:detail"]
    ])

    assert.throws(() => legacyRecursiveCopy(live, [
        ["api/index.json", "B:index"],
        ["api/detail.json", "B:detail"]
    ], 1), /interruption/)

    assert.deepEqual(Object.fromEntries(live), {
        "api/index.json": "B:index",
        "api/detail.json": "A:detail"
    })
})

test("manifest paths are normalized and sorted while unsafe inputs fail", async () => {
    const { createReleaseManifest } = await loadProtocol()
    const release = createReleaseManifest(releaseInput(SOURCE_A, [
        ["zeta//final.json", "z"],
        ["./alpha/info.json", "a"]
    ]))

    assert.deepEqual(release.manifest.objects.map(object => object.path), [
        "alpha/info.json",
        "zeta/final.json"
    ])

    assert.throws(() => createReleaseManifest(releaseInput(SOURCE_A, [
        ["same/./path.json", "a"],
        ["same/path.json", "b"]
    ])), /duplicate/i)

    for (const path of ["", "../escape", "nested/../../escape", "/absolute", "win\\path"]) {
        assert.throws(
            () => createReleaseManifest(releaseInput(SOURCE_A, [[path, "x"]])),
            /path/i,
            path
        )
    }
})

test("manifest records exact byte length and SHA-256 for every object", async () => {
    const { createReleaseManifest } = await loadProtocol()
    const value = Buffer.from([0, 255, 1, 2])
    const release = createReleaseManifest({
        namespace: NAMESPACE,
        sourceSha: SOURCE_A,
        objects: [{ path: "binary.dat", bytes: value }]
    })
    const object = release.manifest.objects[0]

    assert.equal(object.bytes, value.byteLength)
    assert.equal(object.sha256, crypto.createHash("sha256").update(value).digest("hex"))
    assert.deepEqual(JSON.parse(release.manifestBytes.toString("utf8")), release.manifest)
})

test("identical unordered input produces a byte-identical manifest and release ID", async () => {
    const { createReleaseManifest } = await loadProtocol()
    const forward = createReleaseManifest(releaseInput(SOURCE_A, [
        ["b.json", "bravo"],
        ["a.json", "alpha"]
    ]))
    const reverse = createReleaseManifest(releaseInput(SOURCE_A, [
        ["a.json", "alpha"],
        ["b.json", "bravo"]
    ]))

    assert.deepEqual(forward.manifestBytes, reverse.manifestBytes)
    assert.equal(forward.manifestDigest, reverse.manifestDigest)
    assert.equal(forward.releaseId, reverse.releaseId)
})

test("failure at every staging write leaves the current pointer unchanged", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        stageImmutableRelease
    } = await loadProtocol()

    for (const failureOffset of [1, 2, 3]) {
        const store = new MemoryStore()
        const releaseA = createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
        const releaseB = createReleaseManifest(releaseInput(SOURCE_B, [
            ["index.json", "B"],
            ["new.json", "B:new"]
        ]))

        const stagedA = await stageImmutableRelease(store, releaseA)
        const promotedA = await promoteReleasePointer(store, stagedA, { expectedVersion: null })
        const before = await store.get(promotedA.pointerKey)
        store.failPutAt = store.putCalls + failureOffset

        await assert.rejects(() => stageImmutableRelease(store, releaseB), /injected put failure/)
        const after = await store.get(promotedA.pointerKey)
        assert.deepEqual(after, before)
    }
})

test("release resolution excludes a file removed from the new manifest", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new MemoryStore()
    const releaseA = createReleaseManifest(releaseInput(SOURCE_A, [
        ["index.json", "A:index"],
        ["withdrawn.json", "A:withdrawn"]
    ]))
    const releaseB = createReleaseManifest(releaseInput(SOURCE_B, [["index.json", "B:index"]]))

    const promotedA = await promoteReleasePointer(
        store,
        await stageImmutableRelease(store, releaseA),
        { expectedVersion: null }
    )
    await promoteReleasePointer(
        store,
        await stageImmutableRelease(store, releaseB),
        { expectedVersion: promotedA.version }
    )

    const current = await resolveCurrentRelease(store, NAMESPACE)
    assert.equal((await current.readObject("index.json")).toString("utf8"), "B:index")
    assert.equal(await current.readObject("withdrawn.json"), null)
})

test("missing or tampered staged bytes block pointer promotion", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        stageImmutableRelease
    } = await loadProtocol()

    for (const mutation of ["missing-object", "tampered-object", "tampered-manifest"]) {
        const store = new MemoryStore()
        const release = createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
        const staged = await stageImmutableRelease(store, release)

        if (mutation === "missing-object") {
            store.delete(staged.objectKeys["index.json"])
        } else if (mutation === "tampered-object") {
            store.tamper(staged.objectKeys["index.json"], byteString("changed"))
        } else {
            store.tamper(staged.manifestKey, byteString("{}"))
        }

        await assert.rejects(
            () => promoteReleasePointer(store, staged, { expectedVersion: null }),
            /manifest|missing|sha-256|length|verification/i,
            mutation
        )
    }
})

test("two promoters with one expected version cannot both win", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new MemoryStore()
    const stagedA = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    const stagedB = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_B, [["index.json", "B"]]))
    )

    const results = await Promise.allSettled([
        promoteReleasePointer(store, stagedA, { expectedVersion: null }),
        promoteReleasePointer(store, stagedB, { expectedVersion: null })
    ])

    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(results.filter(result => result.status === "rejected").length, 1)
    assert.match(results.find(result => result.status === "rejected").reason.message, /conflict/i)
})

test("rollback verifies and restores the previous release through a conditional swap", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        rollbackReleasePointer,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new MemoryStore()
    const stagedA = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    const promotedA = await promoteReleasePointer(store, stagedA, { expectedVersion: null })
    const stagedB = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_B, [["index.json", "B"]]))
    )
    const promotedB = await promoteReleasePointer(
        store,
        stagedB,
        { expectedVersion: promotedA.version }
    )

    await assert.rejects(
        () => rollbackReleasePointer(store, NAMESPACE, { expectedVersion: promotedA.version }),
        /conflict/i
    )
    const rolledBack = await rollbackReleasePointer(
        store,
        NAMESPACE,
        { expectedVersion: promotedB.version }
    )
    const current = await resolveCurrentRelease(store, NAMESPACE)

    assert.equal(rolledBack.pointer.sourceSha, SOURCE_A)
    assert.equal(current.pointer.sourceSha, SOURCE_A)
    assert.equal((await current.readObject("index.json")).toString("utf8"), "A")
})

test("a corrupt current release does not block promotion or rollback to a verified destination", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        rollbackReleasePointer,
        stageImmutableRelease
    } = await loadProtocol()

    const prepareCorruptB = async () => {
        const store = new MemoryStore()
        const stagedA = await stageImmutableRelease(
            store,
            createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
        )
        const promotedA = await promoteReleasePointer(store, stagedA, { expectedVersion: null })
        const stagedB = await stageImmutableRelease(
            store,
            createReleaseManifest(releaseInput(SOURCE_B, [["index.json", "B"]]))
        )
        const promotedB = await promoteReleasePointer(
            store,
            stagedB,
            { expectedVersion: promotedA.version }
        )
        store.tamper(stagedB.objectKeys["index.json"], byteString("corrupt"))
        return { store, promotedB }
    }

    const rollbackCase = await prepareCorruptB()
    await rollbackReleasePointer(
        rollbackCase.store,
        NAMESPACE,
        { expectedVersion: rollbackCase.promotedB.version }
    )
    const rolledBack = await resolveCurrentRelease(rollbackCase.store, NAMESPACE)
    assert.equal(rolledBack.pointer.sourceSha, SOURCE_A)

    const promotionCase = await prepareCorruptB()
    const stagedC = await stageImmutableRelease(
        promotionCase.store,
        createReleaseManifest(releaseInput(SOURCE_C, [["index.json", "C"]]))
    )
    const promotedC = await promoteReleasePointer(
        promotionCase.store,
        stagedC,
        { expectedVersion: promotionCase.promotedB.version }
    )
    assert.equal(promotedC.pointer.sourceSha, SOURCE_C)
    assert.equal(promotedC.pointer.previous.sourceSha, SOURCE_A)
})

test("repeated promotion is an idempotent no-op that preserves rollback history", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        rollbackReleasePointer,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new MemoryStore()
    const stagedA = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    const promotedA = await promoteReleasePointer(store, stagedA, { expectedVersion: null })
    const stagedB = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_B, [["index.json", "B"]]))
    )
    const promotedB = await promoteReleasePointer(
        store,
        stagedB,
        { expectedVersion: promotedA.version }
    )

    const repeatedB = await promoteReleasePointer(
        store,
        stagedB,
        { expectedVersion: promotedB.version }
    )
    assert.equal(repeatedB.version, promotedB.version)
    assert.equal(repeatedB.pointer.previous.sourceSha, SOURCE_A)
    assert.equal(store.casCalls, 2, "duplicate promotion must not call compareAndSwap")

    const rollback = await rollbackReleasePointer(
        store,
        NAMESPACE,
        { expectedVersion: repeatedB.version }
    )
    assert.equal(rollback.pointer.sourceSha, SOURCE_A)
})

test("pointer CAS requires a durable new generation and exact read-back", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        stageImmutableRelease
    } = await loadProtocol()
    const release = createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))

    for (const mode of ["false-success", "wrong-bytes", "null-version", "version-mismatch"]) {
        const store = new FaultyCasStore(mode)
        const staged = await stageImmutableRelease(store, release)
        await assert.rejects(
            () => promoteReleasePointer(store, staged, { expectedVersion: null }),
            /conflict|generation|pointer|read-back|version/i,
            mode
        )
    }

    const reconciledStore = new FaultyCasStore("commit-then-timeout")
    const staged = await stageImmutableRelease(reconciledStore, release)
    const promoted = await promoteReleasePointer(
        reconciledStore,
        staged,
        { expectedVersion: null }
    )
    const current = await resolveCurrentRelease(reconciledStore, NAMESPACE)
    assert.equal(promoted.version, current.version)
    assert.equal(current.pointer.sourceSha, SOURCE_A)
})

test("pointer CAS rejects a reused non-null generation", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new FaultyCasStore("normal")
    const stagedA = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    const promotedA = await promoteReleasePointer(store, stagedA, { expectedVersion: null })
    const stagedB = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_B, [["index.json", "B"]]))
    )
    store.mode = "unchanged-version"

    await assert.rejects(
        () => promoteReleasePointer(store, stagedB, { expectedVersion: promotedA.version }),
        /unchanged generation/i
    )
})

test("pointer CAS reconciles a false response only after an exact committed read-back", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new FaultyCasStore("false-after-commit")
    const staged = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )

    const promoted = await promoteReleasePointer(store, staged, { expectedVersion: null })
    const current = await resolveCurrentRelease(store, NAMESPACE)
    assert.equal(promoted.version, current.version)
    assert.equal(current.pointer.sourceSha, SOURCE_A)
})

test("rollback uses the same durable CAS reconciliation boundary", async () => {
    const prepare = async mode => {
        const {
            createReleaseManifest,
            promoteReleasePointer,
            stageImmutableRelease
        } = await loadProtocol()
        const store = new FaultyCasStore("normal")
        const stagedA = await stageImmutableRelease(
            store,
            createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
        )
        const promotedA = await promoteReleasePointer(store, stagedA, { expectedVersion: null })
        const stagedB = await stageImmutableRelease(
            store,
            createReleaseManifest(releaseInput(SOURCE_B, [["index.json", "B"]]))
        )
        const promotedB = await promoteReleasePointer(
            store,
            stagedB,
            { expectedVersion: promotedA.version }
        )
        store.mode = mode
        return { store, promotedB }
    }
    const { resolveCurrentRelease, rollbackReleasePointer } = await loadProtocol()

    const timeoutCase = await prepare("commit-then-timeout")
    const timeoutRollback = await rollbackReleasePointer(
        timeoutCase.store,
        NAMESPACE,
        { expectedVersion: timeoutCase.promotedB.version }
    )
    assert.equal(timeoutRollback.pointer.sourceSha, SOURCE_A)
    assert.equal((await resolveCurrentRelease(timeoutCase.store, NAMESPACE)).pointer.sourceSha, SOURCE_A)

    const wrongBytesCase = await prepare("wrong-bytes")
    await assert.rejects(
        () => rollbackReleasePointer(
            wrongBytesCase.store,
            NAMESPACE,
            { expectedVersion: wrongBytesCase.promotedB.version }
        ),
        /read-back.*different pointer bytes/i
    )
})

test("reserved JavaScript property names remain valid object paths", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new MemoryStore()
    const staged = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["__proto__", "safe"]]))
    )
    await promoteReleasePointer(store, staged, { expectedVersion: null })

    const current = await resolveCurrentRelease(store, NAMESPACE)
    assert.equal((await current.readObject("__proto__")).toString("utf8"), "safe")
})

test("inconsistent plans fail before the first immutable write", async () => {
    const { createReleaseManifest, stageImmutableRelease } = await loadProtocol()
    const release = createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    const mismatchedIdentity = {
        ...release,
        namespace: "other",
        sourceSha: SOURCE_B,
        releaseId: `${SOURCE_B}-${release.manifestDigest}`,
        manifestKey: `_releases/other/${SOURCE_B}-${release.manifestDigest}/manifest.json`
    }
    const mismatchStore = new MemoryStore()

    await assert.rejects(
        () => stageImmutableRelease(mismatchStore, mismatchedIdentity),
        /identity|namespace|source/i
    )
    assert.equal(mismatchStore.putCalls, 0)

    const extraEntryStore = new MemoryStore()
    const extraEntryPlan = {
        ...release,
        objectEntries: [
            ...release.objectEntries,
            { path: "orphan.json", bytes: byteString("orphan"), sha256: "0".repeat(64) }
        ]
    }
    await assert.rejects(
        () => stageImmutableRelease(extraEntryStore, extraEntryPlan),
        /entry|object|path|plan/i
    )
    assert.equal(extraEntryStore.putCalls, 0)

    const lateMismatchStore = new MemoryStore()
    const lateMismatchPlan = createReleaseManifest(releaseInput(SOURCE_A, [
        ["first.json", "first"],
        ["last.json", "last"]
    ]))
    lateMismatchPlan.objectEntries[1].bytes = byteString("tampered")
    await assert.rejects(
        () => stageImmutableRelease(lateMismatchStore, lateMismatchPlan),
        /bytes.*manifest/i
    )
    assert.equal(lateMismatchStore.putCalls, 0, "every object must pass preflight before the first write")

    const redundantDigestStore = new MemoryStore()
    const redundantDigestPlan = createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    redundantDigestPlan.objectEntries[0].sha256 = "0".repeat(64)
    await assert.rejects(
        () => stageImmutableRelease(redundantDigestStore, redundantDigestPlan),
        /digest|sha-256|manifest/i
    )
    assert.equal(redundantDigestStore.putCalls, 0)
})

test("an empty release withdraws every object and can be rolled back", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        rollbackReleasePointer,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new MemoryStore()
    const stagedA = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    const promotedA = await promoteReleasePointer(store, stagedA, { expectedVersion: null })
    const empty = createReleaseManifest({ namespace: NAMESPACE, sourceSha: SOURCE_B, objects: [] })
    const promotedEmpty = await promoteReleasePointer(
        store,
        await stageImmutableRelease(store, empty),
        { expectedVersion: promotedA.version }
    )

    const current = await resolveCurrentRelease(store, NAMESPACE)
    assert.deepEqual(current.manifest.objects, [])
    assert.equal(await current.readObject("index.json"), null)

    await rollbackReleasePointer(
        store,
        NAMESPACE,
        { expectedVersion: promotedEmpty.version }
    )
    const restored = await resolveCurrentRelease(store, NAMESPACE)
    assert.equal((await restored.readObject("index.json")).toString("utf8"), "A")
})

test("release pointers reject cross-namespace rollback destinations", async () => {
    const { createReleaseManifest, resolveCurrentRelease, stageImmutableRelease } = await loadProtocol()
    const store = new MemoryStore()
    const stagedCurrent = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    const stagedOther = await stageImmutableRelease(store, createReleaseManifest({
        namespace: "other",
        sourceSha: SOURCE_B,
        objects: [{ path: "index.json", bytes: byteString("other") }]
    }))
    await store.compareAndSwap(
        `_deploy/${NAMESPACE}/current.json`,
        null,
        canonicalPointerBytes(stagedCurrent, descriptorOf(stagedOther))
    )

    await assert.rejects(() => resolveCurrentRelease(store, NAMESPACE), /previous.*namespace/i)
})

test("release pointers reject a self-referential rollback destination", async () => {
    const { createReleaseManifest, resolveCurrentRelease, stageImmutableRelease } = await loadProtocol()
    const store = new MemoryStore()
    const staged = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    await store.compareAndSwap(
        `_deploy/${NAMESPACE}/current.json`,
        null,
        canonicalPointerBytes(staged, descriptorOf(staged))
    )

    await assert.rejects(() => resolveCurrentRelease(store, NAMESPACE), /previous.*itself|self-referential/i)
})

test("mutating a returned manifest cannot change later object verification", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new MemoryStore()
    const staged = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    await promoteReleasePointer(store, staged, { expectedVersion: null })
    const current = await resolveCurrentRelease(store, NAMESPACE)

    try {
        current.manifest.objects[0].sha256 = "0".repeat(64)
    } catch (error) {
        assert.ok(error instanceof TypeError)
    }
    assert.equal((await current.readObject("index.json")).toString("utf8"), "A")
})

test("promotion never classifies a store read failure as release corruption", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new MemoryStore()
    const stagedA = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    const promotedA = await promoteReleasePointer(store, stagedA, { expectedVersion: null })
    const stagedB = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_B, [["index.json", "B"]]))
    )
    const promotedB = await promoteReleasePointer(
        store,
        stagedB,
        { expectedVersion: promotedA.version }
    )
    const stagedC = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_C, [["index.json", "C"]]))
    )
    store.failGetKey = stagedB.objectKeys["index.json"]

    await assert.rejects(
        () => promoteReleasePointer(store, stagedC, { expectedVersion: promotedB.version }),
        /synthetic store read failure/i
    )
    store.failGetKey = null
    assert.equal((await resolveCurrentRelease(store, NAMESPACE)).pointer.sourceSha, SOURCE_B)
})

test("rollback requires only the verified destination when the current release is unreadable", async () => {
    const {
        createReleaseManifest,
        promoteReleasePointer,
        resolveCurrentRelease,
        rollbackReleasePointer,
        stageImmutableRelease
    } = await loadProtocol()
    const store = new MemoryStore()
    const stagedA = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    const promotedA = await promoteReleasePointer(store, stagedA, { expectedVersion: null })
    const stagedB = await stageImmutableRelease(
        store,
        createReleaseManifest(releaseInput(SOURCE_B, [["index.json", "B"]]))
    )
    const promotedB = await promoteReleasePointer(
        store,
        stagedB,
        { expectedVersion: promotedA.version }
    )
    store.failGetKey = stagedB.objectKeys["index.json"]

    const rolledBack = await rollbackReleasePointer(
        store,
        NAMESPACE,
        { expectedVersion: promotedB.version }
    )
    assert.equal(rolledBack.pointer.sourceSha, SOURCE_A)
    assert.equal(rolledBack.pointer.previous.sourceSha, SOURCE_B)
    store.failGetKey = null
    assert.equal((await resolveCurrentRelease(store, NAMESPACE)).pointer.sourceSha, SOURCE_A)
})
