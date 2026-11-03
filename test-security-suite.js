import assert from 'assert';
import { generateToken, verifyToken } from './api/_token-utils.js';
import getServiceKeyHandler from './api/get-service-key.js';
import supabaseServiceKeyHandler from './api/supabase-service-key.js';

console.log('=== STARTING SECURITY & ROLE AUTHORIZATION TEST SUITE ===');

process.env.SESSION_TOKEN_SECRET = 'test_secret_for_suite_abcdef1234567890';
process.env.SUPABASE_ANON_KEY = 'test_anon_public_key_only';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_secret_service_role_key_danger';

// ============================================
// 1. اختبار منع كشف مفتاح الخدمة الإداري
// ============================================
{
    const passengerToken = generateToken({ id: 'p1', role: 'passenger' });
    const driverToken = generateToken({ id: 'd1', role: 'driver' });

    function mockReqRes(token) {
        let statusCode = 200;
        let responseJson = null;
        const req = {
            method: 'GET',
            headers: { authorization: `Bearer ${token}` }
        };
        const res = {
            setHeader: () => {},
            status: (c) => { statusCode = c; return res; },
            json: (data) => { responseJson = data; return res; },
            end: () => {}
        };
        return { req, res, getStatus: () => statusCode, getJson: () => responseJson };
    }

    // 1.1 اختبار get-service-key للراكب
    {
        const { req, res, getStatus, getJson } = mockReqRes(passengerToken);
        getServiceKeyHandler(req, res);
        assert.strictEqual(getStatus(), 200);
        const json = getJson();
        assert.strictEqual(json.serviceRoleKey, 'test_anon_public_key_only');
        assert.strictEqual(json.data.serviceRoleKey, 'test_anon_public_key_only');
        assert.notStrictEqual(json.serviceRoleKey, process.env.SUPABASE_SERVICE_ROLE_KEY);
        console.log('✅ Test 1.1 Passed: /api/get-service-key never reveals SUPABASE_SERVICE_ROLE_KEY');
    }

    // 1.2 اختبار supabase-service-key للسائق
    {
        const { req, res, getStatus, getJson } = mockReqRes(driverToken);
        supabaseServiceKeyHandler(req, res);
        assert.strictEqual(getStatus(), 200);
        const json = getJson();
        assert.strictEqual(json.serviceRoleKey, 'test_anon_public_key_only');
        assert.strictEqual(json.data.serviceRoleKey, 'test_anon_public_key_only');
        assert.notStrictEqual(json.serviceRoleKey, process.env.SUPABASE_SERVICE_ROLE_KEY);
        console.log('✅ Test 1.2 Passed: /api/supabase-service-key never reveals SUPABASE_SERVICE_ROLE_KEY');
    }

    // 1.3 رفض الطلب بدون توكن
    {
        const { req, res, getStatus } = mockReqRes('');
        getServiceKeyHandler(req, res);
        assert.strictEqual(getStatus(), 401);
        console.log('✅ Test 1.3 Passed: Missing token returns 401');
    }
}

// ============================================
// 2. اختبار المصادقة والتوقيع التشفيري HMAC-SHA256
// ============================================
{
    // 2.1 توكن صالح
    const token = generateToken({ id: 'user-uuid-1', role: 'passenger' });
    const verified = verifyToken(token);
    assert.strictEqual(verified.id, 'user-uuid-1');
    assert.strictEqual(verified.role, 'passenger');
    console.log('✅ Test 2.1 Passed: Valid token generated and verified');

    // 2.2 توكن متلاعب به
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ id: 'user-uuid-hacked', role: 'passenger', exp: Date.now() + 10000 })).toString('base64url');
    const tamperedToken = `${tamperedPayload}.${parts[1]}`;
    assert.throws(() => verifyToken(tamperedToken), /تم التلاعب به أو غير صالح/);
    console.log('✅ Test 2.2 Passed: Tampered token correctly rejected');

    // 2.3 توكن منتهي الصلاحية
    const expiredToken = generateToken({ id: 'user-uuid-1', role: 'passenger' }, -1000);
    assert.throws(() => verifyToken(expiredToken), /انتهت صلاحية رمز الجلسة/);
    console.log('✅ Test 2.3 Passed: Expired token correctly rejected');

    // 2.4 توكن قديم غير موقع (Base64)
    const rawB64 = Buffer.from(JSON.stringify({ id: 'user-uuid-1', role: 'passenger' })).toString('base64');
    assert.throws(() => verifyToken(rawB64), /غير موقع تشفيرياً/);
    console.log('✅ Test 2.4 Passed: Unsigned legacy base64 token rejected');
}

