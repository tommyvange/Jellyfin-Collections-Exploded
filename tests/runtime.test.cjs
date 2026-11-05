const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSettings, contentQuery, createQueue, discoverCollections, createAdapter, createRuntime } = require('../src/Jellyfin.Plugin.CollectionsExploded/Web/collections-exploded.js');

const settings = { enabled: true, maxItemsPerCollection: 20, sortBy: 'ProductionYear', sortOrder: 'Ascending' };
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

class Node {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.attributes = {}; this.listeners = new Map(); this._text = ''; this._class = ''; this.isDocument = false; }
    get className() { return this._class; }
    set className(value) { this._class = value; }
    get classList() {
        const self = this;
        return {
            add(...names) { self._class = [...new Set([...self._class.split(/\s+/).filter(Boolean), ...names])].join(' '); },
            remove(...names) { self._class = self._class.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
            contains(name) { return self._class.split(/\s+/).includes(name); }
        };
    }
    get textContent() { return this._text + this.childNodes.map(child => child.textContent).join(''); }
    set textContent(value) { this.replaceChildren(); this._text = String(value); }
    get isConnected() { return this.isDocument || !!(this.parentNode && this.parentNode.isConnected); }
    appendChild(child) { if (child.parentNode) child.remove(); this.childNodes.push(child); child.parentNode = this; return child; }
    insertBefore(child, before) { const index = this.childNodes.indexOf(before); assert.ok(index >= 0); child.parentNode = this; this.childNodes.splice(index, 0, child); return child; }
    replaceChildren(...children) { this.childNodes.forEach(child => { child.parentNode = null; }); this.childNodes = []; this._text = ''; children.forEach(child => this.appendChild(child)); }
    remove() { if (this.parentNode) { this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1); this.parentNode = null; } }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = value; if (name === 'id') this.id = value; }
    getAttribute(name) { return this.attributes[name]; }
    matches(selector) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : selector.startsWith('#') ? this.id === selector.slice(1) : this.tagName === selector.toUpperCase(); }
    querySelectorAll(selector) { return this.childNodes.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(name, callback, options) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push({ callback, once: options && options.once }); }
    removeEventListener(name, callback) { this.listeners.set(name, (this.listeners.get(name) || []).filter(entry => entry.callback !== callback)); }
    dispatchEvent(event) {
        if (!event.target) event.target = this;
        for (const entry of [...(this.listeners.get(event.type) || [])]) { entry.callback.call(this, event); if (entry.once) this.removeEventListener(event.type, entry.callback); }
        if (event.bubbles && this.parentNode) this.parentNode.dispatchEvent(event);
    }
}

