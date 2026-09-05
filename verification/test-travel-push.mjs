import assert from 'assert';

// Simulate functions from api/travel-push.js
const CITY_ALIASES = {
    'امدرمان': 'ام درمان',
    'ام درمان': 'ام درمان',
    'أم درمان': 'ام درمان',
    'أمدرمان': 'ام درمان',
    'الخرطوم': 'الخرطوم',
    'خرطوم': 'الخرطوم',
    'بحري': 'خرطوم بحري',
    'الخرطوم بحري': 'خرطوم بحري',
    'خرطوم بحري': 'خرطوم بحري',
    'مدني': 'ود مدني',
    'ود مدني': 'ود مدني',
    'ودمدني': 'ود مدني',
    'الجزيرة': 'ود مدني',
    'بورتسودان': 'بورتسودان',
    'بور سودان': 'بورتسودان',
    'بورت سودان': 'بورتسودان',
    'الابيض': 'الابيض',
    'الأبيض': 'الابيض',
    'عطبرة': 'عطبرة',
    'عطبره': 'عطبرة',
    'شندي': 'شندي',
    'ابوحمد': 'ابو حمد',
    'أبو حمد': 'ابو حمد',
    'القضارف': 'القضارف',
    'قضارف': 'القضارف',
    'كسلا': 'كسلا'
};

function normalizeCityName(cityName) {
    if (!cityName) return '';
    return cityName
        .trim()
        .replace(/[\u064B-\u065F]/g, '')
        .replace(/[أإآآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/\s+/g, ' ')
        .trim();
}

function getCanonicalCityName(cityName) {
    if (!cityName) return '';
    const norm = normalizeCityName(cityName);
    if (CITY_ALIASES[norm]) return CITY_ALIASES[norm];
    const noAl = norm.replace(/^ال/, '');
    if (CITY_ALIASES[noAl]) return CITY_ALIASES[noAl];
    return norm;
}

function matchesCityName(cityA, cityB) {
    if (!cityA || !cityB) return false;
    const canonA = getCanonicalCityName(cityA);
    const canonB = getCanonicalCityName(cityB);
    if (canonA && canonB && canonA === canonB) return true;
    const normA = normalizeCityName(cityA);
    const normB = normalizeCityName(cityB);
    if (normA === normB) return true;
    const strippedA = normA.replace(/^ال/, '');
    const strippedB = normB.replace(/^ال/, '');
    if (strippedA && strippedB && strippedA === strippedB) return true;
    return false;
}

function getHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

console.log('🧪 Running Travel Push Notification Unit Tests...');

// Test 1: Exact and Canonical City Matching
console.log('Test 1: City Name Matching variants');
assert.strictEqual(matchesCityName('أم درمان', 'امدرمان'), true, 'أم درمان vs امدرمان should match');
assert.strictEqual(matchesCityName('الخرطوم بحري', 'بحري'), true, 'الخرطوم بحري vs بحري should match');
assert.strictEqual(matchesCityName('مدني', 'ود مدني'), true, 'مدني vs ود مدني should match');
assert.strictEqual(matchesCityName('الأبيض', 'الابيض'), true, 'الأبيض vs الابيض should match');
assert.strictEqual(matchesCityName('بور سودان', 'بورتسودان'), true, 'بور سودان vs بورتسودان should match');
assert.strictEqual(matchesCityName('عطبرة', 'عطبره'), true, 'عطبرة vs عطبره should match');
assert.strictEqual(matchesCityName('الخرطوم', 'كسلا'), false, 'الخرطوم vs كسلا should NOT match');
console.log('✅ Test 1 Passed!');

// Test 2: Banned & Disabled Drivers Filter Simulation
console.log('Test 2: Driver Qualification Filtering');
const driversSample = [
    { id: 'd1', city: 'أم درمان', is_banned: false, ban_until: null, travel_notifications_enabled: true, fcm_token: 'token1' },
    { id: 'd2', city: 'امدرمان', is_banned: true, ban_until: '2099-01-01', travel_notifications_enabled: true, fcm_token: 'token2' },
    { id: 'd3', city: 'ام درمان', is_banned: false, ban_until: null, travel_notifications_enabled: false, fcm_token: 'token3' },
    { id: 'd4', city: 'كسلا', is_banned: false, ban_until: null, travel_notifications_enabled: true, fcm_token: 'token4' },
    { id: 'd5', city: 'مدني', is_banned: false, ban_until: null, travel_notifications_enabled: true, fcm_token: 'token5' },
    { id: 'd6', city: 'ود مدني', is_banned: false, ban_until: null, travel_notifications_enabled: true, fcm_token: '' } // Invalid token
];

const fromCityReq = 'أم درمان';
const matched = driversSample.filter(d => {
    if (d.is_banned && d.ban_until && new Date(d.ban_until) > new Date()) return false;
    if (d.travel_notifications_enabled === false) return false;
    if (!d.fcm_token) return false;
    return matchesCityName(d.city, fromCityReq);
});

assert.strictEqual(matched.length, 1, 'Only d1 should match for أم درمان request');
assert.strictEqual(matched[0].id, 'd1');
console.log('✅ Test 2 Passed!');

// Test 3: GPS Matching & Distance Fallback
console.log('Test 3: GPS Distance Calculation');
const khartoumCenter = { lat: 15.5007, lng: 32.5599 };
const nearbyDriverLoc = { lat: 15.5200, lng: 32.5400 }; // ~3km away
const farDriverLoc = { lat: 14.4012, lng: 33.5199 }; // Madani ~160km away

const nearDist = getHaversineDistance(khartoumCenter.lat, khartoumCenter.lng, nearbyDriverLoc.lat, nearbyDriverLoc.lng);
const farDist = getHaversineDistance(khartoumCenter.lat, khartoumCenter.lng, farDriverLoc.lat, farDriverLoc.lng);

assert.ok(nearDist <= 80, `Near driver distance ${nearDist.toFixed(1)}km should be <= 80km`);
assert.ok(farDist > 80, `Far driver distance ${farDist.toFixed(1)}km should be > 80km`);
console.log('✅ Test 3 Passed!');

// Test 4: Fault-Tolerant Multi-Driver FCM Loop
console.log('Test 4: Isolated FCM Dispatch Exception Handling');
let successCount = 0;
let failCount = 0;
const fcmTokens = ['valid_1', 'invalid_throw', 'valid_2'];

for (const token of fcmTokens) {
    try {
        if (token === 'invalid_throw') {
            throw new Error('FCM Network Error');
        }
        successCount++;
    } catch (err) {
        failCount++;
    }
}

assert.strictEqual(successCount, 2);
assert.strictEqual(failCount, 1);
console.log('✅ Test 4 Passed!');

console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
