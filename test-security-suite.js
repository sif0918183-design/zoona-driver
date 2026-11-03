import assert from 'assert';

// 1. ضبط متغيرات بيئة الاختبار التجريبية والآمنة قبل أي استيراد للموديولات
process.env.SESSION_TOKEN_SECRET = 'test_secret_for_suite_abcdef1234567890';
process.env.CRON_SECRET = 'test_cron_secret_secure_999888';
process.env.SUPABASE_ANON_KEY = 'test_anon_public_key_only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_secret_service_role_key_danger';
process.env.SUPABASE_URL = 'https://fake-test-supabase.co';

// 2. استخدام Dynamic Imports لضمان قراءة متغيرات البيئة قبل تهيئة الوحدات
const { generateToken, verifyToken } = await import('./api/_token-utils.js');
const { default: getServiceKeyHandler } = await import('./api/get-service-key.js');
const { default: supabaseServiceKeyHandler } = await import('./api/supabase-service-key.js');
const { default: ridesHandler, setSupabaseClient: setRidesSupabaseClient, supabase: originalRidesSupabase } = await import('./api/rides.js');
const { default: travelHandler, setSupabaseClient: setTravelSupabaseClient, supabase: originalTravelSupabase } = await import('./api/travel-platform.js');

console.log('=== STARTING SECURITY & ROLE AUTHORIZATION TEST SUITE ===');

// دالة مساعدة لإنشاء كائنات Mock للطلب والاستجابة
function createMockReqRes({ method = 'POST', body = {}, token = null, headers = {} }) {
    let statusCode = 200;
    let responseJson = null;
    let headersSent = {};

    const reqHeaders = {
        'content-type': 'application/json',
        ...headers
    };

    if (token) {
        reqHeaders['authorization'] = `Bearer ${token}`;
    }

    const req = {
        method,
        headers: reqHeaders,
        body
    };

    const res = {
        setHeader: (k, v) => { headersSent[k.toLowerCase()] = v; },
        status: (c) => {
            statusCode = c;
            return res;
        },
        json: (data) => {
            responseJson = data;
            return res;
        },
        end: () => res
    };

    return {
        req,
        res,
        getStatus: () => statusCode,
        getJson: () => responseJson,
        getHeaders: () => headersSent
    };
}

// ====================================================================
// 1. اختبارات استدعاء معالجات API الحقيقية (Real API Handler Invocations)
// ====================================================================

console.log('\n--- 1. REAL API HANDLER INVOCATIONS ---');