function environment(respond = () => ({ Items: [], TotalRecordCount: 0 })) {
    const document = new Node('document'); document.isDocument = true;
    const scrollers = [];
    document.createElement = (tag, options) => {
        const node = new Node(tag);
        const type = typeof options === 'string' ? options : options && options.is;
        if (type) node.setAttribute('is', type);
        if (type === 'emby-scroller') {
            const controller = { destroys: 0, destroy() { this.destroys++; } };
            node.scroller = controller;
            scrollers.push(controller);
        }
        return node;
    };
    const events = new Node('window');
    const timers = new Map(); let timer = 0;
    const calls = [];
    const auth = { user: 'viewer', token: 'secret', server: 'server-a', version: '12.4.0' };
    const window = {
        document, location: new URL('https://media.example/jellyfin/web/#/details?id=movie'),
        setInterval(fn) { const id = ++timer; timers.set(id, fn); return id; }, clearInterval(id) { timers.delete(id); },
        addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        Emby: { Page: { getRouteUrl: (item, options) => '#/details?id=' + encodeURIComponent(item.Id) + '&serverId=' + encodeURIComponent(options.serverId) } }
    };
    const api = {
        getCurrentUserId: () => auth.user, accessToken: () => auth.token, serverId: () => auth.server, serverVersion: () => auth.version,
        getUrl(path, query) { const url = new URL('/jellyfin/' + path, window.location); for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value); return url.href; },
        getJSON(url) { const parsed = new URL(url); const path = parsed.pathname.replace('/jellyfin/', ''); const query = Object.fromEntries(parsed.searchParams); calls.push({ path, query }); return Promise.resolve().then(() => path === 'CollectionsExploded/Settings' ? { ...settings } : respond(path, query)); },
        logout() { auth.user = null; auth.token = null; return 'logged out'; },
        setAuthenticationInfo(token, user) { auth.token = token; auth.user = user; return this; },
        clearAuthenticationInfo() { this.setAuthenticationInfo(null, null); }
    };
    const cardCalls = [];
    window.JellyfinCollectionsExplodedNative = {
        version: 1,
        cardBuilder: {
            buildCards(items, options) {
                cardCalls.push({ items, options });
                const cards = items.map(item => {
                    const card = document.createElement('div'); card.className = 'card overflowPortraitCard';
                    const box = document.createElement('div'); box.className = 'cardBox visualCardBox';
                    const title = document.createElement('div'); title.className = 'cardText cardTextCentered';
                    title.textContent = item.Name || 'Untitled';
                    box.appendChild(title); card.appendChild(box); return card;
                });
                options.itemsContainer.replaceChildren(...cards);
            }
        }
    };
    window.ApiClient = api;
    function page() {
        const page = new Node(); page.className = 'itemDetailPage'; page.id = 'itemDetailPage';
        const native = new Node(); native.id = 'collectionsCollapsible'; native.className = 'hide';
        const source = new Node('select'); source.className = 'selectSource'; source.value = '';
        page.appendChild(source); page.appendChild(native); document.appendChild(page);
        return page;
    }
    return { window, document, api, auth, calls, cardCalls, scrollers, page, timers, tick: () => [...timers.values()].forEach(fn => fn()) };
}
const show = (page, id = 'movie', extra = {}) => page.dispatchEvent({ type: 'viewshow', bubbles: true, detail: { params: { id, serverId: 'server-a' }, ...extra } });
const hide = page => page.dispatchEvent({ type: 'viewbeforehide', bubbles: true });
const active = page => page.classList.contains('jfce-active');

test('effective settings clamp caps and retain safe defaults', () => {
    assert.equal(normalizeSettings({ ...settings, maxItemsPerCollection: 900 }).maxItemsPerCollection, 100);
    assert.equal(normalizeSettings({ ...settings, maxItemsPerCollection: -1 }).maxItemsPerCollection, 1);
    assert.deepEqual(normalizeSettings({ enabled: false, sortBy: 'Random', sortOrder: 'wrong' }), { ...settings, enabled: false });
    assert.throws(() => normalizeSettings({}), /Invalid/);
});

test('all eight sorts run on the server before the per-collection limit, with explicit title tie direction', () => {
    for (const sortBy of ['ProductionYear', 'SortName', 'DateCreated', 'PremiereDate']) {
        for (const sortOrder of ['Ascending', 'Descending']) {
            const query = contentQuery('collection', 'viewer', { ...settings, sortBy, sortOrder, maxItemsPerCollection: 1 });
            assert.equal(query.sortBy, sortBy === 'SortName' ? sortBy : sortBy + ',SortName');
            assert.equal(query.sortOrder, sortBy === 'SortName' ? sortOrder : sortOrder + ',Ascending');
            assert.equal(query.limit, 1); assert.equal(query.recursive, false); assert.equal(query.collapseBoxSetItems, false);
            assert.equal(query.userId, 'viewer'); assert.equal(query.parentId, 'collection');
            assert.equal(query.excludeItemIds, undefined); assert.equal(query.includeItemTypes, undefined);
        }
    }
});

test('membership discovery pages independently of card cap, deduplicates by ID and preserves duplicate names/order', async () => {
    const calls = [];
    const all = Array.from({ length: 205 }, (_, i) => ({ Id: String(i), Name: 'Same name' }));
    all[101] = all[99];
    const result = await discoverCollections({ async request(context, path, query) { calls.push({ context, path, query }); return { Items: all.slice(query.startIndex, query.startIndex + query.limit), TotalRecordCount: all.length }; } }, { itemId: 'movie', userId: 'viewer' }, () => true);
    assert.equal(result.length, 204); assert.deepEqual(calls.map(call => call.query.startIndex), [0, 100, 200]);
    assert.ok(calls.every(call => call.query.limit === 100 && call.query.userId === 'viewer'));
    assert.deepEqual(result.map(item => item.Id), [...new Set(all.map(item => item.Id))]);
});

