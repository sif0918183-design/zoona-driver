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