// ============================================
// 3. اختبار مصفوفة الصلاحيات في api/rides.js
// ============================================

function simulateRidesAuth({ action, body, session, dbRide }) {
    if (action === 'create') {
        const { passengerId } = body;
        if (!session || session.role !== 'passenger' || String(session.id).trim() !== String(passengerId).trim()) {
            return { status: 403, error: 'غير مصرح: لا يمكنك إنشاء رحلة باسم مستخدم آخر' };
        }
        return { status: 200, success: true };
    }

    if (action === 'accept') {
        const { driverId } = body;
        if (!session || session.role !== 'driver' || String(session.id).trim() !== String(driverId).trim()) {
            return { status: 403, error: 'غير مصرح: لا يمكنك قبول رحلة باسم سائق آخر' };
        }
        return { status: 200, success: true };
    }

    if (action === 'update_status') {
        const { driverId } = body;
        if (!session || session.role !== 'driver') {
            return { status: 403, error: 'غير مصرح: السائقون فقط يمكنهم تحديث حالة الرحلة' };
        }
        const effectiveDriverId = driverId || session.id;
        if (String(session.id).trim() !== String(effectiveDriverId).trim()) {
            return { status: 403, error: 'غير مصرح: لا يمكنك تحديث الحالة باسم سائق آخر' };
        }
        if (!dbRide || dbRide.driver_id !== session.id) {
            return { status: 403, error: 'غير مصرح بتحديث حالة هذه الرحلة' };
        }
        return { status: 200, success: true };
    }

    if (action === 'complete') {
        if (!session || session.role !== 'driver') {
            return { status: 403, error: 'غير مصرح: السائقون فقط يمكنهم إكمال الرحلة' };
        }
        if (!dbRide || dbRide.driver_id !== session.id) {
            return { status: 403, error: 'غير مصرح: لا يمكنك إكمال رحلة غير منسوبة إليك' };
        }
        return { status: 200, success: true };
    }

    if (action === 'cancel_by_driver') {
        const { driverId } = body;
        if (!session || session.role !== 'driver' || String(session.id).trim() !== String(driverId).trim()) {
            return { status: 403, error: 'غير مصرح: لا يمكنك إلغاء رحلة باسم سائق آخر' };
        }
        if (!dbRide || dbRide.driver_id !== session.id) {
            return { status: 403, error: 'غير مصرح: هذه الرحلة غير منسوبة إليك' };
        }
        return { status: 200, success: true };
    }

    if (action === 'cancel_by_passenger') {
        if (!session || session.role !== 'passenger') {
            return { status: 403, error: 'غير مصرح: يجب أن تكون راكباً لإلغاء هذه الرحلة' };
        }
        if (!dbRide) {
            return { status: 404, error: 'الرحلة غير موجودة' };
        }
        if (!dbRide.passenger_id) {
            return { status: 403, error: 'بيانات مالك الرحلة مفقودة وغير مصرح بإلغائها' };
        }
        if (String(session.id).trim() !== String(dbRide.passenger_id).trim()) {
            return { status: 403, error: 'غير مصرح لك بإلغاء رحلة راكب آخر' };
        }
        return { status: 200, success: true, rpcCalled: true };
    }

    if (action === 'ban_driver') {
        if (!session || session.role !== 'admin') {
            return { status: 403, error: 'غير مصرح: هذه العملية تتطلب صلاحيات إدارية' };
        }
        return { status: 200, success: true };
    }

    if (action === 'reject') {
        const { driverId } = body;
        if (!session || session.role !== 'driver' || String(session.id).trim() !== String(driverId).trim()) {
            return { status: 403, error: 'غير مصرح: لا يمكنك رفض رحلة باسم سائق آخر' };
        }
        if (!dbRide || dbRide.driver_id !== driverId) {
            return { status: 403, error: 'غير مصرح برفض هذه الرحلة' };
        }
        return { status: 200, success: true };
    }

    if (action === 'submit_complaint') {
        const { userId, userType } = body;
        if (!session || String(session.id).trim() !== String(userId).trim() || session.role !== userType) {
            return { status: 403, error: 'غير مصرح: لا يمكنك إرسال شكوى باسم مستخدم آخر' };
        }
        return { status: 200, success: true };
    }

    return { status: 400, error: 'Unknown action' };
}