test('late-page failure, incomplete pages and membership changes reject the complete discovery', async () => {
    const all = Array.from({ length: 100 }, (_, i) => ({ Id: String(i) }));
    for (const response of [() => { throw new Error('offline'); }, () => ({ Items: [], TotalRecordCount: 101 }), () => ({ Items: [{ Id: '100' }], TotalRecordCount: 102 })]) {
        const adapter = { async request(_c, _p, q) { return q.startIndex ? response() : { Items: all, TotalRecordCount: 101 }; } };
        await assert.rejects(discoverCollections(adapter, { itemId: 'movie' }, () => true));
    }
});

test('shared queue holds a four-request bound and cancels queued work before it starts', async () => {
    const queue = createQueue(4); const pending = []; const gates = []; let running = 0; let peak = 0;
    for (let i = 0; i < 9; i++) {
        const gate = deferred(); gates.push(gate);
        pending.push(queue.add(i < 6 ? 'old' : 'new', () => true, async () => { running++; peak = Math.max(peak, running); await gate.promise; running--; return i; }).catch(error => error.name));
    }
    await settle(); assert.equal(running, 4);
    queue.cancel('old'); gates.forEach(gate => gate.resolve());
    const results = await Promise.all(pending);
    assert.equal(peak, 4); assert.deepEqual(results.slice(4, 6), ['AbortError', 'AbortError']); assert.deepEqual(results.slice(6), [6, 7, 8]);
});

test('adapter validates versions, server/user identity, authenticated URL construction and base-path routes', async () => {
    const env = environment(); const adapter = createAdapter(env.window); const page = env.page();
    const context = adapter.capture(page, { serverId: 'server-a' }, 'movie');
    assert.ok(context); assert.equal(await adapter.supported(context), true);
    env.auth.version = '11.9.9'; assert.equal(await adapter.supported(context), false);
    env.auth.version = '13.0.0'; assert.equal(await adapter.supported(context), true);
    assert.equal(adapter.capture(page, { serverId: 'other' }, 'movie'), null);
    assert.equal(adapter.route(context, { Id: 'a&b' }), '#/details?id=a%26b&serverId=server-a');
    env.auth.user = 'other'; assert.equal(adapter.matches(context), false); await assert.rejects(adapter.request(context, 'Items'), { name: 'AbortError' });
});

test('one linked row per ID survives mixed successful, empty, failed previews and renders names as text', async () => {
    const collections = [{ Id: 'one', Name: '<img src=x onerror=bad()>' }, { Id: 'two', Name: 'Same' }, { Id: 'three', Name: 'Same' }];
    let failed = true;
    const env = environment((path, query) => {
        if (path.endsWith('/Collections')) return { Items: collections, TotalRecordCount: 3 };
        if (query.parentId === 'three' && failed) throw new Error('offline');
        return { Items: query.parentId === 'two' ? [] : [{ Id: 'movie', Name: '<b>A very long literal title</b>', ProductionYear: 2001, ImageTags: { Primary: 'tag' } }] };
    });
    const runtime = createRuntime(env.window); const page = env.page(); show(page); await settle();
    assert.equal(active(page), true); assert.equal(page.querySelectorAll('.jfce-row').length, 3);
    assert.equal(page.querySelectorAll('.sectionTitleTextButton').length, 3); assert.equal(page.querySelectorAll('.card').length, 1);
    assert.equal(page.querySelector('.sectionTitleTextButton').textContent, '<img src=x onerror=bad()>');
    assert.equal(page.querySelector('.cardText').textContent, '<b>A very long literal title</b>');
    assert.equal(page.querySelectorAll('b').length, 0); assert.match(page.textContent, /No visible items/);
    assert.equal(page.querySelectorAll('button').length, 1);
    assert.equal(env.cardCalls.length, 1); assert.equal(env.cardCalls[0].items[0].Name, '<b>A very long literal title</b>');
    const retry = page.querySelector('button'); failed = false; retry.dispatchEvent({ type: 'click' }); await settle();
    assert.equal(page.querySelectorAll('.jfce-row').length, 3); assert.equal(page.querySelectorAll('.card').length, 2);
    // The asynchronous native renderer can remove its own hide class; the scoped
    // activation remains in force and the native node has not been removed.
    page.querySelector('#collectionsCollapsible').classList.remove('hide'); assert.equal(active(page), true);
    runtime.destroy(); assert.equal(active(page), false); assert.equal(env.timers.size, 0);
    assert.equal(page.listeners.get('change').length, 0);
    assert.equal(page.listeners.get('viewbeforehide').length, 0);
    assert.equal(page.listeners.get('viewdestroy').length, 0);
});

