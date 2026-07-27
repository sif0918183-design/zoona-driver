export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  const whatsappRenderUrl = process.env.WHATSAPP_RENDER_URL || '';

  const js = `
    window.SB_URL = "${supabaseUrl}";
    window.SB_KEY = "${supabaseAnonKey}";
    window.WHATSAPP_RENDER_URL = "${whatsappRenderUrl}";
    if (typeof process !== 'undefined') {
      process.env = process.env || {};
      process.env.SUPABASE_URL = "${supabaseUrl}";
      process.env.SUPABASE_ANON_KEY = "${supabaseAnonKey}";
    }
  `;

  res.status(200).send(js);
}