// 1.1 اختبار get-service-key الحقيقي: التأكد من عدم كشف مفتاح الخدمة الإداري إطلاقاً
{
    const passengerToken = generateToken({ id: 'p1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({ method: 'GET', token: passengerToken });
    getServiceKeyHandler(req, res);
    assert.strictEqual(getStatus(), 200);
    const json = getJson();
    assert.strictEqual(json.serviceRoleKey, process.env.SUPABASE_ANON_KEY);
    assert.strictEqual(json.data.serviceRoleKey, process.env.SUPABASE_ANON_KEY);
    assert.notStrictEqual(json.serviceRoleKey, process.env.SUPABASE_SERVICE_ROLE_KEY);
    console.log('✅ Test 1.1 Passed: Real api/get-service-key.js returns only ANON_KEY, never SERVICE_ROLE_KEY');
}

// 1.2 اختبار supabase-service-key الحقيقي: التأكد من عدم كشف مفتاح الخدمة الإداري
{
    const driverToken = generateToken({ id: 'd1', role: 'driver' });
    const { req, res, getStatus, getJson } = createMockReqRes({ method: 'GET', token: driverToken });
    supabaseServiceKeyHandler(req, res);
    assert.strictEqual(getStatus(), 200);
    const json = getJson();
    assert.strictEqual(json.serviceRoleKey, process.env.SUPABASE_ANON_KEY);
    assert.strictEqual(json.data.serviceRoleKey, process.env.SUPABASE_ANON_KEY);
    assert.notStrictEqual(json.serviceRoleKey, process.env.SUPABASE_SERVICE_ROLE_KEY);
    console.log('✅ Test 1.2 Passed: Real api/supabase-service-key.js returns only ANON_KEY, never SERVICE_ROLE_KEY');
}

// 1.3 رفض الطلب إلى get-service-key بدون توكن صالح (401)
{
    const { req, res, getStatus, getJson } = createMockReqRes({ method: 'GET', token: null });
    getServiceKeyHandler(req, res);
    assert.strictEqual(getStatus(), 401);
    assert.strictEqual(getJson().success, false);
    console.log('✅ Test 1.3 Passed: Real api/get-service-key.js rejects unauthenticated request with 401');
}

// 1.4 اختبار ridesHandler الحقيقي: رفض الطلب بدون توكن برمز 401
{
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: { action: 'create' },
        token: null
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 401);
    assert.strictEqual(getJson().success, false);
    console.log('✅ Test 1.4 Passed: Real api/rides.js rejects missing token with 401');
}

// 1.5 اختبار ridesHandler الحقيقي (create): منع السائق من إنشاء رحلة باسم راكب (403)
{
    const driverToken = generateToken({ id: 'driver-999', role: 'driver' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'create',
            passengerId: 'passenger-111',
            pickupLat: 15.5,
            pickupLng: 32.5,
            amount: 5000
        },
        token: driverToken
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير مصرح: لا يمكنك إنشاء رحلة باسم مستخدم آخر/);
    console.log('✅ Test 1.5 Passed: Real api/rides.js blocks driver from creating ride with 403');
}

// 1.6 اختبار ridesHandler الحقيقي (create): منع راكب من إنشاء رحلة باسم راكب آخر (403)
{
    const passengerToken = generateToken({ id: 'attacker-passenger', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'create',
            passengerId: 'victim-passenger',
            pickupLat: 15.5,
            pickupLng: 32.5,
            amount: 5000
        },
        token: passengerToken
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير مصرح: لا يمكنك إنشاء رحلة باسم مستخدم آخر/);
    console.log('✅ Test 1.6 Passed: Real api/rides.js blocks cross-passenger creation with 403');
}

// 1.7 اختبار ridesHandler الحقيقي (accept): منع الراكب من قبول رحلة (403)
{
    const passengerToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'accept',
            rideId: 'ride-1',
            driverId: 'passenger-1'
        },
        token: passengerToken
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير مصرح: لا يمكنك قبول رحلة باسم سائق آخر/);
    console.log('✅ Test 1.7 Passed: Real api/rides.js blocks passenger from accepting ride with 403');
}

// 1.8 اختبار ridesHandler الحقيقي (accept): منع سائق من قبول رحلة باسم سائق آخر (403)
{
    const driverToken = generateToken({ id: 'driver-1', role: 'driver' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'accept',
            rideId: 'ride-1',
            driverId: 'driver-2'
        },
        token: driverToken
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير مصرح: لا يمكنك قبول رحلة باسم سائق آخر/);
    console.log('✅ Test 1.8 Passed: Real api/rides.js blocks cross-driver acceptance with 403');
}

// 1.9 اختبار ridesHandler الحقيقي (update_status): منع الراكب من تحديث حالة الرحلة (403)
{
    const passengerToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'update_status',
            rideId: 'ride-1',
            status: 'ongoing'
        },
        token: passengerToken
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير مصرح: السائقون فقط يمكنهم تحديث حالة الرحلة/);
    console.log('✅ Test 1.9 Passed: Real api/rides.js blocks passenger from updating ride status with 403');
}

// 1.10 اختبار ridesHandler الحقيقي (complete): منع الراكب من إكمال الرحلة (403)
{
    const passengerToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'complete',
            rideId: 'ride-1'
        },
        token: passengerToken
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير مصرح: السائقون فقط يمكنهم إكمال الرحلة/);
    console.log('✅ Test 1.10 Passed: Real api/rides.js blocks passenger from completing ride with 403');
}

// 1.11 اختبار ridesHandler الحقيقي (cancel_by_driver): منع الراكب من إلغاء رحلة سائق (403)
{
    const passengerToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'cancel_by_driver',
            rideId: 'ride-1',
            driverId: 'passenger-1'
        },
        token: passengerToken
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير مصرح: لا يمكنك إلغاء رحلة باسم سائق آخر/);
    console.log('✅ Test 1.11 Passed: Real api/rides.js blocks non-driver from driver cancellation with 403');
}