test('rows use native detail-section, header, scroller and items-container elements for theme inheritance', async () => {
    const items = [{ Id: 'movie', Name: 'Native title', ProductionYear: 2001 }];
    const env = environment(path => path.endsWith('/Collections')
        ? { Items: [{ Id: 'one', Name: 'Collection' }, { Id: 'two', Name: 'Second' }], TotalRecordCount: 2 }
        : { Items: items });
    const runtime = createRuntime(env.window); const page = env.page();
    show(page, 'movie', { params: { id: 'movie', serverId: 'server-a', context: 'movies' } }); await settle();
    const rows = page.querySelectorAll('.jfce-row'); const native = page.querySelector('#collectionsCollapsible');
    assert.equal(rows.length, 2); assert.equal(page.querySelector('.jfce-rows'), null);
    assert.ok(rows.every(row => row.parentNode === native.parentNode));
    assert.deepEqual(page.childNodes.slice(-3), [...rows, native]);
    for (const row of rows) {
        assert.equal(row.tagName, 'DIV');
        for (const name of ['verticalSection', 'detailVerticalSection', 'verticalSection-extrabottompadding']) assert.ok(row.classList.contains(name));
        const heading = row.querySelector('h2');
        for (const name of ['sectionTitle', 'sectionTitle-cards', 'padded-right']) assert.ok(heading.classList.contains(name));
        const link = heading.querySelector('a');
        assert.equal(link.getAttribute('is'), 'emby-linkbutton');
        for (const name of ['sectionTitleTextButton', 'button-flat', 'button-flat-mini']) assert.ok(link.classList.contains(name));
        assert.match(link.href, /^#\/details\?id=(?:one|two)&serverId=server-a$/);
        const chevron = link.querySelector('.material-icons'); assert.equal(chevron.textContent, '', 'The theme supplies the stock icon glyph');
        assert.equal(chevron.classList.contains('chevron_right'), true, 'Keep Jellyfin’s stock theme-controlled icon class');
        const scroller = row.childNodes.find(node => node.getAttribute('is') === 'emby-scroller');
        assert.ok(scroller);
        for (const name of ['padded-top-focusscale', 'padded-bottom-focusscale', 'no-padding']) assert.ok(scroller.classList.contains(name));
        assert.equal(scroller.getAttribute('data-centerfocus'), 'true');
        const cards = scroller.querySelector('.itemsContainer');
        assert.equal(cards.getAttribute('is'), 'emby-itemscontainer');
        for (const name of ['scrollSlider', 'focuscontainer-x', 'collectionsContent']) assert.ok(cards.classList.contains(name));
        assert.equal(row.querySelector('.jfce-cards'), null); assert.equal(row.querySelector('.jfce-artwork'), null);
    }
    assert.equal(env.cardCalls.length, 2);
    for (const { items: rendered, options } of env.cardCalls) {
        assert.equal(rendered[0], items[0]);
        assert.ok(rows.includes(options.parentContainer));
        assert.equal(options.itemsContainer, options.parentContainer.querySelector('.itemsContainer'));
        assert.equal(options.shape, 'autooverflow'); assert.equal(options.sectionTitleTagName, 'h2');
        for (const key of ['scalable', 'centerText', 'showTitle', 'lazy', 'showYear', 'showDetailsMenu', 'overlayPlayButton']) assert.equal(options[key], true, key);
        for (const key of ['showParentTitle', 'overlayText', 'coverImage']) assert.equal(options[key], false, key);
        assert.equal(options.context, 'movies');
    }
    runtime.destroy(); assert.equal(page.querySelector('.jfce-row'), null);
});

test('missing or incompatible native card bridge keeps the stock Collections section available', async () => {
    for (const bridge of [undefined, { version: 2, cardBuilder: { buildCards() { throw new Error('unsupported bridge'); } } }, { version: 1, cardBuilder: {} }]) {
        const env = environment(() => { throw new Error('must not fetch unsupported native cards'); });
        env.window.JellyfinCollectionsExplodedNative = bridge;
        const runtime = createRuntime(env.window); const page = env.page();
        const native = page.querySelector('#collectionsCollapsible'); native.classList.remove('hide');
        show(page); await settle();
        assert.equal(active(page), false); assert.equal(page.querySelector('.jfce-row'), null);
        assert.equal(native.classList.contains('hide'), false); assert.equal(env.cardCalls.length, 0);
        assert.equal(env.calls.filter(call => call.path === 'Items' || call.path.endsWith('/Collections')).length, 0);
        runtime.destroy();
    }
});

test('all content fetches carry session permissions and the configured sort/cap, with fixed row order', async () => {
    const gates = [deferred(), deferred(), deferred()];
    const env = environment((path, query) => path.endsWith('/Collections') ? { Items: gates.map((_g, i) => ({ Id: String(i), Name: String(i) })), TotalRecordCount: 3 } : gates[Number(query.parentId)].promise);
    const original = env.api.getJSON; env.api.getJSON = url => url.includes('/Settings') ? Promise.resolve({ ...settings, maxItemsPerCollection: 1, sortOrder: 'Descending' }) : original(url);
    const runtime = createRuntime(env.window); const page = env.page(); show(page); await settle();
    assert.deepEqual(page.querySelectorAll('.sectionTitleTextButton').map(node => node.textContent), ['0', '1', '2']);
    const calls = env.calls.filter(call => call.path === 'Items'); assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.query.sortOrder === 'Descending,Ascending' && call.query.limit === '1' && call.query.userId === 'viewer' && call.query.recursive === 'false'));
    gates[2].resolve({ Items: [{ Id: 'last', Name: 'last' }] }); await settle();
    assert.equal(page.querySelectorAll('.jfce-row')[2].querySelector('.cardText').textContent, 'last');
    gates[0].resolve({ Items: [] }); gates[1].resolve({ Items: [] }); await settle(); runtime.destroy();
});

