import admin from “firebase-admin”;

const serviceAccount = JSON.parse(process.env[“FIREBASE_JSON”]);

admin.initializeApp({
credential: admin.credential.cert(serviceAccount)
});

export const db = admin.firestore();
export const firebaseAdmin = admin;