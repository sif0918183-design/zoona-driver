import { verifyToken } from './_token-utils.js';

export default function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    verifyToken(req);
  } catch (error) {
    return res.status(401).json({ success: false, error: error.message });
  }

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

  const response = {
    serviceRoleKey,
    data: {
      serviceRoleKey
    }
  };

  res.status(200).json(response);
}
