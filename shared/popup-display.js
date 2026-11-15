/**
 * Tracka - Popup Messages Display (shared)
 * Fetches active popup messages for the CURRENT session role and shows them
 * inside the passenger/driver app. Fully fail-safe and independent from FCM.
 *
 * Usage (after the user session is restored):
 *   TrackaPopupMessages.init('passenger');
 *   TrackaPopupMessages.init('driver');
 */
(function () {
    'use strict';

    var STYLE_ID = 'tracka-popup-messages-style';
    var FETCH_TIMEOUT_MS = 4000;
    var fetchedOnce = false;
    var isShowing = false;
    // Guards against sending the same "once" view record twice in one page life.
    var markedView = {};

    // Pages where popups must NEVER appear (active ride flows). Matched by path
    // so the exclusion stays correct even if the script is loaded on these pages.
    var EXCLUDED_PAGES = [
        'driver_app/accept-ride.html',
        'driver_app/active-ride.html',
        'passenger_app/ride-accepted.html'
    ];

    function isExcludedPage() {
        var path;
        try { path = (window.location && window.location.pathname) || ''; } catch (e) { return false; }
        return EXCLUDED_PAGES.some(function (page) { return path.indexOf(page) !== -1; });
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '.tracka-popup-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);' +
            'display:flex;align-items:center;justify-content:center;padding:18px;z-index:4500;' +
            '-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);animation:trackaPopupFade .25s ease;}' +
            '.tracka-popup-card{background:#fff;border-radius:18px;overflow:hidden;width:100%;max-width:380px;' +
            'max-height:90vh;overflow-y:auto;box-shadow:0 18px 50px rgba(0,0,0,0.3);' +
            'font-family:"Tajawal",sans-serif;direction:rtl;animation:trackaPopupUp .3s ease;}' +
            '.tracka-popup-card img{width:100%;max-height:220px;object-fit:cover;display:block;}' +
            '.tracka-popup-content{padding:20px;}' +
            '.tracka-popup-title{color:#008B5E;font-size:1.2rem;font-weight:800;margin:0 0 10px;}' +
            '.tracka-popup-body{color:#334155;font-size:.98rem;line-height:1.7;margin:0 0 16px;white-space:pre-wrap;}' +
            '.tracka-popup-actions{display:flex;flex-direction:column;gap:8px;}' +
            '.tracka-popup-btn{border:none;border-radius:12px;padding:13px 16px;font-size:1rem;font-weight:700;' +
            'cursor:pointer;font-family:inherit;text-align:center;text-decoration:none;display:block;}' +
            '.tracka-popup-btn-primary{background:linear-gradient(135deg,#008B5E 0%,#005F41 100%);color:#fff;}' +
            '.tracka-popup-btn-secondary{background:#fff;color:#005F41;border:2px solid #008B5E;}' +
            '.tracka-popup-close{position:absolute;top:12px;left:12px;background:rgba(255,255,255,.9);' +
            'border:none;width:34px;height:34px;border-radius:50%;font-size:20px;line-height:1;' +
            'color:#64748b;cursor:pointer;z-index:2;}' +
            '@keyframes trackaPopupFade{from{opacity:0}to{opacity:1}}' +
            '@keyframes trackaPopupUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}';
        document.head.appendChild(style);
    }

    function getToken() {
        try {
            return localStorage.getItem('session_token') ||
                localStorage.getItem('tarhal_session_token') || '';
        } catch (e) { return ''; }
    }

    function getUserId(appType) {
        try {
            var raw = localStorage.getItem(appType === 'driver' ? 'tarhal_driver' : 'tarhal_customer');
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            return parsed && parsed.id ? parsed.id : null;
        } catch (e) { return null; }
    }

    function isSessionSeen(id) {
        try { return sessionStorage.getItem('tracka_popup_seen_' + id) === '1'; }
        catch (e) { return false; }
    }

    function markSessionSeen(id) {
        try { sessionStorage.setItem('tracka_popup_seen_' + id, '1'); } catch (e) {}
    }

    function intervalKey(id) { return 'tracka_popup_interval_' + id; }

    function isIntervalDue(msg) {
        try {
            var last = parseInt(localStorage.getItem(intervalKey(msg.id)) || '0', 10);
            if (!last) return true;
            var intervalMs = (parseInt(msg.repeat_interval_minutes, 10) || 60) * 60 * 1000;
            return (Date.now() - last) >= intervalMs;
        } catch (e) { return true; }
    }

    function markIntervalShown(id) {
        try { localStorage.setItem(intervalKey(id), String(Date.now())); } catch (e) {}
    }

    // Decide whether a message should be shown now, based on its repeat policy.
    function shouldShow(msg) {
        if (msg.repeat_policy === 'once') return true;      // server already filtered seen ones
        if (msg.repeat_policy === 'session') return !isSessionSeen(msg.id);
        if (msg.repeat_policy === 'every_visit') return true;
        if (msg.repeat_policy === 'interval') return isIntervalDue(msg);
        return false;
    }

    function markShown(msg) {
        if (msg.repeat_policy === 'session') markSessionSeen(msg.id);
        else if (msg.repeat_policy === 'interval') markIntervalShown(msg.id);
    }

    function isSafeUrl(url) {
        return typeof url === 'string' && /^https?:\/\//i.test(url);
    }

    function sendMarkView(messageId) {
        // Idempotent: never send the same record twice within this page life.
        if (markedView[messageId]) return;
        markedView[messageId] = true;
        try {
            var token = getToken();
            fetch('/api/popup-messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': token ? 'Bearer ' + token : ''
                },
                body: JSON.stringify({ action: 'mark_view', message_id: messageId }),
                // keepalive lets the request complete even if the page is being
                // navigated away (e.g. driver tapping an incoming ride request).
                keepalive: true
            }).catch(function () {});
        } catch (e) {}
    }

    function renderMessage(msg) {
        injectStyles();

        var overlay = document.createElement('div');
        overlay.className = 'tracka-popup-overlay';

        var card = document.createElement('div');
        card.className = 'tracka-popup-card';
        card.style.position = 'relative';

        var closeBtn = document.createElement('button');
        closeBtn.className = 'tracka-popup-close';
        closeBtn.setAttribute('aria-label', 'إغلاق');
        closeBtn.innerHTML = '&times;';
        card.appendChild(closeBtn);

        if (msg.image_url && isSafeUrl(msg.image_url)) {
            var img = document.createElement('img');
            img.src = msg.image_url;
            img.alt = '';
            img.onerror = function () { img.remove(); };
            card.appendChild(img);
        }

        var content = document.createElement('div');
        content.className = 'tracka-popup-content';

        var title = document.createElement('h3');
        title.className = 'tracka-popup-title';
        title.textContent = msg.title || '';
        content.appendChild(title);

        var body = document.createElement('p');
        body.className = 'tracka-popup-body';
        body.textContent = msg.body || '';
        content.appendChild(body);

        var actions = document.createElement('div');
        actions.className = 'tracka-popup-actions';

        if (msg.primary_button_text) {
            actions.appendChild(buildButton(msg.primary_button_text, msg.primary_button_url, 'tracka-popup-btn-primary'));
        }
        if (msg.secondary_button_text) {
            actions.appendChild(buildButton(msg.secondary_button_text, msg.secondary_button_url, 'tracka-popup-btn-secondary'));
        }
        if (actions.children.length > 0) content.appendChild(actions);

        card.appendChild(content);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        // Record the permanent per-user view the moment the message is actually
        // shown (not on close), so it is never lost if the user navigates away.
        if (msg.repeat_policy === 'once') sendMarkView(msg.id);

        var closed = false;
        function close() {
            if (closed) return;
            closed = true;
            try { overlay.remove(); } catch (e) {}
            markShown(msg);
            isShowing = false;
        }

        closeBtn.addEventListener('click', close);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    }

    function buildButton(text, url, className) {
        var isLink = isSafeUrl(url);
        var el = document.createElement(isLink ? 'a' : 'button');
        el.className = 'tracka-popup-btn ' + className;
        el.textContent = text;
        if (isLink) {
            el.href = url;
            el.target = '_blank';
            el.rel = 'noopener noreferrer';
        } else {
            el.type = 'button';
        }
        return el;
    }

    // Show messages sequentially: highest priority first, next appears after the
    // current one is closed. Respects each message's delay before appearing.
    function showQueue(queue) {
        if (!queue.length) { isShowing = false; return; }
        isShowing = true;
        var next = queue.shift();
        var delay = Math.max(0, parseInt(next.delay_seconds, 10) || 0);
        setTimeout(function () {
            renderMessage(next);
            var waitForClose = setInterval(function () {
                var open = document.querySelector('.tracka-popup-overlay');
                if (!open) {
                    clearInterval(waitForClose);
                    showQueue(queue);
                }
            }, 400);
        }, delay * 1000);
    }

    function init(appType) {
        if (isExcludedPage()) return;
        if (fetchedOnce) return;
        fetchedOnce = true;

        // Only fetch when a real user session exists (after session restore).
        if (!getUserId(appType)) { fetchedOnce = false; return; }

        var token = getToken();
        if (!token) { fetchedOnce = false; return; }

        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timeoutId = setTimeout(function () { if (controller) controller.abort(); }, FETCH_TIMEOUT_MS);

        fetch('/api/popup-messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token
            },
            body: JSON.stringify({ action: 'list' }),
            signal: controller ? controller.signal : undefined
        })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (!data || !data.success || !Array.isArray(data.messages)) return;
                var queue = data.messages
                    .filter(shouldShow)
                    .sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
                if (queue.length) showQueue(queue);
            })
            .catch(function () { /* fail-safe: never break the app */ })
            .finally(function () { clearTimeout(timeoutId); });
    }

    window.TrackaPopupMessages = { init: init };
})();