// 1.12 اختبار ridesHandler الحقيقي (cancel_by_passenger): منع السائق من استدعاء إلغاء الراكب (403)
{
    const driverToken = generateToken({ id: 'driver-1', role: 'driver' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'cancel_by_passenger',
            rideId: 'ride-1'
        },
        token: driverToken
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير مصرح: يجب أن تكون راكباً لإلغاء هذه الرحلة/);
    console.log('✅ Test 1.12 Passed: Real api/rides.js blocks driver from calling cancel_by_passenger with 403');
}

// 1.13 اختبار ridesHandler الحقيقي (ban_driver): منع الراكب والسائق من استدعاء ban_driver وحصره في المشرف (403)
{
    const passengerToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req: pReq, res: pRes, getStatus: pStatus } = createMockReqRes({
        method: 'POST',
        body: { action: 'ban_driver', driverId: 'driver-1' },
        token: passengerToken
    });
    await ridesHandler(pReq, pRes);
    assert.strictEqual(pStatus(), 403);

    const driverToken = generateToken({ id: 'driver-1', role: 'driver' });
    const { req: dReq, res: dRes, getStatus: dStatus } = createMockReqRes({
        method: 'POST',
        body: { action: 'ban_driver', driverId: 'driver-2' },
        token: driverToken
    });
    await ridesHandler(dReq, dRes);
    assert.strictEqual(dStatus(), 403);
    console.log('✅ Test 1.13 Passed: Real api/rides.js blocks passenger and driver from ban_driver with 403');
}

// 1.14 اختبار ridesHandler الحقيقي (submit_complaint): منع تزوير معرف الشاكي أو دوره (403)
{
    const passengerToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'submit_complaint',
            userId: 'victim-user',
            userType: 'passenger',
            userName: 'Test User',
            phone: '0912345678',
            message: 'Injected message'
        },
        token: passengerToken
    });
    await ridesHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير مصرح: لا يمكنك إرسال شكوى باسم مستخدم آخر/);
    console.log('✅ Test 1.14 Passed: Real api/rides.js blocks complaint forgery with 403');
}

// 1.15 اختبار travelHandler الحقيقي (create_ride_request): منع السائق من إنشاء طلب سفر للركاب (403)
{
    const driverToken = generateToken({ id: 'driver-1', role: 'driver' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'create_ride_request',
            passengerId: 'driver-1',
            fromCity: 'الخرطوم',
            toCity: 'مدني',
            estimatedPrice: 15000,
            departureTime: new Date(Date.now() + 86400000).toISOString()
        },
        token: driverToken
    });
    await travelHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    console.log('✅ Test 1.15 Passed: Real api/travel-platform.js blocks driver from creating travel ride with 403');
}

// 1.16 اختبار travelHandler الحقيقي (driver_accept): منع الراكب من قبول رحلة سفر كسائق (403)
{
    const passengerToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'driver_accept',
            rideId: 'req-1',
            driverId: 'passenger-1'
        },
        token: passengerToken
    });
    await travelHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    console.log('✅ Test 1.16 Passed: Real api/travel-platform.js blocks passenger from driver acceptance with 403');
}

// 1.17 اختبار travelHandler الحقيقي (complete_trip): منع الراكب من إكمال رحلة السفر (403)
{
    const passengerToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'complete_trip',
            tripId: 'trip-1'
        },
        token: passengerToken
    });
    await travelHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    console.log('✅ Test 1.17 Passed: Real api/travel-platform.js blocks passenger from completing travel trip with 403');
}

// 1.18 اختبار travelHandler الحقيقي (get_trip_passenger_details): منع الراكب من كشف بيانات ركاب آخرين (403)
{
    const passengerToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'get_trip_passenger_details',
            tripId: 'trip-1'
        },
        token: passengerToken
    });
    await travelHandler(req, res);
    assert.strictEqual(getStatus(), 403);
    assert.strictEqual(getJson().success, false);
    console.log('✅ Test 1.18 Passed: Real api/travel-platform.js blocks passenger from viewing trip passenger details with 403');
}

