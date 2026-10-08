/* Shared helpers for every page: login check, link routing (Messages / Friends), unread-messages badge,
   verified badge, and a small "Coming soon" toast. Loaded with <script src="shell.js" defer>. */
(function () {
    var ACCOUNTS_KEY = 'rbxtest_accounts', SESSION_KEY = 'rbxtest_session';

    function readJSON(storage, key, fallback) {
        try { var v = JSON.parse(storage.getItem(key)); return v === null || v === undefined ? fallback : v; } catch (e) { return fallback; }
    }
    function readAccounts() { return readJSON(localStorage, ACCOUNTS_KEY, {}); }
    function readSession() {
        var stores = [sessionStorage, localStorage];
        for (var i = 0; i < stores.length; i++) {
            var s = readJSON(stores[i], SESSION_KEY, null);
            if (s && typeof s === 'object' && s.username && s.token) return s;
        }
        return null;
    }
    function sha256Hex(text) {
        if (window.crypto && crypto.subtle) {
            return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
                return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
            });
        }
        var h = 5381;
        for (var i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
        return Promise.resolve('weak-' + h.toString(16));
    }
    function esc(t) {
        return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
    }
    function currentKey() { var s = readSession(); return s && s.username; }
    function currentAccount() { var k = currentKey(); return k ? readAccounts()[k] || null : null; }
    // Permanent ban: any account whose name contains "roblox" is banned forever and signed out everywhere.
    (function banGuard() {
        var acc = readAccounts(), changed = false;
        Object.keys(acc).forEach(function (k) {
            var a = acc[k] || {};
            if ((/roblox/i.test(k) || /roblox/i.test(a.username || '')) && !a.banned) { a.banned = true; a.tokenHashes = []; acc[k] = a; changed = true; }
        });
        if (changed) localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(acc));
        var s = readSession();
        if (s && acc[s.username] && acc[s.username].banned) {
            try { localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
            location.replace('index.html');
        }
    })();
    function saveAccount(key, patch) {
        var all = readAccounts();
        if (!all[key]) return null;
        Object.keys(patch).forEach(function (k) { all[key][k] = patch[k]; });
        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(all));
        return all[key];
    }
    function displayName(acc) { return (acc && (acc.displayName || acc.username)) || ''; }

    // A banned account (flagged, or any name containing "roblox") never appears in Global, friend lists or search.
    function isBanned(acc) { return !!acc && (acc.banned === true || /roblox/i.test(String(acc.username || ''))); }
    function visibleAccounts() {
        var all = readAccounts();
        return Object.keys(all).map(function (k) { return all[k]; }).filter(function (a) { return a && a.username && !isBanned(a); });
    }

    // Only the "figureblox" account gets the verified badge, shown to everyone.
    function isVerified(acc) { return !!acc && String(acc.username).toLowerCase() === 'figureblox'; }
    var VERIFIED_HTML = '<span class="relative inline-flex items-center justify-center rbxtest-verified" role="img" aria-label="Verified Badge Icon" title="Verified Badge Icon" style="margin-left:4px;flex:none;">' +
        '<span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-filled-verified-backplate size-[var(--icon-size-medium)] content-system-emphasis"></span>' +
        '<span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-filled-verified-check size-[var(--icon-size-medium)] absolute content-[white]"></span></span>';

    // Everyone is a FigureBlox Plus subscriber: the Plus icon shows next to every name.
    var PLUS_HTML = '<span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-regular-roblox-plus size-[var(--icon-size-large)] relative rbxtest-plus" role="button" title="Switch Accounts" style="top: -1px;margin-left:4px;flex:none;cursor:pointer;"></span>';

    // ---------- News posts: the "figureblox" account can post; every account gets them in its Inbox ----------
    var POSTS_KEY = 'rbxtest_posts';
    function readPosts() { var p = readJSON(localStorage, POSTS_KEY, []); return Array.isArray(p) ? p : []; }
    function isPoster(acc) { return !!acc && String(acc.username).toLowerCase() === 'figureblox'; }
    function addPost(title, body) {
        var k = currentKey(), acc = currentAccount();
        if (!isPoster(acc)) return null;   // only the FigureBlox account may post
        var post = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title: String(title || '').slice(0, 100), body: String(body || '').slice(0, 5000), date: new Date().toISOString() };
        var posts = readPosts(); posts.unshift(post);
        localStorage.setItem(POSTS_KEY, JSON.stringify(posts));
        var seen = (acc.readPosts || []).concat(post.id);   // the poster's own copy starts as read
        saveAccount(k, { readPosts: seen });
        window.dispatchEvent(new Event('storage'));
        return post;
    }

    // ---------- Friends: requests land in the receiver's Inbox; accepting makes both accounts friends ----------
    //   account.friends = [usernames], account.friendRequests = [{from, date}] (incoming, still pending)
    function keyOf(u) { return String(u).toLowerCase(); }
    function friendsOf(acc) { return (acc && acc.friends) || []; }
    function pendingRequests(acc) { return (acc && acc.friendRequests) || []; }
    function isFriend(acc, u) { return friendsOf(acc).indexOf(keyOf(u)) !== -1; }
    function hasSentTo(target, from) { return pendingRequests(target).some(function (r) { return r.from === keyOf(from); }); }
    // returns 'sent' | 'already-friends' | 'already-sent' | 'they-asked' | 'self' | 'missing'
    function sendFriendRequest(toUser) {
        var me = currentKey(), to = keyOf(toUser), all = readAccounts();
        if (!me || !all[to] || isBanned(all[to])) return 'missing';
        if (to === keyOf(me)) return 'self';
        if (isFriend(all[me], to)) return 'already-friends';
        if (hasSentTo(all[me], to)) return 'they-asked';
        if (hasSentTo(all[to], me)) return 'already-sent';
        saveAccount(to, { friendRequests: pendingRequests(all[to]).concat({ from: keyOf(me), date: new Date().toISOString() }) });
        schedule();
        return 'sent';
    }
    function dropRequest(from) {
        var me = currentKey(), acc = readAccounts()[me];
        saveAccount(me, { friendRequests: pendingRequests(acc).filter(function (r) { return r.from !== keyOf(from); }) });
    }
    function acceptRequest(from) {
        var me = currentKey(), f = keyOf(from), all = readAccounts();
        if (!me || !all[f]) return dropRequest(from);
        dropRequest(from);
        var mine = friendsOf(readAccounts()[me]);
        if (mine.indexOf(f) === -1) saveAccount(me, { friends: mine.concat(f) });
        var theirs = friendsOf(all[f]);
        if (theirs.indexOf(keyOf(me)) === -1) saveAccount(f, { friends: theirs.concat(keyOf(me)) });
        schedule();
    }
    function declineRequest(from) { dropRequest(from); schedule(); }

    // One welcome message is delivered to every new account (unread until opened), plus every News post not yet opened,
    // plus one for every pending friend request (it stays counted until it is accepted or declined).
    function unreadCount(acc) {
        if (!acc) return 0;
        var n = (acc.messageRead ? 0 : 1) + pendingRequests(acc).length, seen = acc.readPosts || [];
        readPosts().forEach(function (p) { if (seen.indexOf(p.id) === -1) n++; });
        return n;
    }

    // ---------- Presence: every open page of a logged-in account sends a heartbeat; anyone can read it ----------
    var PRESENCE_KEY = 'rbxtest_presence', BEAT_MS = 15000, ONLINE_MS = 60000;
    function readPresence() { return readJSON(localStorage, PRESENCE_KEY, {}); }
    function writePresence(k, t) {
        try { var p = readPresence(); p[String(k).toLowerCase()] = t; localStorage.setItem(PRESENCE_KEY, JSON.stringify(p)); } catch (e) {}
    }
    function beat() { var k = currentKey(); if (k && readAccounts()[k]) writePresence(k, Date.now()); }
    function markOffline() { var k = currentKey(); if (k) writePresence(k, 0); }
    function isOnline(username) {
        var t = readPresence()[String(username).toLowerCase()];
        return typeof t === 'number' && Date.now() - t < ONLINE_MS;
    }

    function fmtDate(iso, withYear) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) d = new Date();
        var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
        var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
        var m = ('0' + d.getMinutes()).slice(-2);
        return mon + ' ' + d.getDate() + (withYear ? ', ' + d.getFullYear() : '') + ' | ' + h + ':' + m + ' ' + ap;
    }

    function toast(message) {
        var old = document.getElementById('rbxtest-toast');
        if (old) old.remove();
        var t = document.createElement('div');
        t.id = 'rbxtest-toast';
        t.setAttribute('role', 'status');
        t.textContent = message;
        t.style.cssText = 'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483000;background:#232527;color:#fff;padding:12px 20px;border-radius:8px;font:600 14px/1.2 sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.4);';
        document.body.appendChild(t);
        setTimeout(function () { t.remove(); }, 2200);
    }

    // Verify the saved session; callback(account, accountKey) or redirect to the login page.
    function requireLogin(cb) {
        var session = readSession();
        var acc = session && readAccounts()[session.username];
        var fail = function () {
            sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY);
            window.location.replace('index.html');
        };
        if (!acc) return fail();
        sha256Hex('session:' + session.token).then(function (hash) {
            if ((acc.tokenHashes || []).indexOf(hash) === -1) return fail();
            document.documentElement.classList.remove('rbx-auth-pending');
            rememberSession(session);
            cb(acc, session.username);
        }, fail);
    }

    // ---------- Account switcher: accounts that were logged in on this device ----------
    // Stored as [{username, token}] (the same kind of session token a normal login creates).
    // Every account that logs in on this device stays in this list (up to 4).
    var SWITCHER_KEY = 'rbxtest_switcher';
    function readSwitcher() { var l = readJSON(localStorage, SWITCHER_KEY, []); return Array.isArray(l) ? l : []; }
    function writeSwitcher(l) { try { localStorage.setItem(SWITCHER_KEY, JSON.stringify(l)); } catch (e) {} }
    function rememberSession(sess) {
        if (!sess || !sess.username || !sess.token) return;
        writeSwitcher(readSwitcher().filter(function (e) { return e.username !== sess.username; }).concat({ username: sess.username, token: sess.token }).slice(-4));
    }
    function forgetAccount(username) { writeSwitcher(readSwitcher().filter(function (e) { return e.username !== username; })); }
    var AVATARS = { male: 'https://proud-river-a3e7.tristan-manzano-actor.workers.dev/', female: 'https://green-leaf-a836.tristan-manzano-actor.workers.dev/' };
    function avatarFor(acc) {
        if (typeof window.avatarFileForAccount === 'function') { try { var f = window.avatarFileForAccount(acc || {}); if (f) return f; } catch (e) {} }
        return String((acc && (acc.selectedCharacter || acc.character)) || '').toLowerCase() === 'female' ? AVATARS.female : AVATARS.male;
    }

    // The same FigureBlox intro screen the login page shows, for a set time, then callback.
    function showSplash(ms, then) {
        if (document.getElementById('fb-splash-switch')) return;
        var o = document.createElement('div');
        o.id = 'fb-splash-switch'; o.setAttribute('role', 'status'); o.setAttribute('aria-label', 'Loading FigureBlox');
        o.style.cssText = 'position:fixed;inset:0;z-index:2147483600;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:28px;background:#111 url("splash.jpg") center/cover no-repeat;';
        o.innerHTML = '<h1 style="margin:0;color:#fff;font:800 clamp(40px,9vw,96px)/1 \'Builder Sans\',\'Gotham SSm\',Arial,sans-serif;letter-spacing:-1px;text-align:center;text-shadow:0 2px 6px rgba(0,0,0,.85),0 0 28px rgba(0,0,0,.6);">FigureBlox</h1><img src="splash.gif" alt="" style="display:block;max-width:min(60vw,320px);max-height:30vh;object-fit:contain;" onerror="this.style.display=\'none\'">';
        document.body.appendChild(o);
        document.documentElement.style.overflow = 'hidden';
        setTimeout(then, ms);
    }

    function openSwitchAccounts() {
        if (document.getElementById('rbxtest-switcher')) return;
        var sess = readSession();
        if (!sess) return;
        rememberSession(sess);
        var accounts = readAccounts();
        var entries = [{ username: sess.username, token: sess.token }].concat(readSwitcher().filter(function (e) { return e.username !== sess.username && accounts[e.username]; })).slice(0, 4);
        var o = document.createElement('div');
        o.id = 'rbxtest-switcher';
        o.style.cssText = 'position:fixed;inset:0;z-index:2147482500;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
        var ROW = 'display:flex;align-items:center;gap:12px;padding:12px 8px;border-radius:8px;cursor:pointer;';
        var rows = entries.map(function (e, i) {
            var a = accounts[e.username] || {};
            return '<li class="account-selection-list-item" style="list-style:none;"><div class="' + (i === 0 ? 'active-account' : 'account-selection') + '" role="button" tabindex="0" data-acct="' + esc(e.username) + '" style="' + ROW + '">' +
                '<div class="account-selection-thumbnail" style="flex:none;width:60px;height:60px;border-radius:50%;overflow:hidden;background:rgba(128,128,128,.25);"><span class="thumbnail-2d-container"><img alt="" src="' + esc(avatarFor(a)) + '" style="width:60px;height:60px;object-fit:cover;display:block;"></span></div>' +
                '<div class="account-selection-name-container" style="min-width:0;flex:1;"><p class="account-selection-displayname" style="margin:0;font-weight:600;display:flex;align-items:center;min-width:0;"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;">' + esc(displayName(a) || e.username) + '</span>' + (isVerified(a) ? VERIFIED_HTML : '') + PLUS_HTML.replace(' rbxtest-plus', '') + '</p><p class="account-selection-username" style="margin:0;opacity:.7;">@' + esc(e.username) + '</p></div>' +
                (i === 0 ? '<div class="rbxtest-current-check" aria-label="Current account" style="flex:none;width:28px;height:28px;border-radius:50%;background:#00b06f;color:#fff;font-size:16px;font-weight:700;line-height:1;display:flex;align-items:center;justify-content:center;">&#10003;</div>' : '') + '</div></li>';
        }).join('');
        var addRow = '<li class="account-selection-list-item" style="list-style:none;"><div class="account-selection" role="button" tabindex="0" data-add-account style="' + ROW + '"><div class="rbxtest-add-circle" style="flex:none;width:60px;height:60px;border-radius:50%;background:rgba(128,128,128,.22);display:flex;align-items:center;justify-content:center;font-size:30px;line-height:1;">+</div><div class="account-selection-name-container"><p class="rbxtest-add-label" style="margin:0;font-weight:600;">Add Account (4 MAX)</p></div></div></li>';
        o.innerHTML = '<div class="modal-content" role="dialog" aria-modal="true" aria-label="Switch Accounts" style="width:100%;max-width:400px;max-height:90vh;overflow:auto;border-radius:12px;background:var(--color-surface-0,#fff);color:var(--color-content-default,inherit);box-shadow:0 8px 32px rgba(0,0,0,.5);">' +
            '<div class="account-switcher-header modal-header" style="position:relative;padding:20px 48px 8px 20px;"><button type="button" class="close" title="close" style="position:absolute;top:10px;right:14px;background:none;border:0;color:inherit;font-size:28px;line-height:1;cursor:pointer;">&times;</button><h4 class="modal-title" style="margin:0;font-size:20px;">Switch Accounts</h4></div>' +
            '<div class="modal-body" style="padding:8px 12px 16px;"><div class="section-content modal-section"><ul class="account-switcher-list " style="margin:0;padding:0;">' + rows + addRow + '</ul></div></div></div>';
        function close() { o.remove(); document.removeEventListener('keydown', onKey, true); }
        function onKey(ev) { if (ev.key === 'Escape') close(); }
        function activate(el) {
            if (el.hasAttribute('data-add-account')) { if (entries.length >= 4) return toast('You can only have 4 accounts'); window.location.href = 'index.html?add=1'; return; }
            var name = el.getAttribute('data-acct');
            if (!name) return;
            if (name === sess.username) return close();   // already on this account
            var entry = entries.filter(function (x) { return x.username === name; })[0], acc = readAccounts()[name];
            if (!entry || !acc) return close();
            sha256Hex('session:' + entry.token).then(function (hash) {
                if ((acc.tokenHashes || []).indexOf(hash) === -1) { close(); return toast('Please log in to that account again'); }   // the account stays in the list
                close();
                showSplash(1000, function () {   // intro screen for 1 second, then into the other account
                    markOffline();
                    sessionStorage.removeItem(SESSION_KEY);
                    localStorage.setItem(SESSION_KEY, JSON.stringify({ username: entry.username, token: entry.token }));
                    window.location.href = 'home.devtools';
                });
            });
        }
        o.addEventListener('mousedown', function (ev) { if (ev.target === o) close(); });
        o.addEventListener('click', function (ev) {
            if (ev.target.closest('.close')) return close();
            var el = ev.target.closest('[data-acct], [data-add-account]');
            if (el) activate(el);
        });
        o.addEventListener('keydown', function (ev) {
            if (ev.key !== 'Enter' && ev.key !== ' ') return;
            var el = ev.target.closest && ev.target.closest('[data-acct], [data-add-account]');
            if (el) { ev.preventDefault(); activate(el); }
        });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(o);
    }

    // ---------- Notifications: every News post shows here; opening one marks it read ----------
    function unreadNews(acc) {
        var seen = (acc && acc.readPosts) || [];
        return readPosts().filter(function (p) { return seen.indexOf(p.id) === -1; }).length;
    }
    function markPostRead(id) {
        var k = currentKey(), acc = currentAccount();
        if (!k || !acc) return;
        var seen = acc.readPosts || [];
        if (seen.indexOf(id) === -1) saveAccount(k, { readPosts: seen.concat(id) });
        schedule();
    }
    function buildNotificationsPanel(boxStyle) {
        var p = document.createElement('div');
        p.setAttribute('role', 'dialog'); p.setAttribute('aria-label', 'Notifications');
        p.style.cssText = (boxStyle || '') + 'width:360px;max-width:calc(100vw - 16px);overflow:hidden;';
        var openId = null;
        var LOGO = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" fill="none" viewBox="0 0 56 56"><path fill="#fff" d="M11.676 0 0 44.166 43.577 56l11.676-44.166zm20.409 35.827-12.177-3.308 3.264-12.342 12.182 3.308z"/></svg>');
        function draw() {
            var acc = currentAccount(), seen = (acc && acc.readPosts) || [], posts = readPosts();
            var rows = posts.map(function (n) {
                var unread = seen.indexOf(n.id) === -1, open = openId === n.id;
                var title = n.title || 'Announcement from FigureBlox';
                return '<button type="button" data-note="' + esc(n.id) + '" style="display:flex;gap:12px;align-items:flex-start;width:100%;box-sizing:border-box;text-align:left;padding:12px 16px;border:0;border-bottom:1px solid rgba(128,128,128,.25);background:' + (unread ? 'rgba(51,95,255,.12)' : 'none') + ';color:inherit;font:inherit;cursor:pointer;">' +
                    '<span style="flex:none;width:40px;height:40px;border-radius:50%;background:#393b3d;display:flex;align-items:center;justify-content:center;"><img alt="" src="' + LOGO + '" style="width:22px;height:22px;"></span>' +
                    '<span style="min-width:0;flex:1;"><span style="display:flex;justify-content:space-between;gap:8px;"><span style="font-weight:' + (unread ? 700 : 500) + ';overflow-wrap:anywhere;">' + esc(title) + '</span>' + (unread ? '<span aria-label="Unread" style="flex:none;width:10px;height:10px;margin-top:5px;border-radius:50%;background:#335fff;"></span>' : '') + '</span>' +
                    '<span style="display:block;opacity:.75;font-size:14px;margin-top:2px;overflow-wrap:anywhere;' + (open ? 'white-space:pre-wrap;' : 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;') + '">' + esc(open ? n.body : String(n.body).split('\n')[0]) + '</span>' +
                    '<span style="display:block;opacity:.55;font-size:12px;margin-top:4px;">' + fmtDate(n.date, false) + '</span></span></button>';
            }).join('');
            p.innerHTML = '<div class="notification-stream-base builder-font"><div class="notification-stream-header" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid rgba(128,128,128,.3);"><span style="font-weight:700;">Notifications</span></div>' +
                '<div style="min-height:' + (posts.length ? '0' : '600px') + ';max-height:calc(100vh - 90px);overflow-y:auto;' + (posts.length ? '' : 'display:flex;align-items:center;justify-content:center;') + 'box-sizing:border-box;">' + (rows || '<span>All caught up!</span>') + '</div></div>';
        }
        p.addEventListener('click', function (e) {
            var b = e.target.closest && e.target.closest('[data-note]');
            if (!b) return;
            var id = b.getAttribute('data-note');
            openId = openId === id ? null : id;
            markPostRead(id);   // opening it counts as reading it: the number on the bell goes away
            draw();
        });
        window.addEventListener('storage', function () { if (p.isConnected) draw(); });
        draw();
        return p;
    }

    // ---------- Link routing: Messages and Friends links go to the local pages ----------
    function routeFor(a) {
        var h = a.getAttribute && a.getAttribute('href');
        if (!h) return null;
        var path;
        try { path = new URL(h, window.location.href).pathname; } catch (e) { return null; }
        if (/^\/my\/messages\/?$/.test(path) || /^\/my\/messages\/?#/.test(h)) return 'messages.devtools';
        if (/^\/users\/friends\/?$/.test(path)) return 'friends.devtools';
        if (/^\/upgrades\/robux\/?$/.test(path)) return 'robux.devtools';
        if (/^\/plus\/?$/.test(path)) return 'plus.devtools';
        if (/^\/users\/(\d+\/)?profile\/?$/.test(path)) return 'profileview.devtools';
        return null;
    }
    // Charts, Marketplace and Create are not built yet: they only show a "Coming soon" message.
    function isComingSoon(a) {
        if (/^(nav-marketplace-|header-develop-)/.test(a.id || '')) return true;
        var h = a.getAttribute && a.getAttribute('href');
        if (!h || h.charAt(0) === '#') return false;
        var u;
        try { u = new URL(h, window.location.href); } catch (e) { return false; }
        if (/charts\.devtools$/.test(u.pathname)) return true;
        if (/(^|\.)create\.roblox\.com$/.test(u.hostname)) return true;
        if (/^\/(catalog|charts|upgrades\/paymentmethods)(\/|$)/.test(u.pathname)) return true;
        return false;
    }
    // Left-nav / footer items that are not built yet: Inventory, Trade, Communities, Newsroom, Official Store, Buy Gift Cards
    var SOON_LABELS = /^(Inventory|Trade|Communities|Newsroom|Official Store|Buy Gift Cards|Gift Cards)$/i;
    function isSoonNavItem(el) {
        var item = el.closest && el.closest('#left-navigation-container a, #left-navigation-container button, .footer a, footer a');
        return !!item && SOON_LABELS.test((item.textContent || '').trim());
    }
    function isAvatarNav(el) {
        var a = el.closest && el.closest('#left-navigation-container a');
        return a && (a.textContent || '').trim() === 'Avatar' ? a : null;
    }
    document.addEventListener('click', function (e) {
        var plus = e.target.closest && e.target.closest('.rbxtest-plus');
        if (plus && readSession()) { e.preventDefault(); e.stopPropagation(); openSwitchAccounts(); return; }
        var plusNav = e.target.closest && e.target.closest('#left-navigation-container a, #left-navigation-container button');
        if (plusNav && (plusNav.textContent || '').trim() === 'FigureBlox Plus') { e.preventDefault(); e.stopPropagation(); toast('Coming soon'); return; }
        var av = isAvatarNav(e.target);
        if (av) { e.preventDefault(); e.stopPropagation(); toast('Coming soon'); return; }
        if (isSoonNavItem(e.target)) { e.preventDefault(); e.stopPropagation(); toast('Coming soon'); return; }
        var a = e.target.closest && e.target.closest('a[href]');
        if (a && isComingSoon(a)) { e.preventDefault(); e.stopPropagation(); toast('Coming soon'); return; }
        var rb = e.target.closest && e.target.closest('#navbar-robux');
        if (rb) { e.preventDefault(); e.stopPropagation(); window.location.href = 'robux.devtools'; return; }
        var target = a && routeFor(a);
        if (!target) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey || a.target === '_blank') window.open(target, '_blank');
        else window.location.href = target;
    }, true);

    // ---------- Keep nav links, unread badge and verified badge in sync ----------
    var BADGE_HTML = '<div class="foundation-web-badge flex items-center select-none gap-[var(--size-150)] radius-circle height-600 width-[fit-content] padding-x-small bg-system-contrast content-inverse-emphasis stroke-none"><span class="text-no-wrap text-truncate-split text-label-small padding-y-xsmall padding-x-xxsmall content-inverse-emphasis">0</span></div>';

    // ---------- Robux balance (everyone starts with 1,000,000) ----------
    var START_ROBUX = 1000000;
    function getRobux(acc) { acc = acc || currentAccount(); return acc && typeof acc.robux === 'number' ? acc.robux : START_ROBUX; }
    function setRobux(n) {
        var k = currentKey();
        if (!k) return;
        saveAccount(k, { robux: n });
        schedule();
        window.dispatchEvent(new CustomEvent('rbx-robux', { detail: n }));
    }
    function addRobux(n) { setRobux(getRobux() + n); }
    function fmtRobux(n) { return Number(n).toLocaleString('en-US'); }
    function compactRobux(n) {
        if (n >= 1e6) return (Math.round(n / 1e4) / 100) + 'M';
        if (n >= 1e4) return (Math.round(n / 100) / 10) + 'K';
        return fmtRobux(n);
    }

    // ---------- Header icons (search, notifications, Robux, settings) on every page ----------
    var ICONS_HTML =
        '<li class="rbx-navbar-right-search"><button type="button" class="rbx-menu-item btn-navigation-nav-search-white-md" aria-label="Search"><span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-regular-magnifying-glass size-[var(--icon-size-xlarge)] [vertical-align:middle]"></span></button></li>' +
        '<li id="navbar-stream" class="navbar-icon-item navbar-stream notification-margins"><button type="button" class="btn-uiblox-common-common-notification-bell-md" aria-label="Notifications" aria-haspopup="true" aria-expanded="false" data-state="closed"><span class="nav-robux-icon rbx-menu-item"><div class="notification-stream-indicator"><span id="nav-ns-icon" class="rbx-menu-item notification-stream-icon"><span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-regular-bell size-[var(--icon-size-xlarge)] [vertical-align:middle]" id="common-notification-bell"></span></span></div></span></button></li>' +
        '<li id="navbar-robux" class="navbar-icon-item"><button type="button" class="btn-navigation-nav-robux-md" aria-label="Robux" aria-haspopup="true" aria-expanded="false" data-state="closed"><span id="nav-robux-icon" class="nav-robux-icon rbx-menu-item"><span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-regular-robux size-[var(--icon-size-xlarge)] [vertical-align:middle]" id="nav-robux"></span><span class="rbx-text-navbar-right text-header" id="nav-robux-amount">0</span><span class="notification-red robux-badge hidden"></span></span></button></li>' +
        '<li id="navbar-settings" class="navbar-icon-item"><button type="button" class="btn-navigation-nav-settings-md" aria-label="Settings" aria-haspopup="true" aria-expanded="false" data-state="closed"><span id="settings-icon" class="nav-settings-icon rbx-menu-item" aria-hidden="true"><span aria-hidden="true" data-testid="foundation-web-icon" class="grow-0 shrink-0 basis-auto icon icon-regular-gear size-[var(--icon-size-xlarge)] [vertical-align:middle]" id="nav-settings"></span><span class="notification-red notification nav-setting-highlight hidden">0</span></span></button></li>';
    function ensureHeaderIcons() {
        var ul = document.querySelector('ul.rbx-navbar-icon-group');
        if (ul && !ul.querySelector('#navbar-robux')) {
            var have = {};
            ul.querySelectorAll('li').forEach(function (li) { have[li.id || li.className] = 1; });
            ul.insertAdjacentHTML('beforeend', ICONS_HTML);
        }
        var skip = document.getElementById('skip-to-main-content');
        if (skip) skip.remove();
    }

    // Settings menu + notification panel. The home page ships its own copy, so only other pages use this one.
    function initPopups() {
        if (document.getElementById('rbxtest-home-extras')) return;
        var open = null;
        function closePopup() { if (open) { open.node.remove(); open = null; } }
        var BOX = 'position:fixed;z-index:1050;border:1px solid rgba(128,128,128,.4);border-radius:12px;background:var(--color-surface-0,#fff);color:var(--color-content-default,inherit);box-shadow:0 8px 24px rgba(0,0,0,.25);';
        function item(label, onClick) {
            var n = document.createElement('button');
            n.type = 'button'; n.setAttribute('role', 'menuitem');
            n.style.cssText = 'display:flex;align-items:center;width:100%;box-sizing:border-box;padding:12px 16px;border:0;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;white-space:nowrap;';
            n.textContent = label;
            n.addEventListener('mouseenter', function () { n.style.background = 'rgba(128,128,128,.18)'; });
            n.addEventListener('mouseleave', function () { n.style.background = 'none'; });
            n.addEventListener('click', function () { closePopup(); onClick(); });
            return n;
        }
        function soon() { toast('Coming soon'); }
        function settingsMenu() {
            var m = document.createElement('div');
            m.setAttribute('role', 'menu'); m.style.cssText = BOX + 'min-width:220px;padding:6px;';
            [item('Settings', soon), item('Quick Sign In', soon),
             item('Help & Safety', function () { window.open('https://www.roblox.com/help-safety', '_blank'); }),
             item('Switch Accounts', openSwitchAccounts),
             item('Logout', function () { markOffline(); var cs = readSession(); if (cs) forgetAccount(cs.username); sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY); window.location.href = 'index.html'; })
            ].forEach(function (i) { m.appendChild(i); });
            return m;
        }
        function notificationsPanel() { return buildNotificationsPanel(BOX); }
        document.addEventListener('click', function (e) {
            var t = e.target.closest ? e.target : e.target.parentElement;
            if (!t) return;
            var gear = t.closest('#navbar-settings'), bell = t.closest('#navbar-stream');
            if (!gear && !bell) { if (!t.closest('#rbxtest-gear-menu, #rbxtest-notifications')) closePopup(); return; }
            e.preventDefault(); e.stopPropagation();
            var id = gear ? 'rbxtest-gear-menu' : 'rbxtest-notifications';
            var same = open && open.id === id;
            closePopup();
            if (same) return;
            var node = gear ? settingsMenu() : notificationsPanel();
            node.id = id;
            document.body.appendChild(node);
            var r = (gear || bell).getBoundingClientRect();
            node.style.top = (r.bottom + 6) + 'px';
            node.style.left = Math.max(8, Math.min(r.right - node.offsetWidth, window.innerWidth - node.offsetWidth - 8)) + 'px';
            open = { id: id, node: node };
        }, true);
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePopup(); });
        window.addEventListener('resize', closePopup);
    }
    // Highlight the left-nav item for the page that is open (a light dark-grey background); "Coming soon" items never get it.
    var PAGE_LABEL = { 'home.devtools': 'Home', 'profileview.devtools': 'Profile', 'messages.devtools': 'Messages', 'friends.devtools': 'Friends', 'plus.devtools': 'FigureBlox Plus', 'avatar.devtools': 'Avatar' };
    function markActiveNav() {
        var page = (location.pathname.split('/').pop() || '').toLowerCase();
        var label = PAGE_LABEL[page] || null;
        if (page === 'profileview.devtools') {
            var u = (new URLSearchParams(location.search).get('u') || '').toLowerCase();
            if (u && u !== String(currentKey() || '').toLowerCase()) label = null;
        }
        document.querySelectorAll('#left-navigation-container nav a').forEach(function (a) {
            var t = (a.textContent || '').trim();
            var on = !!label && t === label;
            if (a.classList.contains('bg-shift-200') !== on) a.classList.toggle('bg-shift-200', on);
        });
    }
    function sync() {
        markActiveNav();
        ensureHeaderIcons();
        var bal = document.querySelectorAll('#nav-robux-amount');
        if (bal.length) { var bt = compactRobux(getRobux()); bal.forEach(function (el) { if (el.textContent !== bt) el.textContent = bt; }); }
        document.querySelectorAll('#left-navigation-container a').forEach(function (a) {
            if ((a.textContent || '').trim() === 'Avatar' && a.getAttribute('href') !== 'avatar.devtools') a.setAttribute('href', 'avatar.devtools');
        });
        document.querySelectorAll('a[href]').forEach(function (a) {
            var target = routeFor(a);
            if (target) a.setAttribute('href', target);
        });
        var acc = currentAccount();
        var news = unreadNews(acc);
        document.querySelectorAll('#navbar-stream button').forEach(function (btn) {
            var b = btn.querySelector('.rbxtest-bell-badge');
            if (!news) { if (b) b.remove(); return; }
            if (!b) { b = document.createElement('span'); b.className = 'rbxtest-bell-badge'; btn.appendChild(b); }
            var t = String(news > 99 ? '99+' : news);
            if (b.textContent !== t) b.textContent = t;
        });
        var unread = unreadCount(acc);
        document.querySelectorAll('a[href$="messages.devtools"]').forEach(function (a) {
            if (!/^\s*Messages/.test(a.textContent)) return;   // only the nav item, not other links
            var badge = a.querySelector('.foundation-web-badge');
            if (!unread) { if (badge) badge.remove(); return; }
            if (!badge) {
                var wrap = document.createElement('span');
                wrap.className = 'fill basis-auto padding-x-small flex justify-end items-center';
                wrap.innerHTML = BADGE_HTML;
                a.appendChild(wrap);
                badge = wrap.firstChild;
            }
            var label = badge.querySelector('.text-label-small');
            if (label && label.textContent !== String(unread)) label.textContent = String(unread);
        });
        if (acc) {   // show this account's name (display name) and @handle wherever a page marks them
            var dn = displayName(acc);
            document.querySelectorAll('[data-rbx-username]').forEach(function (el) { if (el.textContent !== dn) el.textContent = dn; });
            document.querySelectorAll('[data-rbx-handle]').forEach(function (el) { if (el.textContent !== '@' + acc.username) el.textContent = '@' + acc.username; });
        }
        document.querySelectorAll('[data-rbx-username], #rbxtest-username').forEach(function (el) {
            if (el.closest('#edit-user-profile-web-app')) return;
            var n = el.nextElementSibling;
            if (isVerified(acc) && !(n && n.classList.contains('rbxtest-verified'))) {
                el.insertAdjacentHTML('afterend', VERIFIED_HTML);
                n = el.nextElementSibling;
            }
            if (n && n.classList.contains('rbxtest-verified')) n = n.nextElementSibling;
            if (!(n && n.classList.contains('rbxtest-plus'))) {
                var anchor = el.nextElementSibling && el.nextElementSibling.classList.contains('rbxtest-verified') ? el.nextElementSibling : el;
                anchor.insertAdjacentHTML('afterend', PLUS_HTML);
            }
        });
    }
    var queued = false;
    function schedule() {
        if (queued) return;
        queued = true;
        (window.requestAnimationFrame || setTimeout)(function () { queued = false; sync(); });
    }
    // ---------- Chat bar (bottom-right): your chats + the friends you can chat with; the pencil makes a chat group ----------
    //   rbxtest_chats = { id: { id, type:'dm'|'group', name, members:[accountKeys], created, messages:[{from,text,date,system?}], reads:{key:count} } }
    //   Only FRIENDS can be chatted with. Everything is stored in localStorage, so open tabs of the same browser update instantly.
    var CHATS_KEY = 'rbxtest_chats', CHAT_OPEN_KEY = 'rbxtest_chat_open', MAX_GROUP = 5;
    var chatUI = { windows: [], dialog: null };
    var chatRoot = null, chatWins = null;
    var CHAT_SURFACE = 'background:var(--color-surface-100,var(--color-surface-0,#232527));color:var(--color-content-default,#f7f7f8);border:1px solid rgba(128,128,128,.4);box-shadow:0 4px 18px rgba(0,0,0,.35);';
    var PENCIL_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 8 16l1.2-4z"/></svg>';
    var NO_FRIENDS_MSG = 'You currently have no friends to chat with!';

    function readChats() { var c = readJSON(localStorage, CHATS_KEY, {}); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; }
    function writeChats(c) { try { localStorage.setItem(CHATS_KEY, JSON.stringify(c)); } catch (e) {} }
    function dmId(a, b) { return 'dm:' + [keyOf(a), keyOf(b)].sort().join('|'); }
    function getChat(id) {
        var c = readChats()[id];
        if (c) return c;
        if (/^dm:/.test(id)) return { id: id, type: 'dm', members: id.slice(3).split('|'), messages: [], reads: {}, virtual: true };   // a chat that has no messages yet
        return null;
    }
    function otherOf(c, me) { return (c.members || []).filter(function (m) { return m !== me; })[0] || me; }
    function chatTitle(c, me) {
        if (c.type === 'group') return c.name || 'Chat Group';
        var a = readAccounts()[otherOf(c, me)];
        return a ? displayName(a) : otherOf(c, me);
    }
    function chatAvatar(c, me) { return avatarFor(readAccounts()[otherOf(c, me)]); }
    function chatUnread(c, me) {
        var from = (c.reads && c.reads[me]) || 0;
        return (c.messages || []).slice(from).filter(function (m) { return !m.system && m.from !== me; }).length;
    }
    function lastTime(c) { var m = (c.messages || [])[(c.messages || []).length - 1]; return new Date(m ? m.date : c.created || 0).getTime() || 0; }
    function myChats(me) {
        var all = readChats(), accs = readAccounts();
        return Object.keys(all).map(function (k) { return all[k]; }).filter(function (c) {
            if (!c || (c.members || []).indexOf(me) === -1) return false;
            if (c.type === 'dm') { if (!(c.messages || []).length || isBanned(accs[otherOf(c, me)])) return false; }
            return true;
        }).sort(function (a, b) { return lastTime(b) - lastTime(a); });
    }
    function myFriends(me) {
        var accs = readAccounts();
        return friendsOf(accs[me]).map(function (u) { return accs[u]; }).filter(function (a) { return a && !isBanned(a); });
    }
    function fmtClock(iso) {
        var d = new Date(iso); if (isNaN(d.getTime())) return '';
        var h = d.getHours(), ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
        return h + ':' + ('0' + d.getMinutes()).slice(-2) + ' ' + ap;
    }
    function sendChat(id, text) {
        var me = currentKey(); text = String(text || '').trim().slice(0, 500);
        if (!me || !text) return;
        var all = readChats(), c = all[id];
        if (!c) {
            var v = getChat(id);
            if (!v || v.members.indexOf(me) === -1 || !isFriend(readAccounts()[me], otherOf(v, me))) return;   // only friends can chat
            c = all[id] = { id: id, type: 'dm', members: v.members, created: new Date().toISOString(), messages: [], reads: {} };
        }
        c.messages.push({ from: me, text: text, date: new Date().toISOString() });
        c.reads = c.reads || {}; c.reads[me] = c.messages.length;
        writeChats(all);
        renderChat();
    }
    function chatOpen() { try { return sessionStorage.getItem(CHAT_OPEN_KEY) === '1'; } catch (e) { return false; } }
    function setChatOpen(v) { try { sessionStorage.setItem(CHAT_OPEN_KEY, v ? '1' : '0'); } catch (e) {} }

    function chatRow(attr, img, title, sub, badge) {
        return '<div role="button" tabindex="0" ' + attr + ' class="react-chat-row" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;">' +
            '<span class="react-chat-avatar-headshot" style="flex:none;width:36px;height:36px;border-radius:50%;overflow:hidden;background:rgba(128,128,128,.3);display:block;"><img alt="" src="' + esc(img) + '" style="width:100%;height:100%;object-fit:cover;display:block;"></span>' +
            '<span style="min-width:0;flex:1;"><span style="display:block;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(title) + '</span>' +
            '<span style="display:block;font-size:12px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(sub) + '</span></span>' + (badge || '') + '</div>';
    }
    function sectionTitle(t) { return '<div style="padding:8px 12px 4px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.6;">' + t + '</div>'; }

    function renderBar() {
        var me = currentKey();
        if (!chatRoot) return;
        if (!me || !readAccounts()[me]) { chatRoot.innerHTML = ''; return; }
        var open = chatOpen(), chats = myChats(me), friends = myFriends(me);
        var unread = chats.reduce(function (n, c) { return n + chatUnread(c, me); }, 0);
        var oldList = chatRoot.querySelector('.react-chat-list'), keepScroll = oldList ? oldList.scrollTop : 0;
        var body = '';
        if (open) {
            if (!friends.length) {
                body = '<div class="react-chat-list" style="flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-size:14px;opacity:.8;">' + NO_FRIENDS_MSG + '</div>';
            } else {
                body = '<div class="react-chat-list" style="flex:1;min-height:0;overflow-y:auto;">' +
                    (chats.length ? sectionTitle('Chats') + chats.map(function (c) {
                        var m = (c.messages || [])[(c.messages || []).length - 1], u = chatUnread(c, me);
                        var sub = m ? (m.system ? m.text : (m.from === me ? 'You: ' : '') + m.text) : 'No messages yet';
                        return chatRow('data-open-chat="' + esc(c.id) + '"', chatAvatar(c, me), chatTitle(c, me), sub,
                            u ? '<span aria-label="Unread" style="flex:none;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#335fff;color:#fff;font:700 11px/18px sans-serif;text-align:center;">' + u + '</span>' : '');
                    }).join('') : '') +
                    sectionTitle('Friends') + friends.map(function (f) {
                        return chatRow('data-open-chat="' + esc(dmId(me, f.username)) + '"', avatarFor(f), displayName(f), isOnline(f.username) ? 'Online' : 'Offline',
                            isOnline(f.username) ? '<span style="flex:none;width:8px;height:8px;border-radius:50%;background:#00b06f;"></span>' : '');
                    }).join('') + '</div>';
            }
        }
        chatRoot.innerHTML = '<section class="react-chat-top-radius flex width-[286px] pointer-events-auto flex-col bg-surface-100 stroke-standard stroke-muted shadow-transient-low overflow-hidden clip height-[48px]" aria-label="Chat" ' +
            'style="pointer-events:auto;display:flex;flex-direction:column;width:286px;max-width:100%;box-sizing:border-box;height:' + (open ? '360px' : '48px') + ';overflow:hidden;border-radius:8px 8px 0 0;border-bottom:0;' + CHAT_SURFACE + '">' +
            '<div class="react-chat-top-radius flex width-full min-height-[48px] shrink-0 items-center justify-between gap-small bg-surface-100 padding-x-small padding-y-small cursor-pointer" data-chat-toggle role="button" tabindex="0" aria-expanded="' + open + '" ' +
            'style="display:flex;align-items:center;justify-content:space-between;gap:8px;min-height:48px;box-sizing:border-box;padding:0 8px 0 14px;cursor:pointer;flex:none;">' +
            '<div class="flex grow-1 items-center gap-small" style="display:flex;align-items:center;gap:8px;"><span class="text-title-medium content-emphasis" style="font-weight:700;font-size:16px;">Chat</span>' +
            (unread ? '<span aria-label="' + unread + ' unread" style="min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#e2231a;color:#fff;font:700 11px/18px sans-serif;text-align:center;">' + (unread > 99 ? '99+' : unread) + '</span>' : '') + '</div>' +
            '<button type="button" data-chat-new aria-label="Add at least 2 people to create chat group" title="New chat group" class="foundation-web-icon-button relative clip group/interactable cursor-pointer flex items-center justify-center padding-none stroke-none select-none size-800 radius-circle bg-action-link" ' +
            'style="display:flex;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:50%;background:none;color:inherit;cursor:pointer;padding:0;">' + PENCIL_SVG + '</button></div>' + body + '</section>';
        var nl = chatRoot.querySelector('.react-chat-list');
        if (nl && keepScroll) nl.scrollTop = keepScroll;
    }

    // ----- chat windows (one per open chat) and the New Chat Group dialog, left of the bar -----
    var WIN_CLS = 'react-chat-dialog-shell react-chat-top-radius flex width-[260px] height-[360px] pointer-events-auto flex-col overflow-hidden bg-surface-100 stroke-standard stroke-muted shadow-transient-high clip content-default';
    var WIN_STYLE = 'pointer-events:auto;display:flex;flex-direction:column;width:260px;height:360px;box-sizing:border-box;overflow:hidden;border-radius:8px 8px 0 0;border-bottom:0;' + CHAT_SURFACE;
    var INPUT_STYLE = 'flex:1;min-width:0;height:34px;box-sizing:border-box;padding:0 10px;border:1px solid rgba(128,128,128,.5);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:14px;outline:0;';
    var CLOSE_BTN = '<button type="button" data-win-close aria-label="Close" class="foundation-web-icon-button" style="flex:none;width:32px;height:32px;border:0;border-radius:50%;background:none;color:inherit;font-size:22px;line-height:1;cursor:pointer;">&times;</button>';
    function winHeader(title) { return '<div class="react-chat-top-radius flex width-full shrink-0 items-center justify-between gap-small padding-x-small padding-y-small" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 8px 8px 12px;flex:none;border-bottom:1px solid rgba(128,128,128,.25);"><span class="min-width-none text-title-medium content-emphasis text-truncate-end" data-win-title style="font-weight:700;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(title) + '</span>' + CLOSE_BTN + '</div>'; }
    function actionBtn(label, attr, primary) {
        return '<button type="button" ' + attr + ' class="foundation-web-button cursor-pointer relative flex items-center justify-center stroke-none select-none radius-medium text-label-small height-800 padding-x-small bg-action-standard content-action-standard" style="flex:1;height:34px;border:0;border-radius:8px;font:600 14px sans-serif;cursor:pointer;color:' + (primary ? '#fff' : 'inherit') + ';background:' + (primary ? '#335fff' : 'rgba(128,128,128,.25)') + ';">' + label + '</button>';
    }

    function buildWindow(id) {
        var me = currentKey(), c = getChat(id);
        var w = document.createElement('section');
        w.className = WIN_CLS; w.setAttribute('data-win', id); w.setAttribute('aria-label', chatTitle(c, me)); w.style.cssText = WIN_STYLE;
        w.innerHTML = winHeader(chatTitle(c, me)) +
            '<div data-msgs style="flex:1;min-height:0;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:6px;"></div>' +
            '<form data-send style="display:flex;gap:6px;padding:8px;border-top:1px solid rgba(128,128,128,.25);flex:none;"><input type="text" maxlength="500" placeholder="Send a message" autocomplete="off" aria-label="Message" style="' + INPUT_STYLE + '">' +
            '<button type="submit" style="flex:none;height:34px;padding:0 12px;border:0;border-radius:8px;background:#335fff;color:#fff;font:600 14px sans-serif;cursor:pointer;">Send</button></form>';
        return w;
    }
    function fillMessages(w, id) {
        var me = currentKey(), c = getChat(id);
        if (!c) return;
        var box = w.querySelector('[data-msgs]'), msgs = c.messages || [];
        var html = msgs.length ? msgs.map(function (m) {
            if (m.system) return '<div style="align-self:center;font-size:12px;opacity:.6;text-align:center;">' + esc(m.text) + '</div>';
            var mine = m.from === me, who = readAccounts()[m.from];
            return '<div style="max-width:80%;align-self:' + (mine ? 'flex-end' : 'flex-start') + ';">' +
                (!mine && c.type === 'group' ? '<div style="font-size:11px;opacity:.6;margin:0 4px 2px;">' + esc(displayName(who) || m.from) + '</div>' : '') +
                '<div title="' + esc(fmtClock(m.date)) + '" style="padding:7px 11px;border-radius:14px;font-size:14px;line-height:1.3;overflow-wrap:anywhere;white-space:pre-wrap;background:' + (mine ? '#335fff' : 'rgba(128,128,128,.28)') + ';color:' + (mine ? '#fff' : 'inherit') + ';">' + esc(m.text) + '</div></div>';
        }).join('') : '<div style="margin:auto;opacity:.65;font-size:13px;text-align:center;">No messages yet. Say hi!</div>';
        if (box.__html !== html) {
            var stick = box.__html === undefined || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
            box.innerHTML = html; box.__html = html;
            if (stick) box.scrollTop = box.scrollHeight;
        }
        var t = w.querySelector('[data-win-title]'), title = chatTitle(c, me);
        if (t && t.textContent !== title) t.textContent = title;
        var stored = readChats()[id];   // opening a chat marks it read
        if (stored && ((stored.reads || {})[me] || 0) !== msgs.length) {
            var all = readChats(); all[id].reads = all[id].reads || {}; all[id].reads[me] = msgs.length; writeChats(all);
            renderBar();
        }
    }

    function buildDialog() {
        var w = document.createElement('section');
        w.className = WIN_CLS; w.setAttribute('data-win', 'dialog'); w.setAttribute('aria-label', 'New Chat Group'); w.style.cssText = WIN_STYLE;
        w.innerHTML = winHeader('New Chat Group') +
            '<div class="flex shrink-0 padding-x-small padding-bottom-small" style="display:flex;padding:8px 8px 0;flex:none;"><div data-testid="text-input-container" class="foundation-web-input flex items-center width-full stroke-standard bg-none height-800 radius-medium" style="display:flex;align-items:center;width:100%;">' +
            '<input type="text" data-dlg-name maxlength="30" placeholder="Name your chat group" aria-label="Name your chat group" autocomplete="off" style="' + INPUT_STYLE + '"></div></div>' +
            '<div class="flex shrink-0 padding-x-small padding-bottom-small" style="display:flex;padding:8px;flex:none;"><div data-testid="text-input-container" class="foundation-web-input flex items-center width-full stroke-standard bg-none height-800 radius-medium" style="display:flex;align-items:center;gap:6px;width:100%;border:1px solid rgba(128,128,128,.5);border-radius:8px;padding:0 10px;height:34px;box-sizing:border-box;">' +
            '<input type="text" data-dlg-search placeholder="Search for friends" aria-label="Search for friends" autocomplete="off" style="flex:1;min-width:0;border:0;background:none;color:inherit;font:inherit;font-size:14px;outline:0;padding:0;">' +
            '<span data-dlg-count class="shrink-0 text-caption-medium content-muted" style="flex:none;font-size:12px;opacity:.65;">(0/' + MAX_GROUP + ')</span></div></div>' +
            '<div class="react-chat-create-friend-list flex min-height-0 grow-1 flex-col scroll-y" data-dlg-list style="flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;"></div>' +
            '<div class="react-chat-details-action-footer flex shrink-0 gap-small bg-surface-100 padding-medium" style="display:flex;gap:8px;padding:10px;flex:none;border-top:1px solid rgba(128,128,128,.25);">' + actionBtn('Cancel', 'data-win-close') + actionBtn('Create', 'data-dlg-create disabled', true) + '</div>';
        return w;
    }
    function fillDialog(w) {
        var me = currentKey(), d = chatUI.dialog; if (!d) return;
        var friends = myFriends(me), q = d.q.trim().toLowerCase();
        d.sel = d.sel.filter(function (u) { return friends.some(function (f) { return keyOf(f.username) === u; }); });
        var shown = friends.filter(function (f) { return !q || String(f.username).toLowerCase().indexOf(q) !== -1 || displayName(f).toLowerCase().indexOf(q) !== -1; });
        var list = w.querySelector('[data-dlg-list]');
        var html = !friends.length ? '<div style="padding:24px 16px;text-align:center;font-size:14px;opacity:.8;">' + NO_FRIENDS_MSG + '</div>'
            : !shown.length ? '<div style="padding:24px 16px;text-align:center;font-size:14px;opacity:.7;">No friends found.</div>'
            : shown.map(function (f) {
                var k = keyOf(f.username), on = d.sel.indexOf(k) !== -1, full = !on && d.sel.length >= MAX_GROUP;
                return '<div role="checkbox" aria-checked="' + on + '" aria-label="' + esc(displayName(f)) + '" tabindex="0" data-pick="' + esc(k) + '" class="flex shrink-0 items-center gap-small padding-x-small padding-y-xsmall cursor-pointer hover:bg-shift-100" style="display:flex;align-items:center;gap:10px;padding:6px 10px;cursor:' + (full ? 'not-allowed' : 'pointer') + ';opacity:' + (full ? '.45' : '1') + ';">' +
                    '<span class="react-chat-avatar-headshot" style="flex:none;width:32px;height:32px;border-radius:50%;overflow:hidden;background:rgba(128,128,128,.3);display:block;"><img alt="" src="' + esc(avatarFor(f)) + '" style="width:100%;height:100%;object-fit:cover;display:block;"></span>' +
                    '<span style="min-width:0;flex:1;"><span style="display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(displayName(f)) + '</span><span style="display:block;font-size:12px;opacity:.6;">' + (isOnline(f.username) ? 'Online' : 'Offline') + '</span></span>' +
                    '<span aria-hidden="true" style="flex:none;width:18px;height:18px;box-sizing:border-box;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;border:2px solid rgba(128,128,128,.7);' + (on ? 'background:#335fff;border-color:#335fff;' : '') + '">' + (on ? '&#10003;' : '') + '</span></div>';
            }).join('');
        if (list.__html !== html) { var st = list.scrollTop; list.innerHTML = html; list.__html = html; list.scrollTop = st; }
        w.querySelector('[data-dlg-count]').textContent = '(' + d.sel.length + '/' + MAX_GROUP + ')';
        var btn = w.querySelector('[data-dlg-create]'), ready = d.sel.length >= 2;   // a group needs at least 2 friends
        btn.disabled = !ready; btn.style.opacity = ready ? '1' : '.5'; btn.style.cursor = ready ? 'pointer' : 'not-allowed';
    }
    function createGroup() {
        var me = currentKey(), d = chatUI.dialog, accs = readAccounts();
        if (!me || !d || d.sel.length < 2) return;
        var name = d.name.trim() || d.sel.slice(0, 3).map(function (u) { return displayName(accs[u]) || u; }).join(', ');
        var id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), now = new Date().toISOString();
        var all = readChats();
        all[id] = { id: id, type: 'group', name: name.slice(0, 30), members: [me].concat(d.sel), created: now, reads: {}, messages: [{ system: true, text: displayName(accs[me]) + ' created the group.', date: now }] };
        all[id].reads[me] = 1;
        writeChats(all);
        chatUI.dialog = null;
        openChatWindow(id);
    }

    function renderWindows(focusId) {
        if (!chatWins) return;
        var me = currentKey();
        if (!me) { chatWins.innerHTML = ''; return; }
        chatUI.windows = chatUI.windows.filter(function (id) { var c = getChat(id); return c && c.members.indexOf(me) !== -1; });
        var want = (chatUI.dialog ? ['dialog'] : []).concat(chatUI.windows.slice().reverse());   // row-reverse: first = right next to the bar
        Array.prototype.slice.call(chatWins.children).forEach(function (n) { if (want.indexOf(n.getAttribute('data-win')) === -1) n.remove(); });
        want.forEach(function (id) {
            var n = chatWins.querySelector('[data-win="' + id.replace(/"/g, '') + '"]');
            if (!n) n = id === 'dialog' ? buildDialog() : buildWindow(id);
            chatWins.appendChild(n);   // appending keeps the right order
            if (id === 'dialog') fillDialog(n); else fillMessages(n, id);
        });
        if (focusId) {
            var f = chatWins.querySelector('[data-win="' + focusId + '"] input');
            if (f) f.focus();
        }
    }
    function renderChat() { renderBar(); renderWindows(); }
    function openChatWindow(id) {
        chatUI.windows = chatUI.windows.filter(function (x) { return x !== id; });
        chatUI.windows.push(id);
        while (chatUI.windows.length > 2) chatUI.windows.shift();
        renderBar(); renderWindows(id);
    }
    function toggleDialog() {
        if (chatUI.dialog) { chatUI.dialog = null; return renderWindows(); }
        chatUI.dialog = { name: '', q: '', sel: [] };
        renderWindows('dialog');
        var f = chatWins.querySelector('[data-dlg-name]'); if (f) f.focus();
    }
    function closeWin(w) {
        var id = w && w.getAttribute('data-win');
        if (id === 'dialog') chatUI.dialog = null; else chatUI.windows = chatUI.windows.filter(function (x) { return x !== id; });
        renderWindows();
    }

    function initChat() {
        if (chatRoot || !document.body || !readSession() || !currentAccount()) return;
        chatRoot = document.createElement('div'); chatRoot.id = 'rbxtest-chat';
        chatRoot.style.cssText = 'position:fixed;bottom:0;right:16px;width:286px;max-width:calc(100vw - 16px);z-index:1000;pointer-events:none;';
        chatWins = document.createElement('div'); chatWins.id = 'rbxtest-chat-windows';
        chatWins.style.cssText = 'position:fixed;bottom:0;right:calc(286px + 24px);max-width:calc(100vw - 320px);display:flex;flex-direction:row-reverse;align-items:flex-end;gap:8px;z-index:1000;pointer-events:none;';
        document.body.appendChild(chatWins); document.body.appendChild(chatRoot);

        chatRoot.addEventListener('click', function (e) {
            var t = e.target; if (!t.closest) return;
            if (t.closest('[data-chat-new]')) { e.stopPropagation(); return toggleDialog(); }   // the pencil does not open/close the bar
            if (t.closest('[data-chat-toggle]')) { setChatOpen(!chatOpen()); return renderBar(); }
            var row = t.closest('[data-open-chat]');
            if (row) openChatWindow(row.getAttribute('data-open-chat'));
        });
        chatRoot.addEventListener('keydown', function (e) {
            if ((e.key !== 'Enter' && e.key !== ' ') || !e.target.closest) return;
            var el = e.target.closest('[data-chat-toggle], [data-open-chat]');
            if (el && e.target === el) { e.preventDefault(); el.click(); }
        });
        chatWins.addEventListener('click', function (e) {
            var t = e.target; if (!t.closest) return;
            var w = t.closest('[data-win]'); if (!w) return;
            if (t.closest('[data-win-close]')) return closeWin(w);
            if (t.closest('[data-dlg-create]')) return createGroup();
            var pick = t.closest('[data-pick]');
            if (pick && chatUI.dialog) {
                var k = pick.getAttribute('data-pick'), s = chatUI.dialog.sel, i = s.indexOf(k);
                if (i !== -1) s.splice(i, 1); else if (s.length < MAX_GROUP) s.push(k);
                fillDialog(w);
            }
        });
        chatWins.addEventListener('keydown', function (e) {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.hasAttribute && e.target.hasAttribute('data-pick')) { e.preventDefault(); e.target.click(); }
        });
        chatWins.addEventListener('input', function (e) {
            var t = e.target, w = t.closest && t.closest('[data-win="dialog"]');
            if (!w || !chatUI.dialog) return;
            if (t.hasAttribute('data-dlg-name')) chatUI.dialog.name = t.value;
            if (t.hasAttribute('data-dlg-search')) { chatUI.dialog.q = t.value; fillDialog(w); }
        });
        chatWins.addEventListener('submit', function (e) {
            var f = e.target.closest && e.target.closest('form[data-send]'); if (!f) return;
            e.preventDefault();
            var input = f.querySelector('input'), id = f.closest('[data-win]').getAttribute('data-win');
            var v = input.value; input.value = '';
            sendChat(id, v);
            var again = chatWins.querySelector('[data-win="' + id + '"] input'); if (again) again.focus();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && chatUI.dialog) { chatUI.dialog = null; renderWindows(); } });
        window.addEventListener('storage', renderChat);   // another tab sent a message / made a group / added a friend: show it now
        setInterval(function () { if (!document.hidden) renderChat(); }, 5000);   // keeps Online / Offline fresh
        renderChat();
    }

    // ---------- FigureBlox account only: "Press F5 for your mod menu!" reminder + F5 key ----------
    // The reminder appears the moment FigureBlox logs in (typed password OR an automatic login from a saved session).
    // It is tied to the login's session token, so it shows once per login, not on every page change.
    // F5 does nothing yet (no refresh, no menu): set rbxShell.openModMenu = function () {...} later to give it a job.
    var MODHINT_KEY = 'rbxtest_modhint_token';
    function isModAccount(acc) { return !!acc && String(acc.username).toLowerCase() === 'figureblox'; }
    function showModHint() {
        if (!document.body || document.getElementById('rbxtest-modhint')) return;
        var s = readSession(), acc = currentAccount();
        if (!s || !isModAccount(acc)) return;
        try {
            if (sessionStorage.getItem(MODHINT_KEY) === s.token) return;   // already shown for this login
            sessionStorage.setItem(MODHINT_KEY, s.token);
        } catch (e) {}
        var n = document.createElement('div');
        n.id = 'rbxtest-modhint';
        n.setAttribute('role', 'status');
        n.style.cssText = 'position:fixed;top:72px;left:50%;transform:translate(-50%,-12px);opacity:0;transition:opacity .25s,transform .25s;z-index:2147483100;' +
            'display:flex;align-items:center;gap:14px;max-width:calc(100vw - 24px);box-sizing:border-box;background:#232527;color:#fff;padding:14px 16px 14px 20px;border-radius:10px;' +
            'border:1px solid #335fff;box-shadow:0 8px 28px rgba(0,0,0,.5);font:600 15px/1.3 sans-serif;';
        n.innerHTML = '<span>Press <b style=\"background:#335fff;border-radius:5px;padding:2px 7px;\">F5</b> for your mod menu!</span>' +
            '<button type=\"button\" aria-label=\"Close\" style=\"flex:none;background:none;border:0;color:#bdbebe;font-size:22px;line-height:1;cursor:pointer;padding:0 2px;\">&times;</button>';
        document.body.appendChild(n);
        var gone = false;
        function close() { if (gone) return; gone = true; n.style.opacity = '0'; n.style.transform = 'translate(-50%,-12px)'; setTimeout(function () { n.remove(); }, 300); }
        n.querySelector('button').addEventListener('click', close);
        requestAnimationFrame(function () { requestAnimationFrame(function () { n.style.opacity = '1'; n.style.transform = 'translate(-50%,0)'; }); });
        setTimeout(close, 8000);
    }
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'F5' || !isModAccount(currentAccount())) return;
        e.preventDefault();   // F5 is reserved for the mod menu, so it does not refresh the page
        if (typeof window.rbxShell.openModMenu === 'function') window.rbxShell.openModMenu();
    }, true);

    // ---------- Monthly Robux: once per calendar month a pop-up pays out 50,000 Robux ----------
    var MONTHLY = 50000;
    function monthlyCheck() {
        if (!document.body || document.getElementById('rbxtest-monthly')) return;
        var key = currentKey(), acc = currentAccount();
        if (!key || !acc) return;
        var d = new Date(), stamp = d.getFullYear() + '-' + (d.getMonth() + 1);
        if (acc.lastMonthlyRobux === stamp) return;
        var start = typeof acc.robux === 'number' ? acc.robux : START_ROBUX;
        saveAccount(key, { robux: start + MONTHLY, lastMonthlyRobux: stamp });
        schedule();
        window.dispatchEvent(new CustomEvent('rbx-robux', { detail: start + MONTHLY }));
        var o = document.createElement('div');
        o.id = 'rbxtest-monthly';
        o.style.cssText = 'position:fixed;inset:0;z-index:2147482000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
        o.innerHTML = '<div role="dialog" aria-modal="true" aria-labelledby="rbxtest-monthly-title" style="background:#232527;color:#f7f7f8;border-radius:12px;padding:28px 24px;max-width:380px;width:100%;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.5);font-family:inherit;">' +
            '<div style="font-size:32px;line-height:1;">' + PLUS_HTML.replace('margin-left:4px;', '') + '</div>' +
            '<h2 id="rbxtest-monthly-title" style="margin:12px 0 8px;font-size:22px;">Your Monthly Robux</h2>' +
            '<p style="margin:0 0 20px;font-size:15px;line-height:22px;">You received <b>' + fmtRobux(MONTHLY) + ' Robux</b> from FigureBlox Plus. Your balance has been updated.</p>' +
            '<button type="button" style="cursor:pointer;border:0;border-radius:8px;background:#335fff;color:#fff;font:600 15px sans-serif;padding:12px 32px;">OK</button></div>';
        o.querySelector('button').addEventListener('click', function () { o.remove(); });
        document.body.appendChild(o);
    }
    function start() {
        try { var cs = readSession(); if (cs && readAccounts()[cs.username]) rememberSession(cs); } catch (e) {}   // every logged-in account is listed in Switch Accounts
        if (!document.getElementById('rbxtest-shell-style')) {
            var st = document.createElement('style');
            st.id = 'rbxtest-shell-style';
            st.textContent = '#navbar-stream > button{position:relative;} .rbxtest-bell-badge{position:absolute;top:-4px;right:-6px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:#e2231a;color:#fff;font:700 11px/16px sans-serif;text-align:center;pointer-events:none;}';
            document.head.appendChild(st);
        }
        beat(); setInterval(beat, BEAT_MS);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) beat(); });
        showModHint();
        initChat();
        setTimeout(monthlyCheck, 600);
        initPopups();
        sync();
        new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
    window.addEventListener('storage', schedule);
    window.addEventListener('pageshow', schedule);

    window.rbxShell = {
        readAccounts: readAccounts, currentAccount: currentAccount, currentKey: currentKey, saveAccount: saveAccount,
        displayName: displayName, isVerified: isVerified, verifiedHTML: VERIFIED_HTML, unreadCount: unreadCount,
        openSwitchAccounts: openSwitchAccounts, buildNotificationsPanel: buildNotificationsPanel, rememberSession: rememberSession, forgetAccount: forgetAccount, unreadNews: unreadNews,
        plusHTML: PLUS_HTML, friendsOf: friendsOf, pendingRequests: pendingRequests, isFriend: isFriend, sendFriendRequest: sendFriendRequest, acceptRequest: acceptRequest, declineRequest: declineRequest,
        readPosts: readPosts, addPost: addPost, isPoster: isPoster, isOnline: isOnline, markOffline: markOffline,
        openChat: openChatWindow, dmId: dmId,
        isBanned: isBanned, visibleAccounts: visibleAccounts, isModAccount: isModAccount, openModMenu: null,
        fmtDate: fmtDate, toast: toast, getRobux: getRobux, addRobux: addRobux, fmtRobux: fmtRobux, compactRobux: compactRobux, requireLogin: requireLogin, esc: esc, sync: sync
    };
})();