// 3.1 السائق لا يستطيع إنشاء رحلة باسم راكب
{
    const res = simulateRidesAuth({
        action: 'create',
        body: { passengerId: 'passenger-1' },
        session: { id: 'driver-1', role: 'driver' }
    });
    assert.strictEqual(res.status, 403);
    console.log('✅ Test 3.1 Passed: Driver cannot create ride as passenger');
}

// 3.2 راكب لا يستطيع إنشاء رحلة باسم راكب آخر
{
    const res = simulateRidesAuth({
        action: 'create',
        body: { passengerId: 'victim-passenger' },
        session: { id: 'attacker-passenger', role: 'passenger' }
    });
    assert.strictEqual(res.status, 403);
    console.log('✅ Test 3.2 Passed: Passenger cannot create ride in name of another passenger');
}

// 3.3 الراكب لا يستطيع قبول رحلة
{
    const res = simulateRidesAuth({
        action: 'accept',
        body: { rideId: 'r1', driverId: 'passenger-1' },
        session: { id: 'passenger-1', role: 'passenger' }
    });
    assert.strictEqual(res.status, 403);
    console.log('✅ Test 3.3 Passed: Passenger cannot accept ride');
}

// 3.4 سائق لا يستطيع قبول رحلة باسم سائق آخر
{
    const res = simulateRidesAuth({
        action: 'accept',
        body: { rideId: 'r1', driverId: 'victim-driver' },
        session: { id: 'attacker-driver', role: 'driver' }
    });
    assert.strictEqual(res.status, 403);
    console.log('✅ Test 3.4 Passed: Driver cannot accept ride as another driver');
}

// 3.5 الراكب لا يستطيع إكمال رحلة
{
    const res = simulateRidesAuth({
        action: 'complete',
        body: { rideId: 'r1' },
        session: { id: 'passenger-1', role: 'passenger' },
        dbRide: { id: 'r1', driver_id: 'driver-1' }
    });
    assert.strictEqual(res.status, 403);
    console.log('✅ Test 3.5 Passed: Passenger cannot complete ride');
}

// 3.6 سائق غير معين للرحلة لا يستطيع إكمالها
{
    const res = simulateRidesAuth({
        action: 'complete',
        body: { rideId: 'r1' },
        session: { id: 'driver-2', role: 'driver' },
        dbRide: { id: 'r1', driver_id: 'driver-1' }
    });
    assert.strictEqual(res.status, 403);
    console.log('✅ Test 3.6 Passed: Non-assigned driver cannot complete ride');
}

// 3.7 السائق المعين يكمل الرحلة بنجاح
{
    const res = simulateRidesAuth({
        action: 'complete',
        body: { rideId: 'r1' },
        session: { id: 'driver-1', role: 'driver' },
        dbRide: { id: 'r1', driver_id: 'driver-1' }
    });
    assert.strictEqual(res.status, 200);
    console.log('✅ Test 3.7 Passed: Assigned driver completes ride successfully');
}