// 1.19 اختبار travelHandler الحقيقي (cron_process_10h): رفض هيدر x-vercel-cron المزيف بدون السر (401)
{
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: { action: 'cron_process_10h' },
        headers: { 'x-vercel-cron': '1' },
        token: null
    });
    await travelHandler(req, res);
    assert.strictEqual(getStatus(), 401);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /رمز الجدولة مفقود أو غير صحيح/);
    console.log('✅ Test 1.19 Passed: Real api/travel-platform.js strictly rejects fake x-vercel-cron header with 401');
}

// 1.20 اختبار travelHandler الحقيقي (cron_process_10h): رفض السر الخاطئ برمز 401
{
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: { action: 'cron_process_10h' },
        token: 'wrong_secret_attempt'
    });
    await travelHandler(req, res);
    assert.strictEqual(getStatus(), 401);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /رمز الجدولة مفقود أو غير صحيح/);
    console.log('✅ Test 1.20 Passed: Real api/travel-platform.js rejects invalid CRON_SECRET with 401');
}

// 1.21 اختبار travelHandler الحقيقي (cron_process_10h): قبول السر الصحيح الموثق
{
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: { action: 'cron_process_10h' },
        headers: { 'authorization': `Bearer ${process.env.CRON_SECRET}` }
    });
    await travelHandler(req, res);
    assert.strictEqual(getStatus(), 200);
    assert.strictEqual(getJson().success, true);
    console.log('✅ Test 1.21 Passed: Real api/travel-platform.js accepts valid CRON_SECRET bearer header');
}

// 1.22 اختبار travelHandler الحقيقي (process_10h_commission): رفض الرحلة غير الموجودة برمز 404 قبل أي معالجة
{
    const userToken = generateToken({ id: 'passenger-1', role: 'passenger' });
    const { req, res, getStatus, getJson } = createMockReqRes({
        method: 'POST',
        body: {
            action: 'process_10h_commission',
            rideId: 'non-existent-ride-id'
        },
        token: userToken
    });
    await travelHandler(req, res);
    assert.strictEqual(getStatus(), 404);
    assert.strictEqual(getJson().success, false);
    assert.match(getJson().error, /غير موجود/);
    console.log('✅ Test 1.22 Passed: Real api/travel-platform.js rejects non-existent rideId with 404 before evaluation');
}

// 1.23 اختبار حقيقي لرحلتين موجودتين مع تضارب tripId و rideId، واختبار ride_request_id المفقود
{
    // تهيئة عميل Mock لـ travelHandler يحاكي وجود رحلتين مختلفتين
    let evalRpcCalled = 0;
    const testTravelDB = {
        from: (table) => ({
            select: () => ({
                eq: (col, val) => ({
                    maybeSingle: async () => {
                        if (table === 'travel_trips' && val === 'trip-1') {
                            return { data: { id: 'trip-1', passenger_id: 'p1', driver_id: 'd1', ride_request_id: 'req-1' } };
                        }
                        if (table === 'travel_trips' && val === 'trip-corrupted-no-req') {
                            return { data: { id: 'trip-corrupted-no-req', passenger_id: 'p1', driver_id: 'd1', ride_request_id: null } };
                        }
                        if (table === 'ride_requests' && val === 'req-1') {
                            return { data: { id: 'req-1', customer_id: 'p1', driver_id: 'd1' } };
                        }
                        if (table === 'ride_requests' && val === 'req-2') {
                            return { data: { id: 'req-2', customer_id: 'p2', driver_id: 'd2' } };
                        }
                        return { data: null };
                    }
                })
            })
        }),
        rpc: async () => { evalRpcCalled++; return { data: null, error: null }; }
    };

    setTravelSupabaseClient(testTravelDB);

    try {
        const p1Token = generateToken({ id: 'p1', role: 'passenger' });

        // حالة 1: المستخدم صاحب trip-1 يحاول تمرير rideId لطلب رحلة ثانية (req-2)
        const { req: r1, res: res1, getStatus: s1, getJson: j1 } = createMockReqRes({
            method: 'POST',
            body: {
                action: 'process_10h_commission',
                tripId: 'trip-1',
                rideId: 'req-2' // لا يطابق req-1
            },
            token: p1Token
        });
        await travelHandler(r1, res1);
        assert.strictEqual(s1(), 400);
        assert.strictEqual(j1().success, false);
        assert.match(j1().error, /معرف الرحلة rideId لا يطابق طلب السفر المرتبط بـ tripId/);
        assert.strictEqual(evalRpcCalled, 0, 'يجب عدم استدعاء أي RPC عند تضارب المعرفات');

        // حالة 2: وجود tripRecord ولكن ride_request_id فارغ أو null
        const { req: r2, res: res2, getStatus: s2, getJson: j2 } = createMockReqRes({
            method: 'POST',
            body: {
                action: 'process_10h_commission',
                tripId: 'trip-corrupted-no-req'
            },
            token: p1Token
        });
        await travelHandler(r2, res2);
        assert.strictEqual(s2(), 400);
        assert.strictEqual(j2().success, false);
        assert.match(j2().error, /ride_request_id مفقود/);
        assert.strictEqual(evalRpcCalled, 0, 'يجب عدم استدعاء أي RPC عند غياب ride_request_id');

        console.log('✅ Test 1.23 Passed: Real travelHandler rejects cross-ride mismatch and null ride_request_id with 400 without RPC');
    } finally {
        setTravelSupabaseClient(originalTravelSupabase);
    }
}

