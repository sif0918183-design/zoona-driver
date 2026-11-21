import { createClient } from '@supabase/supabase-js';
import { verifyToken } from './_token-utils.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

// Safe projection: never expose internal/admin-only fields to the app clients.
const PUBLIC_FIELDS =
    'id, title, body, image_url, primary_button_text, primary_button_url, ' +
    'secondary_button_text, secondary_button_url, delay_seconds, priority, ' +
    'repeat_policy, repeat_interval_minutes, start_at, end_at';

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    // The session role is derived from the verified token ONLY. Any role/target_app
    // value sent by the client is ignored, so apps cannot cross-read each other's messages.
    let session;
    if (!supabase) {
        return res.status(503).json({ success: false, error: 'Supabase server configuration is unavailable' });
    }

    try {
        session = verifyToken(req);
    } catch (error) {
        return res.status(401).json({ success: false, error: error.message });
    }

    const { id: userId, role } = session;
    if (role !== 'driver' && role !== 'passenger') {
        return res.status(403).json({ success: false, error: 'دور غير مصرح له' });
    }

    const action = req.body && req.body.action;

    try {
        if (action === 'mark_view') {
            const messageId = req.body.message_id;
            if (!messageId) {
                return res.status(400).json({ success: false, error: 'معرف الرسالة مطلوب' });
            }

            // Permanent per-user record. Idempotent thanks to the unique constraint.
            const { error } = await supabase
                .from('popup_message_views')
                .upsert(
                    [{ message_id: messageId, user_id: userId }],
                    { onConflict: 'user_id,message_id', ignoreDuplicates: true }
                );

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (action === 'list' || !action) {
            // Enforce the audience at the QUERY level using the verified session role.
            const { data, error } = await supabase
                .from('popup_messages')
                .select(PUBLIC_FIELDS)
                .eq('target_app', role)
                .eq('is_active', true)
                .order('priority', { ascending: false })
                .order('created_at', { ascending: false });

            if (error) throw error;

            // Apply the date window on the server (robust across PostgREST versions
            // and avoids double .or() overriding each other). The dataset is small.
            const now = Date.now();
            let messages = (data || []).filter((m) => {
                if (m.start_at && new Date(m.start_at).getTime() > now) return false;
                if (m.end_at && new Date(m.end_at).getTime() < now) return false;
                return true;
            });

            // For "once" messages, drop any already seen permanently by this user.
            const onceIds = messages.filter((m) => m.repeat_policy === 'once').map((m) => m.id);
            if (onceIds.length > 0) {
                const { data: views, error: viewsErr } = await supabase
                    .from('popup_message_views')
                    .select('message_id')
                    .eq('user_id', userId)
                    .in('message_id', onceIds);

                if (!viewsErr && views) {
                    const seen = new Set(views.map((v) => v.message_id));
                    messages = messages.filter((m) => m.repeat_policy !== 'once' || !seen.has(m.id));
                }
            }

            return res.status(200).json({ success: true, messages: messages.slice(0, 20) });
        }

        return res.status(400).json({ success: false, error: 'إجراء غير معروف' });

    } catch (error) {
        console.error('Error in popup-messages handler:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ في جلب الرسائل' });
    }
}
