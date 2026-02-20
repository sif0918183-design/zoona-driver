import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        const { driverId } = req.body;

        if (!driverId) {
            return res.status(400).json({ success: false, error: 'driverId is required' });
        }

        const { data, error } = await supabase
            .from('drivers')
            .select('push_subscription')
            .eq('id', driverId)
            .single();

        if (error || !data) {
            console.warn(`[check-driver-linked] Driver not found or error: ${driverId}`, error);
            return res.status(200).json({ linked: false });
        }

        const isLinked = !!data.push_subscription;
        console.log(`[check-driver-linked] Driver ${driverId} linked status: ${isLinked}`);

        return res.status(200).json({
            linked: isLinked
        });

    } catch (error) {
        console.error('Error in check-driver-linked:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
