"use strict"

const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const test = require("node:test")

const NAMESPACE = "synthetic-shadow"
const SOURCE_A = "a".repeat(40)
const SOURCE_B = "b".repeat(40)
const SOURCE_C = "c".repeat(40)

const bytes = value => Buffer.from(value, "utf8")

const loadModules = async () => {
    const [adapter, shadow, protocol] = await Promise.all([
        import("../ops/deploy/generation-store-adapter.js"),
        import("../ops/deploy/shadow-release-orchestrator.js"),
        import("../ops/deploy/release-protocol.js")
    ])
    return { ...adapter, ...shadow, ...protocol }
}

const requiredCapabilities = () => ({
    conditionalCreate: true,
    conditionalReplace: "generation-match",
    generationSemantics: "unique-per-write",
    readConsistency: "strong"
})

const makeTransportClass = GenerationTransportError => class MemoryGenerationTransport {
    constructor(capabilities = requiredCapabilities()) {
        this.capabilities = capabilities
        this.records = new Map()
        this.calls = []
        this.writeCalls = 0
        this.nextGeneration = 1
        this.failWriteAt = null
        this.commitThenTimeoutAt = null
        this.failReadKey = null
        this.failReadError = null
        this.readResponseMode = "generation"
        this.writeResponseMode = "generation"
        this.nextGenerationOverride = null
    }

    generation() {
        if (this.nextGenerationOverride !== null) {
            const value = this.nextGenerationOverride
            this.nextGenerationOverride = null
            return value
        }
        return `generation-${this.nextGeneration++}`
    }

    responseFor(record, mode = this.readResponseMode) {
        if (mode === "etag") {
            return {
                body: Buffer.from(record.body),
                etag: crypto.createHash("sha256").update(record.body).digest("hex")
            }
        }
        if (mode === "absent") {
            return { body: Buffer.from(record.body) }
        }
        return { body: Buffer.from(record.body), generation: record.generation }
    }

    writeResult(record) {
        if (this.writeResponseMode === "etag") {
            return { etag: crypto.createHash("sha256").update(record.body).digest("hex") }
        }
        if (this.writeResponseMode === "absent") {
            return {}
        }
        return { generation: record.generation }
    }

    noteWrite() {
        this.writeCalls += 1
        if (this.writeCalls === this.failWriteAt) {
            throw new Error(`injected transport write failure ${this.writeCalls}`)
        }
    }

    maybeTimeout() {
        if (this.writeCalls === this.commitThenTimeoutAt) {
            throw new Error(`injected committed response timeout ${this.writeCalls}`)
        }
    }

    async readObject({ key }) {
        this.calls.push({ operation: "read", key })
        if (key === this.failReadKey) {
            throw this.failReadError ?? new Error(`injected transport read failure at ${key}`)
        }
        const record = this.records.get(key)
        if (!record) {
            throw new GenerationTransportError("not-found", `missing ${key}`)
        }
        return this.responseFor(record)
    }

    async createObject({ key, body }) {
        this.calls.push({ operation: "create", key })
        this.noteWrite()
        if (this.records.has(key)) {
            throw new GenerationTransportError("precondition-failed", `exists ${key}`)
        }
        const record = { body: Buffer.from(body), generation: this.generation() }
        this.records.set(key, record)
        const result = this.writeResult(record)
        this.maybeTimeout()
        return result
    }

    async replaceObject({ key, body, ifGenerationMatch }) {
        this.calls.push({ operation: "replace", key, ifGenerationMatch })
        this.noteWrite()
        const current = this.records.get(key)
        if (!current || current.generation !== ifGenerationMatch) {
            throw new GenerationTransportError("precondition-failed", `stale ${key}`)
        }
        const record = { body: Buffer.from(body), generation: this.generation() }
        this.records.set(key, record)
        const result = this.writeResult(record)
        this.maybeTimeout()
        return result
    }

    forceRecord(key, body, generation) {
        this.records.set(key, { body: Buffer.from(body), generation })
    }

    snapshot(key) {
        const record = this.records.get(key)
        return record && { body: Buffer.from(record.body), generation: record.generation }
    }
}

const releaseInput = (sourceSha, entries) => ({
    namespace: NAMESPACE,
    sourceSha,
    objects: entries.map(([path, value]) => ({ path, bytes: bytes(value) }))
})

