#!/usr/bin/env node
/**
 * Execute the server-patched itemDetails factory and the official cardBuilder,
 * shape, image URL, card class, indicators, and registered element factories.
 * Only external application services and the DOM boundary are controlled.
 * Run tests/Server with the fixture directory first to produce .patched.js.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureModules, identifyWebAsset } from './verify-web.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g,
    character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function oneModule(modules, predicate, description) {
    const found = Object.entries(modules).filter(([, factory]) => predicate(factory.toString()));
    assert.equal(found.length, 1, `Missing or ambiguous production ${description}`);
    return found[0];
}

function createBoundary() {
    const records = { lazy: [], scrollers: [], shortcuts: [], subscriptions: [], notifications: [], scrollButtons: [] };
    const registrations = new Map();
    const state = { desktop: true, mobile: false, tv: false, width: 1440, height: 900, finePointer: true };
    class Element {
        constructor() {
            this.attributes = new Map();
            this.style = {};
            this.classes = new Set();
            this.classList = {
                add: (...names) => names.forEach(name => this.classes.add(name)),
                remove: (...names) => names.forEach(name => this.classes.delete(name)),
                contains: name => this.classes.has(name)
            };
            this.listeners = new Map();
            this.innerHTML = '';
            this.isConnected = true;
        }
        getAttribute(name) { return this.attributes.get(name) ?? null; }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        addEventListener(name, callback) { this.listeners.set(name, callback); }
        removeEventListener(name, callback) { if (this.listeners.get(name) === callback) this.listeners.delete(name); }
        querySelector(selector) { return selector === '.scrollSlider' ? this.slider : null; }
        querySelectorAll() { return []; }
        insertAdjacentHTML(position, html) { records.scrollButtons.push({ position, html }); }
        removeAttribute(name) { this.attributes.delete(name); }
    }
    const document = {
        body: { contains: element => element.isConnected },
        registerElement(name, definition) {
            assert.equal(definition.extends, 'div', 'Upstream must still register customized div elements');
            registrations.set(name, definition.prototype);
        },
        createElement(tag, type) {
            assert.equal(tag, 'div');
            const element = new Element();
            if (type) {
                // Jellyfin ships the v0 custom elements API. Its second argument
                // is a string (the v1 { is } argument throws in the real polyfill).
                assert.equal(typeof type, 'string');
                assert.ok(registrations.has(type), `Native ${type} was registered`);
                Object.setPrototypeOf(element, registrations.get(type));
                element.setAttribute('is', type);
                element.createdCallback?.();
            }
            return element;
        }
    };
    const api = {
        serverId: () => 'server-1',
        subscribe(type) {
            const entry = { type, unsubscribed: false };
            records.subscriptions.push(entry);
            return () => { entry.unsubscribed = true; };
        }
    };
    class Scroller {
        constructor(element, options) {
            this.element = element;
            this.options = options;
            this.initialized = false;
            this.reloaded = false;
            this.destroyed = false;
            records.scrollers.push(this);
        }
        init() { this.initialized = true; }
        reload() { this.reloaded = true; }
        destroy() { this.destroyed = true; }
        toCenter(element) { this.centered = element; }
    }
    const methods = {
        getApiClient: () => api,
        currentApiClient: () => api,
        getApi: () => ({ _nativeApi: true }),
        getItemImageUrlById: (id, type, options) =>
            `https://example.test/jellyfin/Items/${id}/Images/${type}?tag=${options.tag}`,
        getPrimaryImageAspectRatio: items => items[0]?.PrimaryImageAspectRatio,
        getWindowSize: () => ({ innerWidth: state.width, innerHeight: state.height }),
        getDisplayName: item => item.Name,
        lazyChildren: element => records.lazy.push(element),
        toLocaleString: value => String(value),
        parseISO8601Date: value => new Date(value),
        translate: key => key,
        canMarkPlayed: () => true,
        canRate: () => true,
        canPlay: () => true,
        getShortcutAttributesHtml: () => '',
        getRouteUrl: item => `#/details?id=${item.Id}&serverId=server-1`,
        on: (owner, name, callback) => records.notifications.push({ owner, name, callback }),
        off: (owner, name, callback) => {
            const event = records.notifications.find(entry => entry.owner === owner && entry.name === name && entry.callback === callback);
            if (event) event.removed = true;
        },
        onClick() {},
        addEventListener: (element, name, callback) => element.addEventListener(name, callback),
        removeEventListener: (element, name, callback) => element.removeEventListener(name, callback),
        focusableParent: element => element,
        focusLast() {}, moveFocus() {}, autoFocus() {}
    };
    // Unknown application modules are external services or enums. The renderer,
    // CSS class helpers, image URL/shape helpers and elements are always real.
    const services = new Proxy(function (value) {
        if (value?._nativeApi) return services;
        if (value && typeof value === 'object') return Object.keys(value).filter(key => value[key]).join(' ');
        return escapeHtml(value);
    }, {
        get(_target, name) {
            if (name === 'then') return undefined;
            if (name === 'slow' || name === 'edge' || name === 'touch') return false;
            if (name === 'desktop' || name === 'mobile' || name === 'tv') return state[name];
            if (name in methods) return methods[name];
            if (['Link', 'Menu', 'None', 'Play', 'Resume'].includes(name)) return name.toLowerCase();
            return String(name);
        },
        construct() { return { destroy() {} }; }
    });
    const fallbackModule = new Proxy(function (value) { return services(value); }, {
        get(_target, name) {
            if (name === '__esModule') return false;
            if (name === 'then') return undefined;
            return services;
        }
    });
    return { document, Element, api, state, records, registrations, Scroller, services, fallbackModule, methods };
}

function loaderFor(modules, boundary, overrides = {}) {
    const cache = new Map();
    function require(id) {
        if (Object.hasOwn(overrides, id)) return overrides[id];
        if (cache.has(String(id))) return cache.get(String(id)).exports;
        const factory = modules[id];
        if (!factory) return boundary.fallbackModule;
        const module = { exports: {} };
        cache.set(String(id), module);
        factory(module, module.exports, require);
        return module.exports;
    }
    require.r = exports => Object.defineProperty(exports, '__esModule', { value: true });
    require.d = (exports, getters) => {
        for (const [key, get] of Object.entries(getters)) Object.defineProperty(exports, key, { get, enumerable: true });
    };
    require.n = module => {
        const getter = () => module.__esModule ? module.default : module;
        getter.a = getter;
        return getter;
    };
    require.e = () => Promise.resolve();
    require.dn = () => {};
    return require;
}

/** Resolve an imported namespace by semantic usage, without hardcoding IDs. */
function importedNamespace(source, pattern) {
    const reference = source.match(pattern);
    assert.ok(reference, `Native dependency fingerprint changed: ${pattern}`);
    const alias = reference[1].replace(/[$]/g, '\\$&');
    const binding = source.match(new RegExp(`\\b${alias}=[$\\w]+\\((\\d+)\\)`));
    assert.ok(binding, `No production import for ${reference[1]}`);
    return { id: binding[1], exportName: reference[2] };
}