test('failed discovery restores native section, including a failed second membership page', async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => ({ Id: String(i), Name: 'Collection' }));
    const env = environment((_path, q) => { if (q.startIndex === '0') return { Items: hundred, TotalRecordCount: 101 }; throw new Error('second page failed'); });
    const runtime = createRuntime(env.window); const page = env.page(); show(page); await settle();
    assert.equal(active(page), false); assert.equal(page.querySelector('.jfce-row'), null); assert.ok(page.querySelector('#collectionsCollapsible'));
    assert.equal(env.calls.filter(call => call.path === 'Items').length, 0); runtime.destroy();
});

test('disabled and zero-membership states remove old rows, with no empty wrapper', async () => {
    const env = environment(() => ({ Items: [], TotalRecordCount: 0 })); const runtime = createRuntime(env.window); const page = env.page();
    show(page); await settle(); assert.equal(active(page), true); assert.equal(page.querySelector('.jfce-row'), null);
    const original = env.api.getJSON; env.api.getJSON = url => url.includes('/Settings') ? Promise.resolve({ ...settings, enabled: false }) : original(url);
    show(page); await settle(); assert.equal(active(page), false); runtime.destroy();
});

test('cached page queries stay scoped, navigation drops stale responses and restores correctly', async () => {
    const gate = deferred();
    const env = environment(path => path === 'Items/movie/Collections' ? gate.promise : { Items: [{ Id: 'new', Name: 'New' }], TotalRecordCount: 1 });
    const runtime = createRuntime(env.window); const first = env.page(); const second = env.page();
    show(first); await settle(); hide(first); show(second, 'new-movie'); await settle();
    assert.equal(active(first), false); assert.equal(first.querySelector('.jfce-row'), null); assert.equal(active(second), true);
    gate.resolve({ Items: [{ Id: 'old', Name: 'Old' }], TotalRecordCount: 1 }); await settle();
    assert.equal(first.querySelector('.jfce-row'), null); assert.equal(second.querySelectorAll('.jfce-row').length, 1);
    show(second, 'new-movie', { isRestored: true }); await settle(); assert.equal(second.querySelectorAll('.jfce-row').length, 1);
    second.dispatchEvent({ type: 'viewdestroy' }); assert.equal(active(second), false); runtime.destroy();
});