const prepare = async () => {
    const modules = await loadModules()
    const Transport = makeTransportClass(modules.GenerationTransportError)
    const transport = new Transport()
    const store = modules.createGenerationStoreAdapter({ transport })
    return { ...modules, Transport, transport, store }
}

test("adapter requires explicit strong generation capabilities and rejects ETag semantics", async () => {
    const { createGenerationStoreAdapter, GenerationTransportError } = await loadModules()
    const Transport = makeTransportClass(GenerationTransportError)

    assert.throws(() => createGenerationStoreAdapter({ transport: new Transport({}) }), /capabilit/i)
    assert.throws(() => createGenerationStoreAdapter({
        transport: new Transport({
            ...requiredCapabilities(),
            conditionalReplace: "etag-match"
        })
    }), /generation-match|etag/i)
    assert.throws(() => createGenerationStoreAdapter({
        transport: new Transport({
            ...requiredCapabilities(),
            readConsistency: "eventual"
        })
    }), /strong/i)
})

test("missing reads return null while transport errors propagate unchanged", async () => {
    const { transport, store } = await prepare()
    assert.equal(await store.get("missing"), null)

    const failure = new Error("provider authorization failure")
    transport.failReadKey = "denied"
    transport.failReadError = failure
    await assert.rejects(() => store.get("denied"), error => error === failure)
})

test("adapter fails closed on ETag-only or absent read and write generations", async () => {
    const { createGenerationStoreAdapter, GenerationTransportError } = await loadModules()
    const Transport = makeTransportClass(GenerationTransportError)

    for (const mode of ["etag", "absent"]) {
        const readTransport = new Transport()
        readTransport.forceRecord("value", bytes("A"), "generation-read")
        readTransport.readResponseMode = mode
        const readStore = createGenerationStoreAdapter({ transport: readTransport })
        await assert.rejects(() => readStore.get("value"), /generation/i, `read ${mode}`)

        const writeTransport = new Transport()
        writeTransport.writeResponseMode = mode
        const writeStore = createGenerationStoreAdapter({ transport: writeTransport })
        await assert.rejects(
            () => writeStore.putIfAbsent(`value-${mode}`, bytes("A")),
            /generation/i,
            `write ${mode}`
        )
    }
})

test("protocol reconciliation cannot bless a pointer write with no returned generation", async () => {
    const modules = await loadModules()
    const Transport = makeTransportClass(modules.GenerationTransportError)
    for (const mode of ["etag", "absent"]) {
        const transport = new Transport()
        const store = modules.createGenerationStoreAdapter({ transport })
        const staged = await modules.stageShadowRelease(
            store,
            modules.createShadowReleasePlan(
                releaseInput(SOURCE_A, [["index.json", `A:${mode}`]])
            )
        )
        transport.writeResponseMode = mode
        await assert.rejects(
            () => modules.promoteReleasePointer(store, staged.descriptor, {
                expectedVersion: null
            }),
            /generation|reconcil/i,
            mode
        )
    }
})

test("adapter rejects unchanged generations, changed bytes under one generation, and observed ABA", async () => {
    const { transport, store } = await prepare()
    const first = await store.compareAndSwap("pointer", null, bytes("A"))
    transport.nextGenerationOverride = first.version
    await assert.rejects(
        () => store.compareAndSwap("pointer", first.version, bytes("B")),
        /generation|reused|unchanged/i
    )

    const aba = await prepare()
    aba.transport.forceRecord("external", bytes("A"), "generation-A")
    await aba.store.get("external")
    aba.transport.forceRecord("external", bytes("B"), "generation-B")
    await aba.store.get("external")
    aba.transport.forceRecord("external", bytes("A"), "generation-A")
    await assert.rejects(() => aba.store.get("external"), /generation|reused|ABA/i)

    const silent = await prepare()
    silent.transport.forceRecord("external", bytes("A"), "generation-A")
    await silent.store.get("external")
    silent.transport.forceRecord("external", bytes("changed"), "generation-A")
    await assert.rejects(() => silent.store.get("external"), /generation|bytes|changed/i)
})