function overrideDependency(overrides, source, pattern, value) {
    const { id, exportName } = importedNamespace(source, pattern);
    overrides[id] = { ...overrides[id], [exportName]: value };
}

function nativeOptions(container, parent) {
    return {
        itemsContainer: container, parentContainer: parent, serverId: 'server-1',
        shape: 'autooverflow', centerText: true, showTitle: true, showParentTitle: false,
        showYear: true, lazy: true, showDetailsMenu: true, coverImage: false,
        overlayPlayButton: true, overlayText: false, context: 'movies'
    };
}

function verifyCards(cardBuilder, boundary) {
    const item = {
        Id: 'film-1', ServerId: 'server-1', Type: 'Movie', MediaType: 'Video',
        Name: 'Native <Card> & Theme', ProductionYear: 2024, PrimaryImageAspectRatio: 2 / 3,
        ImageTags: { Primary: 'poster-tag' }, UserData: { Played: true, IsFavorite: true }
    };
    for (const layout of ['desktop', 'mobile', 'tv']) {
        Object.assign(boundary.state, { desktop: layout === 'desktop', mobile: layout === 'mobile', tv: layout === 'tv' });
        const parent = new boundary.Element();
        const container = new boundary.Element();
        const options = nativeOptions(container, parent);
        cardBuilder.buildCards([item], options);
        const html = container.innerHTML;
        assert.ok(html.length > 500, `Actual ${layout} card has complete markup`);
        for (const fragment of ['overflowPortraitCard', 'cardBox', 'cardScalable', 'cardPadder-overflowPortrait',
            'cardImageContainer', 'cardText-secondary', 'cardTextCentered', '2024', 'data-serverid="server-1"',
            'data-id="film-1"', 'data-context="movies"', 'poster-tag', 'Native &lt;Card&gt; &amp; Theme',
            'playedIndicator']) {
            assert.ok(html.includes(fragment), `Native ${layout} card missing ${fragment}: ${html}`);
        }
        assert.equal(boundary.records.lazy.at(-1), container, 'Actual buildCards invokes native image lazy loading');
        const expected = cardBuilder.getCardsHtml([item], nativeOptions(container, parent));
        assert.equal(html, expected, 'Actual buildCards output equals native getCardsHtml with the same options');
        if (layout === 'desktop') {
            for (const fragment of ['card-hoverable', 'cardOverlayContainer', 'data-action="resume"',
                'emby-playstatebutton', 'emby-ratingbutton', 'data-action="menu"']) {
                assert.ok(html.includes(fragment), `Desktop preserves native ${fragment}`);
            }
        } else if (layout === 'mobile') {
            assert.ok(html.includes('data-action="play"'), 'Mobile preserves native play overlay');
        } else {
            assert.match(html, /^<button /, 'TV uses native focusable button cards');
            assert.ok(html.includes('show-focus'), 'TV uses native focus styling');
        }
        container.isConnected = false;
        container.innerHTML = 'disposed';
        cardBuilder.buildCards([item], options);
        assert.equal(container.innerHTML, 'disposed', 'Actual buildCards respects disposed containers');
    }
}

