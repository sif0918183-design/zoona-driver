export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

  const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY || "AIzaSyBxQLDLqr4W3lApfYLPjSV5It7925a9Rr0",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "double-carport-476915-j7.firebaseapp.com",
    projectId: process.env.FIREBASE_PROJECT_ID || "double-carport-476915-j7",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "double-carport-476915-j7.firebasestorage.app",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "122641462099",
    appId: process.env.FIREBASE_APP_ID || "1:122641462099:web:345b777a88757d3ef7e7a6",
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || "G-GVPPZJ74G9"
  };

  // Extract from FIREBASE_SERVICE_ACCOUNT if possible (raw or Base64-encoded JSON)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      let saStr = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      let sa = null;

      // Try raw JSON first
      if (saStr.startsWith('{')) {
        try {
          sa = JSON.parse(saStr);
        } catch (e) {
          console.error("Direct JSON.parse of FIREBASE_SERVICE_ACCOUNT failed, will try Base64:", e);
        }
      }

      // If parsing raw JSON failed or wasn't tried, try Base64 decoding
      if (!sa) {
        try {
          const decoded = Buffer.from(saStr, 'base64').toString('utf8');
          sa = JSON.parse(decoded);
        } catch (e) {
          console.error("Base64 decode and parse of FIREBASE_SERVICE_ACCOUNT failed:", e);
        }
      }

      if (sa) {
        // Extract apiKey
        const saApiKey = sa.apiKey || sa.api_key || sa.firebase_api_key || sa.FIREBASE_API_KEY;
        if (saApiKey) firebaseConfig.apiKey = saApiKey;

        // Extract projectId
        const saProjectId = sa.project_id || sa.projectId || sa.projectID;
        if (saProjectId) {
          firebaseConfig.projectId = saProjectId;
          if (!firebaseConfig.authDomain) {
            firebaseConfig.authDomain = `${saProjectId}.firebaseapp.com`;
          }
          if (!firebaseConfig.storageBucket) {
            firebaseConfig.storageBucket = `${saProjectId}.appspot.com`;
          }
        }

        // Extract authDomain
        const saAuthDomain = sa.authDomain || sa.auth_domain;
        if (saAuthDomain) firebaseConfig.authDomain = saAuthDomain;

        // Extract storageBucket
        const saStorageBucket = sa.storageBucket || sa.storage_bucket;
        if (saStorageBucket) firebaseConfig.storageBucket = saStorageBucket;

        // Extract messagingSenderId
        const saMessagingSenderId = sa.messagingSenderId || sa.messaging_sender_id || sa.senderId || sa.sender_id;
        if (saMessagingSenderId) firebaseConfig.messagingSenderId = saMessagingSenderId;

        // Extract appId
        const saAppId = sa.appId || sa.app_id;
        if (saAppId) firebaseConfig.appId = saAppId;

        // Check for nested configuration object
        const nested = sa.firebaseConfig || sa.firebase_config || sa.clientConfig || sa.client_config;
        if (nested && typeof nested === 'object') {
          if (nested.apiKey || nested.api_key) firebaseConfig.apiKey = nested.apiKey || nested.api_key;
          if (nested.authDomain || nested.auth_domain) firebaseConfig.authDomain = nested.authDomain || nested.auth_domain;
          if (nested.projectId || nested.project_id) firebaseConfig.projectId = nested.projectId || nested.project_id;
          if (nested.storageBucket || nested.storage_bucket) firebaseConfig.storageBucket = nested.storageBucket || nested.storage_bucket;
          if (nested.messagingSenderId || nested.messaging_sender_id) firebaseConfig.messagingSenderId = nested.messagingSenderId || nested.messaging_sender_id;
          if (nested.appId || nested.app_id) firebaseConfig.appId = nested.appId || nested.app_id;
        }
      }
    } catch (e) {
      console.error("General error parsing FIREBASE_SERVICE_ACCOUNT inside /api/supabase-config:", e);
    }
  }

  const js = `
    window.SB_URL = "${supabaseUrl}";
    window.SB_KEY = "${supabaseAnonKey}";
    window.FIREBASE_CONFIG = ${JSON.stringify(firebaseConfig)};
    if (typeof process !== 'undefined') {
      process.env = process.env || {};
      process.env.SUPABASE_URL = "${supabaseUrl}";
      process.env.SUPABASE_ANON_KEY = "${supabaseAnonKey}";
    }
  `;

  res.status(200).send(js);
}