test("immutable staging is create-only and idempotent while collisions fail", async () => {
    const { createShadowReleasePlan, stageShadowRelease, transport, store } = await prepare()
    const plan = createShadowReleasePlan(releaseInput(SOURCE_A, [["index.json", "A"]]))
    const first = await stageShadowRelease(store, plan)
    const second = await stageShadowRelease(store, plan)
    assert.deepEqual(second.descriptor, first.descriptor)
    assert.ok(transport.calls.every(call => call.operation !== "replace"))

    const collision = await prepare()
    const collisionPlan = collision.createShadowReleasePlan(
        releaseInput(SOURCE_A, [["index.json", "A"]])
    )
    collision.transport.forceRecord(
        collisionPlan.operations[0].key,
        bytes("wrong"),
        "external-generation"
    )
    await assert.rejects(
        () => collision.stageShadowRelease(collision.store, collisionPlan),
        /immutable release collision/i
    )
})

test("shadow planning is deterministic on Windows and invalid input performs zero transport", async () => {
    const { createShadowReleasePlan, runShadowRelease, transport, store } = await prepare()
    assert.equal(process.platform, "win32")
    const forward = releaseInput(SOURCE_A, [
        ["zeta//final.json", "z"],
        ["./alpha/info.json", "a"]
    ])
    const baseline = createShadowReleasePlan(forward)
    for (let iteration = 0; iteration < 100; iteration += 1) {
        const input = releaseInput(SOURCE_A, iteration % 2 === 0
            ? [["zeta//final.json", "z"], ["./alpha/info.json", "a"]]
            : [["./alpha/info.json", "a"], ["zeta//final.json", "z"]])
        const plan = createShadowReleasePlan(input)
        assert.deepEqual(plan.planBytes, baseline.planBytes)
        assert.equal(plan.planDigest, baseline.planDigest)
        assert.equal(plan.releaseId, baseline.releaseId)
    }

    await assert.rejects(() => runShadowRelease(store, {
        namespace: NAMESPACE,
        sourceSha: SOURCE_B,
        objects: [
            { path: "same/./path.json", bytes: bytes("A") },
            { path: "same/path.json", bytes: bytes("B") }
        ]
    }, { expectedVersion: null }), /duplicate/i)
    assert.equal(transport.calls.length, 0)
})

test("failure at every immutable staging write leaves the pointer byte-identical", async () => {
    const modules = await loadModules()
    const Transport = makeTransportClass(modules.GenerationTransportError)
    for (const failureOffset of [1, 2, 3]) {
        const transport = new Transport()
        const store = modules.createGenerationStoreAdapter({ transport })
        const promotedA = await modules.runShadowRelease(
            store,
            releaseInput(SOURCE_A, [["index.json", "A"]]),
            { expectedVersion: null }
        )
        const before = transport.snapshot(promotedA.promotion.pointerKey)
        transport.failWriteAt = transport.writeCalls + failureOffset

        await assert.rejects(() => modules.runShadowRelease(
            store,
            releaseInput(SOURCE_B, [["index.json", "B"], ["new.json", "new"]]),
            { expectedVersion: promotedA.promotion.version }
        ), /injected transport write failure/)
        assert.deepEqual(transport.snapshot(promotedA.promotion.pointerKey), before)
    }
})

test("a promoted manifest omits removed files without deleting immutable history", async () => {
    const { runShadowRelease, resolveCurrentRelease, transport, store } = await prepare()
    const promotedA = await runShadowRelease(store, releaseInput(SOURCE_A, [
        ["index.json", "A:index"],
        ["withdrawn.json", "A:withdrawn"]
    ]), { expectedVersion: null })
    await runShadowRelease(
        store,
        releaseInput(SOURCE_B, [["index.json", "B:index"]]),
        { expectedVersion: promotedA.promotion.version }
    )

    const current = await resolveCurrentRelease(store, NAMESPACE)
    assert.equal((await current.readObject("index.json")).toString("utf8"), "B:index")
    assert.equal(await current.readObject("withdrawn.json"), null)
    assert.ok([...transport.records.keys()].some(key => key.includes(SOURCE_A)))
})

