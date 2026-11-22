import { createClient } from '@supabase/supabase-js';
import { verifyToken } from './_token-utils.js';

const db = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

const fail = (res, status, error) => res.status(status).json({ success: false, error });
const adminSession = s => s?.role === 'admin' && s.id === 'tracka-admin';

function vehicleRank(value) {
  const v = String(value || '').toLowerCase();
  if (v.includes('vip') || v.includes('suv') || v.includes('عالي')) return 3;
  if (v.includes('comfort') || v.includes('مريح')) return 2;
  if (v.includes('economy') || v.includes('اقتصادي')) return 1;
  return 0;
}
function categoryRank(value) {
  const v = String(value || '').toLowerCase();
  if (v.includes('suv') || v.includes('عالي')) return 3;
  if (v.includes('comfort') || v.includes('مريح')) return 2;
  if (v.includes('economy') || v.includes('اقتصادي')) return 1;
  return 99;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const isCronGet = req.method === 'GET' && req.query?.action === 'process_due';
  if (req.method !== 'POST' && !isCronGet) return fail(res, 405, 'Method not allowed');
  if (!db) return fail(res, 503, 'إعدادات قاعدة البيانات غير مكتملة على الخادم');

  const action = req.body?.action || req.query?.action;
  if (!action) return fail(res, 400, 'Action is required');

  let session = null;
  if (action === 'process_due') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return fail(res, 401, 'غير مصرح');
  } else {
    try { session = verifyToken(req); }
    catch (e) { return fail(res, 401, e.message); }
  }

  try {
    const b = req.body || {};
    const id = session?.id;
    const isAdmin = adminSession(session);

    if (action === 'list_config') {
      const [{ data: cities, error: ce }, { data: categories, error: ve }, { data: prices, error: pe }] = await Promise.all([
        db.from('cities').select('id,name_ar').order('name_ar'),
        db.from('vehicle_categories').select('id,name_ar,name_en,description_ar,icon_emoji,sort_order').eq('is_active', true).order('sort_order'),
        db.from('limousine_pricing').select('city_id,vehicle_category_id,daily_price,commission_rate,min_days,max_days').eq('is_active', true)
      ]);
      if (ce || ve || pe) throw ce || ve || pe;
      return res.status(200).json({ success: true, cities, categories, pricing: prices });
    }

    if (action === 'create_request') {
      if (session?.role !== 'passenger' || id !== b.passengerId) return fail(res, 403, 'غير مصرح بإنشاء طلب لراكب آخر');
      const { data, error } = await db.rpc('limousine_create_request', {
        p_passenger_id: id, p_city_id: b.cityId, p_pickup_area: b.pickupArea,
        p_start_at: b.startAt, p_duration_days: Number(b.durationDays),
        p_requested_category_id: b.categoryId, p_passenger_count: Number(b.passengerCount || 1),
        p_usage_purpose: b.purpose || null, p_notes: b.notes || null
      });
      if (error) throw error;
      return res.status(200).json({ success: true, result: data });
    }

    if (action === 'list_passenger_requests') {
      if (session?.role !== 'passenger' || id !== b.passengerId) return fail(res, 403, 'غير مصرح');
      const { data: requests, error } = await db.from('limousine_requests').select('*').eq('passenger_id', id).order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      const requestIds = (requests || []).map(x => x.id);
      if (!requestIds.length) return res.status(200).json({ success: true, requests: [], acceptances: [], contracts: [] });
      const [{ data: acceptances, error: ae }, { data: contracts, error: ce }] = await Promise.all([
        db.from('limousine_acceptances').select('id,request_id,driver_id,status,accepted_at').in('request_id', requestIds),
        db.from('limousine_contracts').select('*').in('request_id', requestIds).order('created_at', { ascending: false })
      ]);
      if (ae || ce) throw ae || ce;
      const driverIds = [...new Set((acceptances || []).map(x => x.driver_id))];
      const { data: drivers, error: de } = driverIds.length ? await db.from('drivers').select('id,full_name,car_type,car_model,car_color,rating,total_rides,profile_image_url').in('id', driverIds) : { data: [], error: null };
      if (de) throw de;
      return res.status(200).json({ success: true, requests, acceptances, contracts, drivers: drivers || [] });
    }

    if (action === 'list_driver_requests') {
      if (session?.role !== 'driver' || id !== b.driverId) return fail(res, 403, 'غير مصرح');
      const { data: driver, error: dre } = await db.from('drivers').select('id,car_type,vehicle_type,is_active,is_approved,is_banned,status').eq('id', id).maybeSingle();
      if (dre || !driver) throw dre || new Error('السائق غير موجود');
      if (!driver.is_active || !driver.is_approved || driver.is_banned || driver.status === 'SUSPENDED') return fail(res, 403, 'حساب السائق غير مؤهل');
      const { data: cats, error: catErr } = await db.from('vehicle_categories').select('id,name_ar');
      if (catErr) throw catErr;
      const rank = vehicleRank(driver.car_type || driver.vehicle_type);
      const categoryMap = new Map((cats || []).map(c => [c.id, c.name_ar]));
      const { data: requests, error } = await db.from('limousine_requests').select('*').in('status', ['open','awaiting_driver_selection']).gt('start_at', new Date().toISOString()).order('start_at').limit(100);
      if (error) throw error;
      const eligible = (requests || []).filter(r => rank >= categoryRank(categoryMap.get(r.requested_category_id)));
      const ids = eligible.map(r => r.id);
      if (!ids.length) return res.status(200).json({ success: true, requests: [] });
      const [{ data: accepted, error: ae }, { data: counts, error: countErr }] = await Promise.all([
        db.from('limousine_acceptances').select('request_id,status').eq('driver_id', id).in('request_id', ids),
        ids.length ? db.from('limousine_acceptances').select('request_id,status').in('request_id', ids).in('status', ['accepted','selected','contracted']) : Promise.resolve({ data: [], error: null })
      ]);
      if (ae || countErr) throw ae || countErr;
      const acceptedSet = new Set((accepted || []).map(x => x.request_id));
      const countMap = new Map();
      (counts || []).forEach(x => countMap.set(x.request_id, (countMap.get(x.request_id) || 0) + 1));
      return res.status(200).json({ success: true, requests: eligible.filter(r => !acceptedSet.has(r.id)).map(r => ({ ...r, accepted_count: countMap.get(r.id) || 0 })) });
    }

    if (action === 'accept_request') {
      if (session?.role !== 'driver' || id !== b.driverId) return fail(res, 403, 'غير مصرح');
      const { data, error } = await db.rpc('limousine_accept_request', { p_request_id: b.requestId, p_driver_id: id });
      if (error) throw error;
      return res.status(200).json({ success: true, result: data });
    }

    if (action === 'select_driver') {
      if (session?.role !== 'passenger' || id !== b.passengerId) return fail(res, 403, 'غير مصرح');
      const { data, error } = await db.rpc('limousine_select_driver', { p_request_id: b.requestId, p_driver_id: b.driverId, p_passenger_id: id });
      if (error) throw error;
      return res.status(200).json({ success: true, result: data });
    }

    if (action === 'list_contracts') {
      if (!['passenger','driver'].includes(session?.role)) return fail(res, 403, 'غير مصرح');
      let query = db.from('limousine_contracts').select('*').order('created_at', { ascending: false }).limit(100);
      query = session.role === 'passenger' ? query.eq('passenger_id', id) : query.eq('driver_id', id);
      const { data, error } = await query;
      if (error) throw error;
      return res.status(200).json({ success: true, contracts: data || [] });
    }

    if (action === 'list_messages' || action === 'send_message' || action === 'request_end' || action === 'confirm_end') {
      if (!['passenger','driver'].includes(session?.role)) return fail(res, 403, 'غير مصرح');
      const { data: chat, error: chatError } = await db.from('limousine_chats').select('*').eq('contract_id', b.contractId).maybeSingle();
      if (chatError || !chat) throw chatError || new Error('المحادثة غير موجودة');
      const owns = session.role === 'passenger' ? chat.passenger_id === id : chat.driver_id === id;
      if (!owns) return fail(res, 403, 'لا تملك صلاحية الوصول إلى هذه المحادثة أو العقد');

      if (action === 'list_messages') {
        const { data, error } = await db.from('limousine_chat_messages').select('*').eq('chat_id', chat.id).order('created_at').limit(200);
        if (error) throw error;
        return res.status(200).json({ success: true, messages: data || [] });
      }
      if (action === 'send_message') {
        const message = String(b.message || '').trim();
        if (!message || message.length > 4000) return fail(res, 400, 'نص الرسالة غير صالح');
        const { data, error } = await db.from('limousine_chat_messages').insert({ chat_id: chat.id, sender_id: id, sender_type: session.role, message }).select('*').single();
        if (error) throw error;
        const otherId = session.role === 'passenger' ? chat.driver_id : chat.passenger_id;
        const otherType = session.role === 'passenger' ? 'driver' : 'passenger';
        await db.from('limousine_notifications').insert({ request_id: chat.request_id, contract_id: chat.contract_id, recipient_id: otherId, recipient_type: otherType, event_code: 'LIMO_NEW_MESSAGE', title: 'رسالة جديدة', body: 'لديك رسالة جديدة في محادثة التأجير', payload: { chat_id: chat.id } });
        return res.status(200).json({ success: true, message: data });
      }
      const { data: contract, error: contractError } = await db.from('limousine_contracts').select('*').eq('id', b.contractId).maybeSingle();
      if (contractError || !contract) throw contractError || new Error('العقد غير موجود');
      if (action === 'request_end') {
        const { data, error } = await db.rpc('limousine_request_end', { p_contract_id: b.contractId, p_user_id: id, p_user_role: session.role });
        if (error) throw error;
        return res.status(200).json({ success: true, result: data });
      }
      if (action === 'confirm_end') {
        const { data, error } = await db.rpc('limousine_confirm_end', { p_contract_id: b.contractId, p_user_id: id, p_user_role: session.role });
        if (error) throw error;
        return res.status(200).json({ success: true, result: data });
      }
    }

    if (action === 'admin_overview' || action === 'admin_update_pricing' || action === 'admin_resolve') {
      if (!isAdmin) return fail(res, 403, 'صلاحيات الإدارة مطلوبة');
      if (action === 'admin_overview') {
        const [{ data: requests, error: re }, { data: contracts, error: ce }, { data: pricing, error: pe }, { data: ledger, error: le }] = await Promise.all([
          db.from('limousine_requests').select('*').order('created_at', { ascending: false }).limit(200),
          db.from('limousine_contracts').select('*').order('created_at', { ascending: false }).limit(200),
          db.from('limousine_pricing').select('*,cities(name_ar),vehicle_categories(name_ar)').order('created_at', { ascending: false }),
          db.from('limousine_ledger').select('entry_type,amount,created_at').order('created_at', { ascending: false }).limit(500)
        ]);
        if (re || ce || pe || le) throw re || ce || pe || le;
        return res.status(200).json({ success: true, requests, contracts, pricing, ledger });
      }
      if (action === 'admin_update_pricing') {
        const price = Number(b.dailyPrice), rate = Number(b.commissionRate);
        if (!b.cityId || !b.categoryId || !Number.isFinite(price) || price <= 0 || !Number.isFinite(rate) || rate <= 0 || rate > 100) return fail(res, 400, 'بيانات السعر أو العمولة غير صالحة');
        const { data, error } = await db.from('limousine_pricing').upsert({ city_id: b.cityId, vehicle_category_id: b.categoryId, daily_price: price, commission_rate: rate, min_days: Math.max(1, Number(b.minDays) || 1), max_days: b.maxDays ? Number(b.maxDays) : null, is_active: b.isActive !== false, updated_at: new Date().toISOString() }, { onConflict: 'city_id,vehicle_category_id' }).select('*').single();
        if (error) throw error;
        return res.status(200).json({ success: true, pricing: data });
      }
      if (!b.contractId || !['no_penalty','penalty'].includes(b.resolution)) return fail(res, 400, 'بيانات التسوية غير مكتملة');
      const { data, error } = await db.rpc('limousine_settle_contract', { p_contract_id: b.contractId, p_end_at: b.endAt || new Date().toISOString(), p_penalty_days: Number(b.penaltyDays) || 0, p_resolution: b.resolution });
      if (error) throw error;
      return res.status(200).json({ success: true, result: data });
    }

    if (action === 'process_due') {
      const { data, error } = await db.rpc('limousine_process_due');
      if (error) throw error;
      return res.status(200).json({ success: true, result: data });
    }

    return fail(res, 400, 'Unknown action');
  } catch (error) {
    console.error('[Limousine API]', error);
    const message = String(error?.message || 'حدث خطأ غير متوقع');
    const clientErrors = ['start_must_be_future','invalid_duration','invalid_request_details','passenger_not_found','pricing_unavailable','duration_out_of_pricing_range','request_not_found','request_not_available','driver_not_eligible','vehicle_category_not_eligible','acceptance_limit_reached','request_not_found_or_forbidden','request_not_selectable','driver_has_not_accepted','live_contract_exists','contract_not_found','contract_not_settleable','commission_not_held','contract_not_owned','contract_not_eligible_for_early_end','no_end_confirmation_pending'];
    return fail(res, clientErrors.includes(message) ? 400 : 500, message);
  }
}