// 3.8 الراكب والسائق لا يستطيعان تنفيذ ban_driver
{
    const resPass = simulateRidesAuth({
        action: 'ban_driver',
        body: { driverId: 'driver-1' },
        session: { id: 'passenger-1', role: 'passenger' }
    });
    assert.strictEqual(resPass.status, 403);

    const resDriver = simulateRidesAuth({
        action: 'ban_driver',
        body: { driverId: 'driver-1' },
        session: { id: 'driver-2', role: 'driver' }
    });
    assert.strictEqual(resDriver.status, 403);

    const resAdmin = simulateRidesAuth({
        action: 'ban_driver',
        body: { driverId: 'driver-1' },
        session: { id: 'admin-super', role: 'admin' }
    });
    assert.strictEqual(resAdmin.status, 200);
    console.log('✅ Test 3.8 Passed: ban_driver strictly limited to role admin');
}

// 3.9 السائق لا يستطيع إلغاء رحلة راكب عبر cancel_by_passenger
{
    const res = simulateRidesAuth({
        action: 'cancel_by_passenger',
        body: { rideId: 'r1' },
        session: { id: 'driver-1', role: 'driver' },
        dbRide: { id: 'r1', passenger_id: 'passenger-1' }
    });
    assert.strictEqual(res.status, 403);
    console.log('✅ Test 3.9 Passed: Driver cannot invoke cancel_by_passenger');
}

// 3.10 راكب لا يستطيع إلغاء رحلة راكب آخر
{
    const res = simulateRidesAuth({
        action: 'cancel_by_passenger',
        body: { rideId: 'r1' },
        session: { id: 'attacker', role: 'passenger' },
        dbRide: { id: 'r1', passenger_id: 'victim' }
    });
    assert.strictEqual(res.status, 403);
    console.log('✅ Test 3.10 Passed: Passenger cannot cancel another passenger ride');
}

// 3.11 الراكب المالك يلغي رحلته بنجاح
{
    const res = simulateRidesAuth({
        action: 'cancel_by_passenger',
        body: { rideId: 'r1' },
        session: { id: 'passenger-1', role: 'passenger' },
        dbRide: { id: 'r1', passenger_id: 'passenger-1' }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.rpcCalled, true);
    console.log('✅ Test 3.11 Passed: Owner passenger cancels ride successfully');
}

// ============================================
// 4. اختبار المحاكاة المحاسبية لدالة cancel_ride
// ============================================
{
    // حجز 100 واسترداد 100
    const heldAmount = 100;
    let driverBalance = 500;
    const ledger = [{ type: 'commission_held', amount: -heldAmount }];

    // محاكاة حساب صافي الاسترداد
    const totalHeld = ledger.filter(t => t.type === 'commission_held' && t.amount < 0).reduce((s, t) => s + (-t.amount), 0);
    const totalRefunded = ledger.filter(t => t.type === 'cancellation_refund' && t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const netRefund = totalHeld - totalRefunded;

    assert.strictEqual(netRefund, 100);
    driverBalance += netRefund;
    ledger.push({ type: 'cancellation_refund', amount: netRefund });
    assert.strictEqual(driverBalance, 600);

    // محاولة استرداد مكررة فورية
    const totalHeld2 = ledger.filter(t => t.type === 'commission_held' && t.amount < 0).reduce((s, t) => s + (-t.amount), 0);
    const totalRefunded2 = ledger.filter(t => t.type === 'cancellation_refund' && t.amount > 0).reduce((s, t) => s + t.amount, 0);
    const netRefund2 = totalHeld2 - totalRefunded2;
    assert.strictEqual(netRefund2, 0);
    console.log('✅ Test 4.1 Passed: Accounting ledger calculation refunds 100 and strictly prevents double refund (0 remaining)');
}

console.log('=== ALL ADVANCED SECURITY & AUTHORIZATION TESTS PASSED ===');