async function verifyElements(modules, boundary, require) {
    const [scrollerId, scrollerFactory] = oneModule(modules,
        source => source.includes('registerElement("emby-scroller"'), 'scroller');
    const [itemsId] = oneModule(modules,
        source => source.includes('registerElement("emby-itemscontainer"'), 'items container');
    require(scrollerId);
    require(itemsId);
    for (const layout of ['desktop', 'mobile', 'tv']) {
        Object.assign(boundary.state, { desktop: layout === 'desktop', mobile: layout === 'mobile', tv: layout === 'tv' });
        const scroller = boundary.document.createElement('div', 'emby-scroller');
        const items = boundary.document.createElement('div', 'emby-itemscontainer');
        scroller.slider = items;
        scroller.setAttribute('data-centerfocus', 'true');
        assert.ok(scroller.classList.contains('emby-scroller'), 'Actual scroller createdCallback sets native class');
        assert.ok(items.classList.contains('itemsContainer'), 'Actual items createdCallback sets native class');
        scroller.attachedCallback();
        items.attachedCallback();
        await new Promise(resolve => setImmediate(resolve));
        const instance = boundary.records.scrollers.at(-1);
        assert.ok(instance.initialized && instance.reloaded, 'Actual scroller attachment initializes native scrolling');
        assert.equal(instance.options.slidee, items, 'Native scroller controls native items container');
        assert.equal(instance.options.horizontal, true);
        assert.equal(instance.options.allowNativeScroll, layout !== 'desktop');
        if (layout === 'desktop') {
            assert.ok(boundary.records.scrollButtons.some(entry => entry.html.includes('is="emby-scrollbuttons"')),
                'Native desktop scroller creates native scroll buttons');
        }
        if (layout === 'tv') {
            const focused = new boundary.Element();
            scroller.listeners.get('focus')({ target: focused });
            assert.equal(instance.centered, focused, 'Native TV scroller keeps focused card centered');
        }
        const subscriptions = boundary.records.subscriptions.slice(-6);
        assert.equal(subscriptions.length, 6, 'Actual items container subscribes to native item/user-data updates');
        items.detachedCallback();
        scroller.detachedCallback();
        assert.ok(instance.destroyed && scroller.scroller === null, 'Actual native scroller detachment destroys its controller');
        assert.ok(subscriptions.every(entry => entry.unsubscribed), 'Actual native items detachment releases all subscriptions');
        assert.equal(items.listeners.size, 0, 'Native items detachment removes event handlers');
    }
    assert.ok(scrollerFactory.toString().includes('detachedCallback'));
}