test("stale and concurrent promoters have exactly one winner", async () => {
    const {
        createShadowReleasePlan,
        promoteReleasePointer,
        resolveCurrentRelease,
        runShadowRelease,
        stageShadowRelease,
        store
    } = await prepare()
    const promotedA = await runShadowRelease(
        store,
        releaseInput(SOURCE_A, [["index.json", "A"]]),
        { expectedVersion: null }
    )
    const stagedB = await stageShadowRelease(
        store,
        createShadowReleasePlan(releaseInput(SOURCE_B, [["index.json", "B"]]))
    )
    const stagedC = await stageShadowRelease(
        store,
        createShadowReleasePlan(releaseInput(SOURCE_C, [["index.json", "C"]]))
    )
    const results = await Promise.allSettled([
        promoteReleasePointer(store, stagedB.descriptor, {
            expectedVersion: promotedA.promotion.version
        }),
        promoteReleasePointer(store, stagedC.descriptor, {
            expectedVersion: promotedA.promotion.version
        })
    ])
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1)
    assert.equal(results.filter(result => result.status === "rejected").length, 1)
    assert.match(results.find(result => result.status === "rejected").reason.message, /conflict/i)

    await assert.rejects(
        () => promoteReleasePointer(store, stagedB.descriptor, {
            expectedVersion: promotedA.promotion.version
        }),
        /conflict/i
    )
    const current = await resolveCurrentRelease(store, NAMESPACE)
    assert.ok([SOURCE_B, SOURCE_C].includes(current.pointer.sourceSha))
})

test("commit-then-timeout is accepted only after exact generation read-back", async () => {
    const {
        createShadowReleasePlan,
        promoteReleasePointer,
        resolveCurrentRelease,
        stageShadowRelease,
        transport,
        store
    } = await prepare()
    const stagedA = await stageShadowRelease(
        store,
        createShadowReleasePlan(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    transport.commitThenTimeoutAt = transport.writeCalls + 1
    const promotedA = await promoteReleasePointer(store, stagedA.descriptor, {
        expectedVersion: null
    })
    assert.equal((await resolveCurrentRelease(store, NAMESPACE)).version, promotedA.version)

    const stagedB = await stageShadowRelease(
        store,
        createShadowReleasePlan(releaseInput(SOURCE_B, [["index.json", "B"]]))
    )
    transport.commitThenTimeoutAt = transport.writeCalls + 1
    const promotedB = await promoteReleasePointer(store, stagedB.descriptor, {
        expectedVersion: promotedA.version
    })
    const current = await resolveCurrentRelease(store, NAMESPACE)
    assert.equal(current.version, promotedB.version)
    assert.equal(current.pointer.sourceSha, SOURCE_B)
})

test("rollback uses a fresh generation and restores only a verified release", async () => {
    const { resolveCurrentRelease, rollbackShadowRelease, runShadowRelease, store } = await prepare()
    const promotedA = await runShadowRelease(
        store,
        releaseInput(SOURCE_A, [["index.json", "A"]]),
        { expectedVersion: null }
    )
    const promotedB = await runShadowRelease(
        store,
        releaseInput(SOURCE_B, [["index.json", "B"]]),
        { expectedVersion: promotedA.promotion.version }
    )
    const rolledBack = await rollbackShadowRelease(store, NAMESPACE, {
        expectedVersion: promotedB.promotion.version
    })
    assert.notEqual(rolledBack.version, promotedB.promotion.version)
    assert.notEqual(rolledBack.version, promotedA.promotion.version)
    const current = await resolveCurrentRelease(store, NAMESPACE)
    assert.equal(current.pointer.sourceSha, SOURCE_A)
    assert.equal((await current.readObject("index.json")).toString("utf8"), "A")
})

test("provider read faults remain transport faults and never become not-found", async () => {
    const {
        createShadowReleasePlan,
        promoteReleasePointer,
        stageShadowRelease,
        transport,
        store
    } = await prepare()
    const staged = await stageShadowRelease(
        store,
        createShadowReleasePlan(releaseInput(SOURCE_A, [["index.json", "A"]]))
    )
    const objectKey = staged.descriptor.objectKeys["index.json"]
    const failure = new Error("synthetic provider outage")
    transport.failReadKey = objectKey
    transport.failReadError = failure
    await assert.rejects(
        () => promoteReleasePointer(store, staged.descriptor, { expectedVersion: null }),
        error => error === failure
    )
})