test('alternate versions refresh membership without viewshow and restored pages use selected version', async () => {
    const env = environment(() => ({ Items: [], TotalRecordCount: 0 })); const runtime = createRuntime(env.window); const page = env.page();
    show(page); await settle(); const source = page.querySelector('.selectSource'); source.value = 'alternate'; source.dispatchEvent({ type: 'change', bubbles: true }); await settle();
    assert.equal(env.calls.filter(call => call.path.endsWith('/Collections')).at(-1).path, 'Items/alternate/Collections');
    hide(page); show(page, 'movie', { isRestored: true }); await settle();
    assert.equal(env.calls.filter(call => call.path.endsWith('/Collections')).at(-1).path, 'Items/alternate/Collections'); runtime.destroy();
});

test('logout and account replacement synchronously clear rows and reject stale content', async () => {
    for (const action of ['logout', 'setAuthenticationInfo', 'clearAuthenticationInfo']) {
        const gate = deferred(); const env = environment(path => path.endsWith('/Collections') ? { Items: [{ Id: 'one', Name: 'One' }], TotalRecordCount: 1 } : gate.promise);
        const original = env.api[action]; const runtime = createRuntime(env.window); const page = env.page(); show(page); await settle(); assert.equal(active(page), true);
        env.api[action]('different-token', 'different-user'); assert.equal(active(page), false); assert.equal(page.querySelector('.jfce-row'), null); assert.equal(env.api[action], original);
        gate.resolve({ Items: [{ Id: 'private', Name: 'Private' }] }); await settle(); assert.equal(page.querySelector('.jfce-row'), null); runtime.destroy();
    }
});

test('replacement API clients, server changes and route changes clear content at identity guards', async () => {
    for (const mutate of [env => { env.window.ApiClient = { ...env.api }; }, env => { env.auth.server = 'other'; }, env => { env.window.location.hash = '#/home'; }]) {
        const env = environment(() => ({ Items: [], TotalRecordCount: 0 })); const runtime = createRuntime(env.window); const page = env.page(); show(page); await settle(); assert.equal(active(page), true);
        mutate(env); env.tick(); assert.equal(active(page), false); runtime.destroy();
    }
});

test('navigating with four active requests cancels queued old rows and shares the bound with new rows', async () => {
    const gates = []; let running = 0; let peak = 0;
    const env = environment((path, q) => {
        if (path.endsWith('/Collections')) return { Items: Array.from({ length: path.includes('new') ? 2 : 7 }, (_, i) => ({ Id: String(i), Name: String(i) })), TotalRecordCount: path.includes('new') ? 2 : 7 };
        const gate = deferred(); gates.push(gate); running++; peak = Math.max(peak, running); return gate.promise.finally(() => running--);
    });
    const runtime = createRuntime(env.window); const page = env.page(); show(page); await settle(); assert.equal(gates.length, 4);
    hide(page); show(page, 'new'); await settle(); assert.equal(gates.length, 4);
    gates.slice().forEach(gate => gate.resolve({ Items: [] })); await settle(); assert.equal(gates.length, 6); assert.equal(peak, 4);
    gates.slice(4).forEach(gate => gate.resolve({ Items: [] })); await settle(); assert.equal(page.querySelectorAll('.jfce-row').length, 2); runtime.destroy();
});