// 1.24 مراقبة وتأكيد عدم تنفيذ أي عمليات قاعدة بيانات (RPC/INSERT/UPDATE) عند فشل الصلاحيات
{
    let rpcCallCount = 0;
    let insertCallCount = 0;
    let updateCallCount = 0;

    const monitoredClient = {
        rpc: async () => { rpcCallCount++; return { data: null, error: null }; },
        from: (table) => ({
            insert: async () => { insertCallCount++; return { data: null, error: null }; },
            update: () => ({
                eq: async () => { updateCallCount++; return { data: null, error: null }; }
            }),
            select: () => ({
                eq: () => ({
                    single: async () => ({ data: { id: 'r1', passenger_id: 'victim', driver_id: 'd1' } }),
                    maybeSingle: async () => ({ data: { id: 'r1', passenger_id: 'victim', driver_id: 'd1' } })
                })
            })
        })
    };

    setRidesSupabaseClient(monitoredClient);

    try {
        // تنفيذ محاولة غير مصرحة (راكب يحاول قبول رحلة كسائق)
        const unauthorizedToken = generateToken({ id: 'hacker', role: 'passenger' });
        const { req, res, getStatus } = createMockReqRes({
            method: 'POST',
            body: { action: 'accept', rideId: 'r1', driverId: 'd1' },
            token: unauthorizedToken
        });
        await ridesHandler(req, res);
        assert.strictEqual(getStatus(), 403);

        // التأكيد الرياضي الصارم بأن المعالج الفعلي لم يقم بأي عملية RPC أو كتابة
        assert.strictEqual(rpcCallCount, 0, 'RPC must not be called on auth failure');
        assert.strictEqual(insertCallCount, 0, 'INSERT must not be called on auth failure');
        assert.strictEqual(updateCallCount, 0, 'UPDATE must not be called on auth failure');
        console.log('✅ Test 1.24 Passed: Verified that 0 RPCs, 0 INSERTs, and 0 UPDATEs occur on actual handlers when authorization fails');
    } finally {
        setRidesSupabaseClient(originalRidesSupabase);
    }
}


// ====================================================================
// 2. اختبارات المصادقة والتوقيع التشفيري الشاملة في _token-utils.js
// ====================================================================

console.log('\n--- 2. CRYPTOGRAPHIC TOKEN VERIFICATION TESTS ---');

// 2.1 توكن صالح
{
    const token = generateToken({ id: 'user-valid-1', role: 'passenger' });
    const verified = verifyToken(token);
    assert.strictEqual(verified.id, 'user-valid-1');
    assert.strictEqual(verified.role, 'passenger');
    console.log('✅ Test 2.1 Passed: Valid token generated and verified cleanly');
}

// 2.2 توكن معدل بعد إصداره
{
    const token = generateToken({ id: 'user-valid-1', role: 'passenger' });
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ id: 'hacker-id', role: 'passenger', exp: Date.now() + 100000 })).toString('base64url');
    const tamperedToken = `${tamperedPayload}.${parts[1]}`;
    assert.throws(() => verifyToken(tamperedToken), /تم التلاعب به أو غير صالح/);
    console.log('✅ Test 2.2 Passed: Tampered token signature fails timingSafeEqual check');
}

