import firebase from "firebase-admin"
import { getFirestore } from "firebase-admin/firestore"
import { createRequire } from "module"
import { FIREBASE_DATABASE_NAME, DEPLOY_ENV } from "./constants.js"
const require = createRequire(import.meta.url);

let deployCreds = require(DEPLOY_ENV === "prod" ? "../deploy/creds/deploy-creds.json" : "../deploy/creds/deploy-creds-stage.json")

// Mock firestore for local purposes
const localFirestore = function () {
    return {
        collection: function () { return localFirestore() },
        doc: function () { return localFirestore() },
        set: function () { return localFirestore() },
        get: function () { return localFirestore() },
        batch: function () {return { commit: function () {}, set: function () {} }},
    }
}

firebase.initializeApp({
    databaseURL: FIREBASE_DATABASE_NAME,
    credential: firebase.credential.cert(deployCreds),
    databaseAuthVariableOverride: {
        uid: "deploy"
    }
});

export const database = DEPLOY_ENV === "local" ? localFirestore() : getFirestore()