export function verifyRuntimeBoundary(runtime, stylesheet) {
    assert.match(runtime, /document\.createElement\(tag,\s*customElement\)/,
        'Runtime must use the shipped v0 custom element constructor signature');
    assert.doesNotMatch(runtime, /createElement\([^)]*,\s*\{\s*is\s*:/,
        'Modern v1 element options throw in the shipped Jellyfin v0 polyfill');
    for (const type of ['emby-scroller', 'emby-itemscontainer']) {
        assert.ok(runtime.includes("'" + type + "'"), 'Runtime must instantiate native ' + type);
    }
    assert.match(runtime, /nativeRenderer\.cardBuilder\.buildCards\(/,
        'Runtime must delegate card rendering to the native imported builder');
    const css = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    assert.match(css, /^\.jfce-active\s+#collectionsCollapsible\s*\{\s*display:\s*none\s*!important;?\s*\}$/,
        'Plugin CSS must only hide the replaced Collections section; themes own native cards, sizing and controls');
}

export async function verifyNativeDirectory(directory) {
    const [runtime, stylesheet] = await Promise.all([
        readFile('src/Jellyfin.Plugin.CollectionsExploded/Web/collections-exploded.js', 'utf8'),
        readFile('src/Jellyfin.Plugin.CollectionsExploded/Web/collections-exploded.css', 'utf8')
    ]);
    verifyRuntimeBoundary(runtime, stylesheet);
    const files = (await readdir(directory)).filter(name => /^[\w.-]+\.(?:chunk|bundle)\.js$/.test(name));
    const assets = [];
    for (const name of files) {
        const source = await readFile(path.join(directory, name), 'utf8');
        const kind = identifyWebAsset(source)?.kind;
        if (kind) assets.push({ name, source, kind });
    }
    const details = assets.filter(asset => asset.kind === 'item-details');
    const cards = assets.filter(asset => asset.kind === 'native-card-builder');
    assert.equal(details.length, 1, 'Exactly one production itemDetails fixture is required');
    assert.equal(cards.length, 1, 'Exactly one production cardBuilder fixture is required');
    const original = details[0];
    const patched = await readFile(path.join(directory, original.name + '.patched.js'), 'utf8');
    assert.notEqual(patched, original.source, 'Run actual server transformation against the original fixture first');
    assert.equal((patched.match(/jellyfin-collections-exploded-native:1/g) ?? []).length, 1,
        'Actual server transformation emits exactly one guarded native bridge');

    const boundary = createBoundary();
    const globals = {
        window: { screen: { availWidth: 1440 }, devicePixelRatio: 1 },
        document: boundary.document, HTMLDivElement: boundary.Element, console,
        Events: { on: boundary.methods.on, off: boundary.methods.off }
    };
    const detailModules = captureModules(patched, original.name + '.patched.js', globals);
    const detailFactories = Object.fromEntries(Object.entries(detailModules).filter(([, factory]) => {
        const source = factory.toString();
        return source.includes('[renderItemCollections]') ||
            source.includes('registerElement("emby-scroller"') ||
            source.includes('registerElement("emby-itemscontainer"');
    }));
    const nativeModules = {
        ...captureModules(cards[0].source, cards[0].name, globals),
        ...detailFactories
    };
    const [cardId] = oneModule(nativeModules,
        source => source.includes('cardBuilderHtml'), 'card builder');
    const [detailId] = oneModule(nativeModules,
        source => source.includes('[renderItemCollections]'), 'itemDetails controller');
    const [, scrollerFactory] = oneModule(nativeModules,
        source => source.includes('registerElement("emby-scroller"'), 'scroller');
    const overrides = {};
    overrideDependency(overrides, scrollerFactory.toString(),
        /new ([\w$]+)\.([\w$]+)\(this,/, boundary.Scroller);
    overrideDependency(overrides, scrollerFactory.toString(),
        /&&\(0,([\w$]+)\.([\w$]+)\)\(\)&&/, () => boundary.state.finePointer);
    const require = loaderFor(nativeModules, boundary, overrides);
    const actualExports = require(cardId);
    const actualBuilder = Object.values(actualExports).find(value =>
        value && typeof value.buildCards === 'function' && typeof value.getCardsHtml === 'function');
    assert.ok(actualBuilder, 'Actual production module exports the native card builder');
    require(detailId);
    const bridge = globals.window.JellyfinCollectionsExplodedNative;
    assert.equal(bridge?.version, 1, 'Actual patched itemDetails factory publishes versioned bridge');
    assert.equal(bridge.cardBuilder, actualBuilder, 'Bridge exposes exact imported production cardBuilder reference');
    assert.equal(typeof globals.window.ItemDetailPage?.renderDetails, 'function', 'Original native detail setup still runs');
    verifyCards(bridge.cardBuilder, boundary);
    await verifyElements(nativeModules, boundary, require);
    return { directory, exactNativeBuilderReference: true, productionCardLayouts: ['desktop', 'mobile', 'tv'],
        nativeLazyImages: true, nativeActionsAndIndicators: true, nativeScrollerAttachmentAndDetachment: true,
        nativeItemsSubscriptionsReleased: true, shippedV0ElementConstructor: true, noPluginCardStyling: true };
}

async function main() {
    const inputs = process.argv.slice(2);
    const directories = inputs.length ? inputs : (await readdir('.research/fixtures')).sort()
        .map(name => path.join('.research/fixtures', name));
    const results = [];
    for (const directory of directories) results.push(await verifyNativeDirectory(directory));
    assert.ok(results.length, 'No production fixture directories');
    console.log(JSON.stringify({ verified: true, scope: 'actual server-patched factory and production native renderer; controlled DOM/application services', versions: results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