// 2.3 توكن منتهي الصلاحية
{
    const expiredToken = generateToken({ id: 'user-valid-1', role: 'passenger' }, -1000);
    assert.throws(() => verifyToken(expiredToken), /انتهت صلاحية رمز الجلسة/);
    console.log('✅ Test 2.3 Passed: Expired token cleanly rejected');
}

// 2.4 توكن دون توقيع (Base64 القديم)
{
    const rawB64 = Buffer.from(JSON.stringify({ id: 'user-valid-1', role: 'passenger' })).toString('base64');
    assert.throws(() => verifyToken(rawB64), /غير موقع تشفيرياً/);
    console.log('✅ Test 2.4 Passed: Unsigned legacy base64 token rejected');
}

// 2.5 توكن بدور غير مسموح (role forgery)
{
    assert.throws(() => generateToken({ id: 'user-1', role: 'super_hacker' }), /دور المستخدم \(role\) غير صالح/);
    console.log('✅ Test 2.5 Passed: Disallowed role rejected at generation');
}

// 2.6 توكن دون id أو exp
{
    assert.throws(() => generateToken({ role: 'passenger' }), /معرف المستخدم \(id\) مطلوب/);
    console.log('✅ Test 2.6 Passed: Missing id cleanly rejected');
}

// 2.7 غياب متغير البيئة SESSION_TOKEN_SECRET
{
    const savedSecret = process.env.SESSION_TOKEN_SECRET;
    delete process.env.SESSION_TOKEN_SECRET;
    assert.throws(() => generateToken({ id: 'u1', role: 'passenger' }), /متغير البيئة SESSION_TOKEN_SECRET غير مهيأ/);
    assert.throws(() => verifyToken('any.token'), /متغير البيئة SESSION_TOKEN_SECRET غير مهيأ/);
    process.env.SESSION_TOKEN_SECRET = savedSecret;
    console.log('✅ Test 2.7 Passed: Missing environment variable strictly throws error without fallback');
}

// 2.8 محاولة استخدام توقيع بطول مختلف لمنع خطأ timingSafeEqual
{
    const token = generateToken({ id: 'user-1', role: 'passenger' });
    const parts = token.split('.');
    const shortSigToken = `${parts[0]}.short`;
    assert.throws(() => verifyToken(shortSigToken), /تم التلاعب به أو غير صالح/);
    console.log('✅ Test 2.8 Passed: Different length signature safely rejected');
}


// ====================================================================
// 3. المحاكاة المنطقية المحاسبية الدقيقة لقواعد cancel_ride
// ====================================================================

console.log('\n--- 3. ACCOUNTING LOGIC & LEDGER AUDIT SIMULATION TESTS ---');
console.log('ℹ️ إيضاح صريح: الاختبارات التالية هي محاكاة منطقية وحسابية في JavaScript لقواعد دالة SQL');
console.log('   نظراً لعدم توفر بيئة PostgreSQL محلية في بيئة الـ Sandbox (تم التحقق عبر which psql / which postgres).');
console.log('   والتزاماً بالشرط الحاسم بعدم تنفيذ أي SQL أو اختبارات على قاعدة البيانات الحية.');

