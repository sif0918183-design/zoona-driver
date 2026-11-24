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
    catch (e) { return fail(res, 401, 'غير مصرح'); }
  }

  try {
    const b = req.body || {};
    const id = session?.id;
    const isAdmin = adminSession(session);

    if (action === 'get_active_contract') {
      if (!['passenger','driver'].includes(session?.role)) return fail(res,403,'غير مصرح');
      const ownerColumn=session.role==='passenger'?'passenger_id':'driver_id';
      const {data: contract,error}=await db.from('limousine_contracts').select('*').eq(ownerColumn,id)
        .in('status',['booked','active','completion_requested','awaiting_settlement','disputed']).gt('commission_held',0).order('created_at',{ascending:false}).limit(1).maybeSingle();
      if(error)throw error;
      if(!contract)return res.status(200).json({success:true,contract:null});
      const {data:request,error:re}=await db.from('limousine_requests')
        .select('requested_category_id,pickup_area').eq('id',contract.request_id).maybeSingle();
      if(re)throw re;
      const [{data:driver,error:de},{data:category,error:ce}]=await Promise.all([
        db.from('drivers').select('car_model,car_type,vehicle_type').eq('id',contract.driver_id).maybeSingle(),
        request?.requested_category_id
          ? db.from('vehicle_categories').select('name_ar,instant_vehicle_id').eq('id',request.requested_category_id).maybeSingle()
          : Promise.resolve({data:null,error:null})
      ]);
      if(de||ce)throw de||ce;
      const startDateKey=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Khartoum',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(contract.start_at));
      const firstDayEnd=new Date(startDateKey+'T17:00:00+02:00');
      const elapsed=Date.now()<firstDayEnd.getTime()?0:Math.min(Number(contract.duration_days||1),1+Math.floor((Date.now()-firstDayEnd.getTime())/86400000));
      return res.status(200).json({success:true,contract:{
        id:contract.id,status:contract.status,start_at:contract.start_at,duration_days:Number(contract.duration_days||1),
        days_completed:elapsed,days_remaining:Math.max(0,Number(contract.duration_days||1)-elapsed),
        daily_price:Number(contract.daily_price_snapshot||0),total:Number(contract.contract_value_snapshot||0),
        category_name:category?.name_ar||'سيارة',car_model:driver?.car_model||'—',
        pickup_area:request?.pickup_area||'—',scheduled_end_at:contract.scheduled_end_at
      }});
    }

    if (action === 'list_config') {
      const [{ data: cities, error: ce }, { data: settings, error: se }, { data: categoryRows, error: ve }, { data: prices, error: pe }] = await Promise.all([
        db.from('cities').select('id,name_ar').order('name_ar'),
        db.from('system_settings').select('value').eq('key', 'instant_vehicle_prices').maybeSingle(),
        db.from('vehicle_categories').select('id,instant_vehicle_id,is_active').eq('is_active', true).not('instant_vehicle_id', 'is', null),
        db.from('limousine_pricing').select('city_id,vehicle_category_id,daily_price,commission_rate,min_days,max_days').eq('is_active', true)
      ]);
      if (ce || se || ve || pe) throw ce || se || ve || pe;
      let instantVehicles = [];
      try {
        const raw = settings?.value;
        instantVehicles = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
      } catch (error) {
        throw new Error('تعذر قراءة فئات السيارات المعتمدة في إعدادات الرحلات الداخلية.');
      }
      if (!Array.isArray(instantVehicles) || !instantVehicles.length) {
        throw new Error('لا توجد فئات سيارات معتمدة في إعدادات الرحلات الداخلية.');
      }
      const categoryMap = new Map((categoryRows || []).map(row => [row.instant_vehicle_id, row]));
      const categories = instantVehicles.map((vehicle, index) => {
        const mapped = categoryMap.get(String(vehicle.id));
        if (!mapped) throw new Error('فئة السيارة ' + String(vehicle.name || vehicle.id) + ' غير مربوطة بتسعير الليموزين.');
        return {
          id: mapped.id,
          instant_vehicle_id: String(vehicle.id),
          name_ar: String(vehicle.name || ''),
          name_en: String(vehicle.name || ''),
          icon_emoji: vehicle.icon || '🚗',
          sort_order: index
        };
      });
      return res.status(200).json({ success: true, cities, categories, pricing: prices });
    }

    if (action === 'create_request') {
      if (session?.role !== 'passenger' || id !== b.passengerId) return fail(res, 403, 'غير مصرح بإنشاء طلب لراكب آخر');
      const startDate=String(b.startDate||'').trim();
      if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(startDate))return fail(res,400,'حدد تاريخ بداية التأجير بصيغة صحيحة.');
      const [year,month,day]=startDate.split('-').map(Number),check=new Date(Date.UTC(year,month-1,day));
      if(check.getUTCFullYear()!==year||check.getUTCMonth()!==month-1||check.getUTCDate()!==day)return fail(res,400,'تاريخ بداية التأجير غير صحيح.');
      const startAt=new Date(startDate+'T07:00:00+02:00'),durationDays=Number(b.durationDays);
      if(!Number.isFinite(startAt.getTime())||startAt.getTime()<=Date.now())return fail(res,400,'start_must_be_future');
      if(!Number.isInteger(durationDays)||durationDays<1||durationDays>90)return fail(res,400,'invalid_duration');
      const { data, error } = await db.rpc('limousine_create_request', {
        p_passenger_id:id,p_city_id:b.cityId,p_pickup_area:b.pickupArea,
        p_start_at:startAt.toISOString(),p_duration_days:durationDays,
        p_requested_category_id:b.categoryId,p_passenger_count:Number(b.passengerCount||1),
        p_usage_purpose:b.purpose||null,p_notes:b.notes||null
      });
      if (error) throw error;
      return res.status(200).json({ success: true, result: data });
    }

    if (action === 'list_passenger_requests') {
      if (session?.role !== 'passenger' || id !== b.passengerId) return fail(res, 403, 'غير مصرح');
      const { data: requests, error } = await db.from('limousine_requests').select('*').eq('passenger_id', id).order('created_at', { ascending: false }).limit(50);
      if (error) throw error;
      const requestIds = (requests || []).map(x => x.id);
      if (!requestIds.length) return res.status(200).json({ success: true, requests: [], acceptances: [], contracts: [], drivers: [] });
      const [{ data: acceptances, error: ae }, { data: contracts, error: ce }, { data: cancellationRows, error: xe }] = await Promise.all([
        db.from('limousine_acceptances').select('id,request_id,driver_id,status,accepted_at').in('request_id', requestIds),
        db.from('limousine_contracts').select('id,request_id,status').in('request_id', requestIds).order('created_at', { ascending: false }),
        db.from('limousine_cancellation_requests').select('*').in('request_id', requestIds).order('created_at', { ascending: false })
      ]);
      if (ae || ce || xe) throw ae || ce || xe;
      const driverIds = [...new Set((acceptances || []).map(x => x.driver_id))];
      const released = new Set((contracts || []).filter(c => ['booked','active','completion_requested','awaiting_settlement','settled','disputed'].includes(c.status)).map(c => c.request_id));
      const { data: driverRows, error: de } = driverIds.length
        ? await db.from('drivers').select('id,full_name,car_type,car_model,car_color,phone,whatsapp_number,rating,total_rides,profile_image_url,car_plate_number').in('id', driverIds)
        : { data: [], error: null };
      if (de) throw de;
      const driverMap = new Map((driverRows || []).map(d => [d.id, d]));
      const safeDrivers = (acceptances || []).map(a => {
        const d = driverMap.get(a.driver_id);
        if (!d) return null;
        const identityReleased = released.has(a.request_id);
        const safe = {
          id:d.id, request_id:a.request_id, car_type:d.car_type,
          car_model:d.car_model, car_color:d.car_color, identity_released:identityReleased
        };
        if (identityReleased) Object.assign(safe, {
          full_name:d.full_name, phone:d.phone, whatsapp_number:d.whatsapp_number,
          rating:d.rating, total_rides:d.total_rides, profile_image_url:d.profile_image_url,
          car_plate_number:d.car_plate_number
        });
        return safe;
      }).filter(Boolean);
      const latestCancellation = new Map();
      (cancellationRows || []).forEach(x => { if (!latestCancellation.has(x.contract_id)) latestCancellation.set(x.contract_id, x); });
      const contractsWithCancellation = (contracts || []).map(x => ({ ...x, cancellation_request: latestCancellation.get(x.id) || null }));
      return res.status(200).json({ success: true, requests, acceptances, contracts: contractsWithCancellation, drivers: safeDrivers });
    }

    if (action === 'list_driver_requests') {
      if (session?.role !== 'driver' || id !== b.driverId) return fail(res, 403, 'غير مصرح');
      const { data: driver, error: dre } = await db.from('drivers')
        .select('id,full_name,balance,car_type,vehicle_type,is_active,is_approved,is_banned,is_available,status')
        .eq('id', id).maybeSingle();
      if (dre || !driver) throw dre || new Error('driver_not_found');
      if (!driver.is_active || !driver.is_approved || driver.is_banned || driver.status === 'SUSPENDED') return fail(res, 403, 'driver_not_eligible');
      const {data:activeContract,error:activeContractError}=await db.from('limousine_contracts')
        .select('id').eq('driver_id',id)
        .in('status',['booked','active','completion_requested','awaiting_settlement','disputed'])
        .gt('commission_held',0).order('created_at',{ascending:false}).limit(1).maybeSingle();
      if(activeContractError)throw activeContractError;
      const hasActiveContract=!!activeContract;
      if(!driver.is_available&&!hasActiveContract)return fail(res,403,'driver_not_eligible');
      const { data: cats, error: catErr } = await db.from('vehicle_categories').select('id,name_ar,sort_order').eq('is_active', true).order('sort_order');
      if (catErr) throw catErr;
      const driverCategory = (cats || []).find(c => String(c.id) === String(driver.car_type || driver.vehicle_type));
      const legacyDriverRank = vehicleRank(driver.car_type || driver.vehicle_type);
      const categoryMap = new Map((cats || []).map(c => [String(c.id), c]));
      const { data: rows, error } = await db.from('limousine_requests').select('*')
        .in('status', ['open','awaiting_driver_selection']).gt('start_at', new Date().toISOString()).order('start_at').limit(100);
      if (error) throw error;
      const eligible = hasActiveContract ? [] : (rows || []).filter(r => {
        const requestedCategory = categoryMap.get(String(r.requested_category_id));
        if (!requestedCategory) return false;
        if (driverCategory) return Number(driverCategory.sort_order || 0) >= Number(requestedCategory.sort_order || 0);
        // Backward compatibility for older drivers whose car_type stores legacy text keys.
        const requestedRank = categoryRank(requestedCategory.name_ar);
        return legacyDriverRank > 0 && requestedRank < 99 && legacyDriverRank >= requestedRank;
      });
      const ids = eligible.map(r => r.id);
      const [{ data: ownAcceptances, error: ownError }, { data: counts, error: countErr }] = await Promise.all([
        db.from('limousine_acceptances').select('request_id,status').eq('driver_id', id).in('status', ['accepted','selected','contracted','funding_expired','withdrawn']),
        ids.length
          ? db.from('limousine_acceptances').select('request_id,status').in('request_id', ids).in('status', ['accepted','selected','contracted'])
          : Promise.resolve({ data: [], error: null })
      ]);
      if (ownError || countErr) throw ownError || countErr;
      const acceptedIds = (ownAcceptances || []).map(a => a.request_id);
      const acceptedRequestIds = [...new Set(acceptedIds)];
      const [{data: liveAcceptedRows,error: liveAcceptedError},{data: expiredAcceptedRows,error: expiredAcceptedError}] = acceptedRequestIds.length
        ? await Promise.all([
            db.from('limousine_requests').select('*').in('id', acceptedRequestIds).in('status', ['open','awaiting_driver_selection','driver_selected']).gt('start_at', new Date().toISOString()).order('start_at'),
            db.from('limousine_requests').select('*').in('id', acceptedRequestIds).eq('status','expired').order('start_at',{ascending:false})
          ])
        : [{data:[],error:null},{data:[],error:null}];
      if (liveAcceptedError || expiredAcceptedError) throw liveAcceptedError || expiredAcceptedError;
      const acceptedRows=[...(liveAcceptedRows||[]),...(expiredAcceptedRows||[])];
      const acceptedSet = new Set((ownAcceptances || []).filter(x=>['accepted','selected','contracted','funding_expired','withdrawn'].includes(x.status)).map(x => x.request_id));
      const countMap = new Map();
      (counts || []).forEach(x => countMap.set(x.request_id, (countMap.get(x.request_id) || 0) + 1));
      return res.status(200).json({
        success:true,
        profile:{ full_name:driver.full_name, balance:driver.balance },
        accepted_requests:(acceptedRows || []).map(r => ({ ...r, acceptance_status:(ownAcceptances || []).find(a => a.request_id === r.id)?.status || 'accepted' })),
        requests:eligible.filter(r => !acceptedSet.has(r.id)).map(r => ({ ...r, accepted_count:countMap.get(r.id) || 0 }))
      });
    }
    if (action === 'cancel_request') {
      if (session?.role !== 'passenger' || id !== b.passengerId) return fail(res, 403, 'غير مصرح');
      const { data, error } = await db.rpc('limousine_cancel_request', { p_request_id: b.requestId, p_passenger_id: id });
      if (error) throw error;
      return res.status(200).json({ success: true, result: data });
    }

    if (action === 'withdraw_acceptance') {
      if (session?.role !== 'driver' || id !== b.driverId) return fail(res, 403, 'غير مصرح');
      const { data, error } = await db.rpc('limousine_withdraw_acceptance', { p_request_id: b.requestId, p_driver_id: id });
      if (error) throw error;
      return res.status(200).json({ success: true, result: data });
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

    if (action === 'list_notifications' || action === 'mark_notification_read') {
      if (!['passenger','driver'].includes(session?.role)) return fail(res, 403, 'غير مصرح');
      if (action === 'list_notifications') {
        const [{ data, error }, { count, error: countError }, { data: unreadRows, error: unreadError }] = await Promise.all([
          db.from('limousine_notifications').select('id,event_code,title,body,payload,created_at,read_at').eq('recipient_id', id).eq('recipient_type', session.role).order('created_at', { ascending: false }).limit(30),
          db.from('limousine_notifications').select('id', { count: 'exact', head: true }).eq('recipient_id', id).eq('recipient_type', session.role).is('read_at', null),
          db.from('limousine_notifications').select('id,event_code,title,body,created_at').eq('recipient_id', id).eq('recipient_type', session.role).is('read_at', null).order('created_at', { ascending: false }).limit(1)
        ]);
        if (error || countError || unreadError) throw error || countError || unreadError;
        return res.status(200).json({ success: true, notifications: data || [], unread_count: count || 0, last_unread: unreadRows?.[0] || null });
      }
      const { error } = await db.from('limousine_notifications').update({ read_at: new Date().toISOString() })
        .eq('id', b.notificationId).eq('recipient_id', id).eq('recipient_type', session.role);
      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    if (action === 'get_contract_contact') {
      if (!['passenger','driver'].includes(session?.role)) return fail(res, 403, 'غير مصرح');
      const { data: contract, error: contractError } = await db.from('limousine_contracts').select('id,passenger_id,driver_id,status')
        .eq('id', b.contractId).maybeSingle();
      if (contractError || !contract) throw contractError || new Error('contract_not_found');
      const owns = session.role === 'passenger' ? contract.passenger_id === id : contract.driver_id === id;
      if (!owns) return fail(res, 403, 'لا تملك صلاحية الوصول إلى بيانات هذا العقد');
      if (!['booked','active','completion_requested','awaiting_settlement','settled','disputed'].includes(contract.status)) {
        return fail(res, 403, 'بيانات التواصل محجوبة حتى نجاح تأمين العمولة.');
      }
      if (session.role === 'passenger') {
        const { data, error } = await db.from('drivers').select('full_name,whatsapp_number,phone,car_model,car_type,car_color,car_plate_number,car_plate,plate_number')
          .eq('id', contract.driver_id).maybeSingle();
        if (error || !data) throw error || new Error('driver_not_found');
        return res.status(200).json({ success: true, contact: data });
      }
      const { data, error } = await db.from('customers').select('full_name,phone,phone2').eq('id', contract.passenger_id).maybeSingle();
      if (error || !data) throw error || new Error('passenger_not_found');
      return res.status(200).json({ success: true, contact: data });
    }

    if (action === 'list_contracts') {
      if (!['passenger','driver'].includes(session?.role)) return fail(res, 403, 'غير مصرح');
      let query = db.from('limousine_contracts').select('*').order('created_at', { ascending: false }).limit(100);
      query = session.role === 'passenger' ? query.eq('passenger_id', id) : query.eq('driver_id', id);
      const { data, error } = await query;
      if (error) throw error;
      const requestIds=[...new Set((data||[]).map(c=>c.request_id))];
      const {data: requestRows,error: requestError}=requestIds.length?await db.from('limousine_requests').select('id,city_id,pickup_area').in('id',requestIds):{data:[],error:null};
      if(requestError)throw requestError;
      const cityIds=[...new Set((requestRows||[]).map(r=>r.city_id))];
      const {data: cityRows,error: cityError}=cityIds.length?await db.from('cities').select('id,name_ar').in('id',cityIds):{data:[],error:null};
      if(cityError)throw cityError;
      const requestMap=new Map((requestRows||[]).map(r=>[r.id,r])),cityMap=new Map((cityRows||[]).map(c=>[c.id,c.name_ar]));
      const contractIds=(data||[]).map(c=>c.id);
      const {data: cancellationRows,error: cancellationError}=contractIds.length
        ? await db.from('limousine_cancellation_requests').select('*').in('contract_id',contractIds).order('created_at',{ascending:false})
        : {data:[],error:null};
      if(cancellationError)throw cancellationError;
      const latestCancellation=new Map();
      (cancellationRows||[]).forEach(x=>{if(!latestCancellation.has(x.contract_id))latestCancellation.set(x.contract_id,x);});
      const contracts=(data||[]).map(c=>({...c,city_name:cityMap.get(requestMap.get(c.request_id)?.city_id)||'',
        pickup_area:requestMap.get(c.request_id)?.pickup_area||'',cancellation_request:latestCancellation.get(c.id)||null}));
      return res.status(200).json({ success: true, contracts });
    }

    if(action==='list_driver_funding'){
      if(session?.role!=='driver'||id!==b.driverId)return fail(res,403,'غير مصرح');
      const [{data: funding,error},{data: driver,error: driverError}]=await Promise.all([
        db.from('limousine_contracts').select('id,request_id,status,funding_deadline,commission_due,start_at,duration_days').eq('driver_id',id).eq('status','awaiting_funding').not('funding_deadline','is',null).order('funding_deadline').limit(5),
        db.from('drivers').select('balance').eq('id',id).maybeSingle()
      ]);
      if(error||driverError)throw error||driverError;
      return res.status(200).json({success:true,funding:funding||[],balance:Number(driver?.balance||0)});
    }

    if(action==='get_contract_document'){
      if(!['passenger','driver','admin'].includes(session?.role))return fail(res,403,'غير مصرح');
      const {data:contract,error:contractError}=await db.from('limousine_contracts').select('*').eq('id',b.contractId).maybeSingle();
      if(contractError||!contract)throw contractError||new Error('contract_not_found');
      const owns=isAdmin||(session.role==='passenger'?contract.passenger_id===id:session.role==='driver'?contract.driver_id===id:false);
      if(!owns)return fail(res,403,'لا تملك صلاحية الوصول إلى هذا العقد');
      if(Number(contract.commission_held||0)<=0||!['booked','active','completion_requested','awaiting_settlement','settled','disputed'].includes(contract.status))
        return fail(res,403,'لا يمكن إصدار العقد قبل نجاح تأمين العمولة.');
      const [{data:request,error:requestError},{data:driver,error:driverError},{data:passenger,error:passengerError}]=await Promise.all([
        db.from('limousine_requests').select('city_id,pickup_area,requested_category_id,passenger_count,usage_purpose,notes').eq('id',contract.request_id).maybeSingle(),
        db.from('drivers').select('full_name,phone,whatsapp_number,car_model,car_type,car_color,car_plate_number,car_plate,plate_number').eq('id',contract.driver_id).maybeSingle(),
        db.from('customers').select('full_name,phone,phone2').eq('id',contract.passenger_id).maybeSingle()
      ]);
      if(requestError||driverError||passengerError||!request||!driver||!passenger)throw requestError||driverError||passengerError||new Error('contract_details_not_found');
      const [{data:city,error:cityError},{data:category,error:categoryError}]=await Promise.all([
        db.from('cities').select('name_ar').eq('id',request.city_id).maybeSingle(),
        db.from('vehicle_categories').select('name_ar').eq('id',request.requested_category_id).maybeSingle()
      ]);
      if(cityError||categoryError)throw cityError||categoryError;
      return res.status(200).json({success:true,contract:{
        ...contract,city_name:city?.name_ar||'',pickup_area:request.pickup_area,category_name:category?.name_ar||'',
        passenger_count:request.passenger_count,usage_purpose:request.usage_purpose,request_notes:request.notes,
        driver_name:driver.full_name,driver_phone:driver.phone,driver_whatsapp_number:driver.whatsapp_number,
        passenger_name:passenger.full_name,passenger_phone:passenger.phone,passenger_phone2:passenger.phone2,
        car_model:driver.car_model,car_type:driver.car_type,car_color:driver.car_color,
        car_plate_number:driver.car_plate_number||driver.car_plate||driver.plate_number
      }});
    }

    if (action === 'request_cancellation' || action === 'respond_cancellation') {
      if (!['passenger','driver'].includes(session?.role)) return fail(res, 403, 'غير مصرح');
      if (!b.contractId) return fail(res, 400, 'contractId is required');
      if (action === 'request_cancellation') {
        const reason = String(b.reason || '').trim();
        if (reason.length < 2 || reason.length > 1000) return fail(res, 400, 'سبب الإلغاء مطلوب (2 إلى 1000 حرف).');
        const { data, error } = await db.rpc('limousine_request_cancellation', {
          p_contract_id: b.contractId, p_user_id: id, p_user_role: session.role, p_reason: reason
        });
        if (error) throw error;
        return res.status(200).json({ success: true, result: data });
      }
      const { data, error } = await db.rpc('limousine_respond_cancellation', {
        p_contract_id: b.contractId, p_user_id: id, p_user_role: session.role, p_decision: b.decision
      });
      if (error) throw error;
      return res.status(200).json({ success: true, result: data });
    }

    if (action === 'list_messages' || action === 'send_message' || action === 'request_end' || action === 'confirm_end' || action === 'reject_end' || action === 'raise_dispute') {
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
      if (action === 'reject_end') {
        const { data, error } = await db.rpc('limousine_reject_end', { p_contract_id: b.contractId, p_user_id: id, p_user_role: session.role });
        if (error) throw error;
        return res.status(200).json({ success: true, result: data });
      }
      if (action === 'raise_dispute') {
        const { data, error } = await db.rpc('limousine_raise_dispute', { p_contract_id: b.contractId, p_user_id: id, p_user_role: session.role, p_reason: b.reason || null });
        if (error) throw error;
        return res.status(200).json({ success: true, result: data });
      }
    }

    if (action === 'admin_overview' || action === 'admin_update_pricing' || action === 'admin_resolve' || action === 'admin_resolve_cancellation') {
      if (!isAdmin) return fail(res, 403, 'صلاحيات الإدارة مطلوبة');
      if (action === 'admin_overview') {
        const [{ data: requests, error: re }, { data: contracts, error: ce }, { data: pricing, error: pe }, { data: ledger, error: le }, { data: cancellationRequests, error: xe }] = await Promise.all([
          db.from('limousine_requests').select('*').order('created_at', { ascending: false }).limit(200),
          db.from('limousine_contracts').select('*').order('created_at', { ascending: false }).limit(200),
          db.from('limousine_pricing').select('*,cities(name_ar),vehicle_categories(name_ar)').order('created_at', { ascending: false }),
          db.from('limousine_ledger').select('entry_type,amount,created_at').order('created_at', { ascending: false }).limit(500),
          db.from('limousine_cancellation_requests').select('*').order('created_at', { ascending: false }).limit(200)
        ]);
        if (re || ce || pe || le || xe) throw re || ce || pe || le || xe;
        return res.status(200).json({ success: true, requests, contracts, pricing, ledger, cancellationRequests });
      }
      if (action === 'admin_resolve_cancellation') {
        if (!b.contractId || !['no_penalty','penalty'].includes(b.resolution)) return fail(res, 400, 'بيانات اعتماد الإلغاء غير مكتملة');
        const penaltyDays = Number(b.penaltyDays || 0);
        if (!Number.isInteger(penaltyDays) || penaltyDays < 0) return fail(res, 400, 'عدد أيام الغرامة غير صالح');
        const { data, error } = await db.rpc('limousine_admin_resolve_cancellation', {
          p_contract_id: b.contractId, p_admin_id: id, p_resolution: b.resolution, p_penalty_days: penaltyDays
        });
        if (error) throw error;
        return res.status(200).json({ success: true, result: data });
      }
      if (action === 'admin_update_pricing') {
        const price = Number(b.dailyPrice), rate = Number(b.commissionRate);
        if (!b.cityId || !b.categoryId || !Number.isFinite(price) || price <= 0 || !Number.isFinite(rate) || rate <= 0 || rate > 100) return fail(res, 400, 'بيانات السعر أو العمولة غير صالحة');
        const { data, error } = await db.from('limousine_pricing').upsert({ city_id: b.cityId, vehicle_category_id: b.categoryId, daily_price: price, commission_rate: rate, min_days: 1, max_days: b.maxDays ? Number(b.maxDays) : null, is_active: b.isActive !== false, updated_at: new Date().toISOString() }, { onConflict: 'city_id,vehicle_category_id' }).select('*').single();
        if (error) throw error;
        return res.status(200).json({ success: true, pricing: data });
      }
      if (!b.contractId || !['no_penalty','penalty'].includes(b.resolution)) return fail(res, 400, 'بيانات التسوية غير مكتملة');
      const { data: settlementContract, error: contractReadError } = await db.from('limousine_contracts').select('status,actual_ended_at,scheduled_end_at').eq('id', b.contractId).maybeSingle();
      if (contractReadError || !settlementContract) throw contractReadError || new Error('contract_not_found');
      if (!['awaiting_settlement','disputed'].includes(settlementContract.status)) return fail(res, 400, 'لا يمكن اعتماد التسوية قبل تأكيد الطرف الآخر انتهاء الخدمة.');
      if (settlementContract.status === 'disputed' && !b.endAt && !settlementContract.actual_ended_at) return fail(res, 400, 'يجب تحديد وقت انتهاء الخدمة عند تسوية عقد متنازع عليه.');
      const settlementEnd = b.endAt || settlementContract.actual_ended_at || new Date().toISOString();
      const { data, error } = await db.rpc('limousine_settle_contract', { p_contract_id: b.contractId, p_end_at: settlementEnd, p_penalty_days: Number(b.penaltyDays) || 0, p_resolution: b.resolution });
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
    const clientErrors = ['start_must_be_future','outside_service_hours','invalid_start_time','invalid_duration','invalid_request_details','passenger_not_found','pricing_unavailable','duration_out_of_pricing_range','request_not_found','request_not_available','driver_not_eligible','vehicle_category_not_eligible','driver_has_overlapping_limo_contract','acceptance_limit_reached','request_not_found_or_forbidden','request_not_selectable','driver_has_not_accepted','live_contract_exists','contract_not_found','contract_not_settleable','commission_not_held','contract_not_owned','contract_not_disputable','contract_not_eligible_for_early_end','no_end_confirmation_pending',
      'cancellation_requires_mutual_approval','acceptance_not_withdrawable','withdrawal_not_allowed_after_booking',
      'cancellation_not_allowed_after_booking','contract_not_cancellable','invalid_cancellation_reason',
      'cancellation_already_pending','invalid_cancellation_decision','no_cancellation_confirmation_pending',
      'cancellation_not_awaiting_admin','invalid_resolution','invalid_penalty_days'];
    const friendly = { driver_not_found:'حساب السائق غير موجود.', driver_not_eligible:'حساب السائق غير مؤهل حالياً لاستقبال طلبات التأجير.', request_not_available:'هذا الطلب لم يعد متاحاً.', insufficient_balance:'رصيد السائق غير كافٍ لتأمين العمولة.', commission_not_held:'لم يتم تأمين العمولة بعد.',
      cancellation_requires_mutual_approval:'تم تأمين العمولة؛ يجب تقديم طلب إلغاء بموافقة الطرفين ثم اعتماد الإدارة.',
      acceptance_not_withdrawable:'لا يوجد قبول مبدئي قابل للسحب لهذا الطلب.',
      withdrawal_not_allowed_after_booking:'لا يمكن سحب القبول بعد حجز العمولة. استخدم طلب إلغاء العقد.',
      contract_not_cancellable:'حالة العقد لا تسمح بطلب الإلغاء.',
      invalid_cancellation_reason:'يرجى إدخال سبب صحيح للإلغاء.',
      cancellation_already_pending:'يوجد طلب إلغاء مفتوح لهذا العقد بالفعل.',
      invalid_cancellation_decision:'القرار غير صالح.',
      no_cancellation_confirmation_pending:'لا يوجد طلب إلغاء ينتظر موافقتك.',
      cancellation_not_awaiting_admin:'طلب الإلغاء لم يصل إلى مرحلة اعتماد الإدارة.',
      contract_not_owned:'لا تملك صلاحية هذا العقد.' };
    return fail(res, clientErrors.includes(message) ? 400 : 500, friendly[message] || (clientErrors.includes(message) ? 'تعذر تنفيذ العملية بسبب حالة الطلب الحالية.' : 'حدث خطأ أثناء معالجة الطلب. يرجى المحاولة لاحقاً.'));
  }
}
