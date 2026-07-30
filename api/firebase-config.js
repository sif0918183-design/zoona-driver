export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY || "",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.FIREBASE_PROJECT_ID || "",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
    appId: process.env.FIREBASE_APP_ID || ""
  };

  // Extract from FIREBASE_SERVICE_ACCOUNT if possible
  if (!firebaseConfig.projectId && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      firebaseConfig.projectId = sa.project_id || "";
      firebaseConfig.authDomain = sa.project_id ? `${sa.project_id}.firebaseapp.com` : "";
      firebaseConfig.storageBucket = sa.project_id ? `${sa.project_id}.appspot.com` : "";
    } catch (e) {
      console.error("Error parsing FIREBASE_SERVICE_ACCOUNT inside /api/firebase-config:", e);
    }
  }

  const js = `
    window.FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig)};
  `;

  res.status(200).send(js);
}