function simulateCancelRideLedgerAudit({
    rideCommHeld,
    ledgerTxs,
    driverBalance,
    hasSettledTx = false,
    corruptedTx = false
}) {
    if (corruptedTx) {
        throw new Error('تم اكتشاف معاملات مالية ذات إشارات غير صحيحة');
    }
    if (hasSettledTx) {
        throw new Error('الرحلة مسواة مالياً ولا يمكن استرداد عمولتها');
    }

    const heldTxs = ledgerTxs.filter(t => t.type === 'commission_held' && t.amount < 0);
    const totalHeld = heldTxs.reduce((sum, t) => sum + (-t.amount), 0);

    if (rideCommHeld > 0 || totalHeld > 0) {
        if (rideCommHeld !== totalHeld) {
            throw new Error(`عدم تطابق العمولة المسجلة بالرحلة مع الحجز الفعلي: الرحلة ${rideCommHeld}, الدفتر ${totalHeld}`);
        }
    }

    const refundedTxs = ledgerTxs.filter(t => t.type === 'cancellation_refund' && t.amount > 0);
    const totalRefunded = refundedTxs.reduce((sum, t) => sum + t.amount, 0);

    if (totalRefunded > totalHeld) {
        throw new Error('الاستردادات السابقة تتجاوز قيمة الحجز الفعلي');
    }

    const netUnrefunded = totalHeld - totalRefunded;
    let refundedNow = 0;

    if (totalHeld > 0 && netUnrefunded > 0) {
        refundedNow = netUnrefunded;
        driverBalance += refundedNow;
        ledgerTxs.push({ type: 'cancellation_refund', amount: refundedNow });
    }

    return {
        refundedNow,
        newBalance: driverBalance,
        ledgerTxs
    };
}

// 3.1 استرداد 100 من عمولة محجوزة 100
{
    const ledger = [{ type: 'commission_held', amount: -100 }];
    const res = simulateCancelRideLedgerAudit({
        rideCommHeld: 100,
        ledgerTxs: ledger,
        driverBalance: 500
    });
    assert.strictEqual(res.refundedNow, 100);
    assert.strictEqual(res.newBalance, 600);
    console.log('✅ Test 3.1 Passed: Full hold of 100 refunded to driver, balance 500 -> 600');
}

// 3.2 استرداد 60 عند وجود استرداد سابق 40 من أصل 100
{
    const ledger = [
        { type: 'commission_held', amount: -100 },
        { type: 'cancellation_refund', amount: 40 }
    ];
    const res = simulateCancelRideLedgerAudit({
        rideCommHeld: 100,
        ledgerTxs: ledger,
        driverBalance: 500
    });
    assert.strictEqual(res.refundedNow, 60);
    assert.strictEqual(res.newBalance, 560);
    console.log('✅ Test 3.2 Passed: Partial prior refund (40) results in exactly remaining 60 refunded');
}

// 3.3 منع الاسترداد المكرر (Idempotency)
{
    const ledger = [{ type: 'commission_held', amount: -100 }];
    const res1 = simulateCancelRideLedgerAudit({
        rideCommHeld: 100,
        ledgerTxs: ledger,
        driverBalance: 500
    });
    assert.strictEqual(res1.refundedNow, 100);
    assert.strictEqual(res1.newBalance, 600);

    // استدعاء مكرر ثانٍ
    const res2 = simulateCancelRideLedgerAudit({
        rideCommHeld: 100,
        ledgerTxs: ledger,
        driverBalance: 600
    });
    assert.strictEqual(res2.refundedNow, 0);
    assert.strictEqual(res2.newBalance, 600);
    console.log('✅ Test 3.3 Passed: Repeated call returns 0 refund, balance remains 600 without double refund');
}

// 3.4 كشف ورفض عدم تطابق سجل الحجز مع قيمة العمولة المسجلة بالرحلة
{
    const ledger = [{ type: 'commission_held', amount: -100 }];
    assert.throws(() => simulateCancelRideLedgerAudit({
        rideCommHeld: 150, // غير متطابق
        ledgerTxs: ledger,
        driverBalance: 500
    }), /عدم تطابق العمولة المسجلة بالرحلة مع الحجز الفعلي/);
    console.log('✅ Test 3.4 Passed: Mismatched commission_held vs ledger strictly rejected');
}

// 3.5 منع الاسترداد بعد قيود التسوية النهائية (commission_deduction / cancellation_penalty)
{
    const ledger = [
        { type: 'commission_held', amount: -100 },
        { type: 'commission_deduction', amount: -100 }
    ];
    assert.throws(() => simulateCancelRideLedgerAudit({
        rideCommHeld: 100,
        ledgerTxs: ledger,
        driverBalance: 500,
        hasSettledTx: true
    }), /الرحلة مسواة مالياً ولا يمكن استرداد عمولتها/);
    console.log('✅ Test 3.5 Passed: Settled ride with deduction/penalty strictly prevents refund');
}

console.log('\n=== ALL TESTS IN SUITE COMPLETED SUCCESSFULLY ===');
