// api/get-onesignal-id.js
export default function handler(req, res) {
  const appId = process.env.ONESIGNAL_APP_ID;
  if (appId) {
    res.status(200).json({ appId });
  } else {
    res.status(500).json({ error: 'OneSignal App ID not configured on the server.' });
  }
}
