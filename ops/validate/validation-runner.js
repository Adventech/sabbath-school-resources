export async function runValidation(selection, validate) {
    if (!selection || typeof selection !== "object") {
        throw new TypeError("Validation selection must be an object")
    }
    if (typeof validate !== "function") {
        throw new TypeError("Validator must be a function")
    }

    for (const language of Object.keys(selection)) {
        const resourceTypes = selection[language]
        if (!resourceTypes || typeof resourceTypes !== "object") {
            throw new TypeError(`Invalid validation selection for ${language}`)
        }

        for (const resourceType of Object.keys(resourceTypes)) {
            const target = resourceTypes[resourceType]
            if (!target || typeof target.resources !== "string") {
                throw new TypeError(
                    `Invalid validation target for ${language}/${resourceType}`,
                )
            }

            await validate(language, resourceType, target.resources)
        }
    }
}
