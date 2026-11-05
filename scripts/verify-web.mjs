#!/usr/bin/env node
/**
 * Verify Collections Exploded's integration contract in official, unmodified
 * Jellyfin Web production assets. This is a compatibility check, not a live
 * Jellyfin browser test. Fixtures are selected from checksum-verified packages
 * by fetch-web-fixtures.mjs and kept in the ignored .research directory.
 *
 * node scripts/verify-web.mjs [.research/fixtures/12.0.0 ...]
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

export const requiredWebAssetKinds = Object.freeze([
    'item-details', 'item-template', 'web-shell', 'api-client', 'native-card-builder'
]);

const originalAsset = name => /^[\w.-]+\.(?:chunk|bundle)\.js$/.test(name);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** The byte fingerprints deliberately do not depend on webpack module IDs. */
export function identifyWebAsset(source) {
    if (source.includes('cardBuilderHtml') && source.includes('getCardsHtml') && source.includes('lazyChildren')) {
        return { kind: 'native-card-builder' };
    }
    if (source.includes('getItemCollections') && source.includes('collectionsCollapsible')) {
        return { kind: 'item-details' };
    }
    if (source.includes('id="itemDetailPage"') && source.includes('collectionsContent')) {
        return { kind: 'item-template' };
    }
    if (source.includes('window.Emby.Page=') && source.includes('window.ApiClient=')) {
        return { kind: 'web-shell' };
    }
    if (source.includes('ApiClientCore:') && source.includes('setAuthenticationInfo') &&
        source.includes('getCurrentUserId')) {
        return { kind: 'api-client' };
    }
    return null;
}

export function assertWebAssetCoverage(report) {
    for (const kind of requiredWebAssetKinds) {
        assert.equal(report.filter(entry => entry.kind === kind).length, 1,
            `Missing or duplicate ${kind} fixture`);
    }
}

/** Read a bundle's module factories without running its application startup. */
export function captureModules(source, filename = 'production.bundle.js', globals = {}) {
    const registrations = [];
    const sandbox = { ...globals, self: { webpackChunk: { push: entry => registrations.push(entry) } } };
    new Script(source, { filename }).runInNewContext(sandbox, { timeout: 2000 });
    assert.ok(registrations.length, `No webpack module registration in ${filename}`);
    const modules = Object.assign({}, ...registrations.map(entry => entry[1]));
    assert.ok(Object.keys(modules).length, `No webpack module factories in ${filename}`);
    return modules;
}

function onlyFactory(modules, predicate, description) {
    const found = Object.values(modules).filter(factory => predicate(factory.toString()));
    assert.equal(found.length, 1, `Missing or ambiguous ${description} module`);
    return found[0];
}

function contains(source, fragments, label) {
    for (const fragment of fragments) {
        assert.ok(source.includes(fragment), `${label}: missing ${fragment}`);
    }
}

/** Balanced function bodies in minified upstream code, ignoring strings. */
function closingBrace(source, start) {
    let depth = 1;
    let quote;
    let escaped = false;
    for (let index = start + 1; index < source.length; index += 1) {
        const character = source[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = null;
        } else if ('\'"`'.includes(character)) quote = character;
        else if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) return index;
    }
    throw new Error('Unclosed production function');
}

function smallestFunction(source, predicate) {
    const candidates = [];
    for (const match of source.matchAll(/function\s*[\w$]*\s*\([^)]*\)\s*\{/g)) {
        const start = match.index;
        const end = closingBrace(source, source.indexOf('{', start));
        const candidate = source.slice(start, end + 1);
        if (predicate(candidate)) candidates.push(candidate);
    }
    assert.ok(candidates.length, 'Missing expected production function');
    return candidates.sort((a, b) => a.length - b.length)[0];
}

function verifyDetails(modules) {
    const source = onlyFactory(modules,
        candidate => candidate.includes('[renderItemCollections]'), 'item detail controller').toString();
    contains(source, ['querySelector("#collectionsCollapsible")', 'querySelector(".collectionsContent")',
        '.getItemCollections({itemId:', '.getCurrentUserId()', '.addEventListener("viewshow",',
        '.addEventListener("viewbeforehide",', '.addEventListener("viewdestroy",',
        '.detail.isRestored', 'querySelector(".selectSource").addEventListener("change",'], 'Detail controller');
    assert.match(source, /\.id;if\([\w$]+\)return [\w$]+\.getItem\([\w$]+\.getCurrentUserId\(\),[\w$]+\)/,
        'The detail route must use params.id');
    // Alternate-version selection uses a MediaSource ID as an item ID. The
    // native controller refreshes collections without a second viewshow event.
    const refresh = smallestFunction(source,
        candidate => candidate.includes('failed to load alternate version item') && candidate.includes('.querySelector(".selectSource").value'));
    const selected = refresh.match(/var ([\w$]+)=[\w$]+\.querySelector\("\.selectSource"\)\.value/);
    assert.ok(selected, 'Missing selected alternate version item ID');
    assert.match(refresh, new RegExp(`itemId:${selected[1]}[},]`),
        'Alternate version lookup no longer uses selectSource.value as itemId');
    assert.match(refresh, /\.querySelector\("\.selectSource"\)\.value===/,
        'Missing native stale alternate-version guard');
    const scroller = onlyFactory(modules,
        candidate => candidate.includes('registerElement("emby-scroller"'), 'native scroller').toString();
    contains(scroller, ['createdCallback', 'attachedCallback', 'detachedCallback', '.destroy()',
        'scrollSlider', 'data-centerfocus', 'emby-scrollbuttons'], 'Native scroller');
    const items = onlyFactory(modules,
        candidate => candidate.includes('registerElement("emby-itemscontainer"'), 'native items container').toString();
    contains(items, ['createdCallback', 'attachedCallback', 'detachedCallback', 'contextmenu',
        'subscribe(', '_wsUnsubscribers', 'enableMultiSelect'], 'Native items container');
    return { nativeRegisteredScroller: true, nativeRegisteredItemsContainer: true,
        page: '#itemDetailPage', membershipSection: '#collectionsCollapsible',
        routeItemParameter: 'id', alternateVersionUsesItemId: true };
}

function verifyTemplate(modules) {
    const factory = onlyFactory(modules,
        candidate => candidate.includes('id="itemDetailPage"'), 'item detail template');
    const exports = {};
    const require = Object.assign(() => { throw new Error('Unexpected template dependency'); }, { r() {} });
    factory({ exports }, exports, require);
    const html = exports.default;
    assert.equal(typeof html, 'string');
    assert.match(html, /^<div id="itemDetailPage"[^>]*class="[^"]*\bitemDetailPage\b/);
    contains(html, ['id="collectionsCollapsible"', 'collectionsContent',
        'id="similarCollapsible"', 'class="selectSource '], 'Detail template');
    assert.ok(html.indexOf('id="collectionsCollapsible"') < html.indexOf('id="similarCollapsible"'),
        'Collections must precede similar items');
    return { collectionsBeforeSimilar: true };
}

function verifyCardBuilder(modules) {
    const source = onlyFactory(modules,
        candidate => candidate.includes('cardBuilderHtml'), 'native card builder').toString();
    contains(source, ['getCardsHtml:', 'buildCards:', 'document.body.contains(', 'lazyChildren(',
        'cardOverlayButton', 'cardText', 'data-serverid', 'data-id', 'showYear', 'overlayPlayButton'],
    'Native card builder');
    return { nativeBuildCards: true, nativeLazyImages: true, nativeCardActions: true };
}

function methodFunction(source, name) {
    const marker = `key:"${name}",value:`;
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `Missing ${name} method`);
    const expression = source.indexOf('function', start);
    const end = closingBrace(source, source.indexOf('{', expression));
    return source.slice(expression, end + 1);
}

function verifyShell(modules) {
    const router = onlyFactory(modules,
        candidate => candidate.includes('window.Emby.Page='), 'global router').toString();
    const routeSource = methodFunction(router, 'getRouteUrl');
    // Supply the imported CollectionType enum, local-item predicate and layout
    // state while exercising the actual shipped route implementation.
    const enumMatch = routeSource.match(/([\w$]+)\.([\w$]+)\.Livetv/);
    const helperMatch = routeSource.match(/([\w$]+)\.([\w$]+)\.isLocalItem\(/);
    const layoutMatch = routeSource.match(/([\w$]+)\.([\w$]+)\.modern/);
    assert.ok(enumMatch && helperMatch && layoutMatch, 'Missing router dependencies');
    const collectionTypes = Object.fromEntries(['Livetv', 'Books', 'Movies', 'Tvshows',
        'Music', 'Homevideos', 'Musicvideos', 'Boxsets', 'Playlists'].map(name => [name, name.toLowerCase()]));
    const layout = { modern: true };
    const getRouteUrl = new Script(`(${routeSource})`).runInNewContext({
        [enumMatch[1]]: { [enumMatch[2]]: collectionTypes },
        [helperMatch[1]]: { [helperMatch[2]]: { isLocalItem: () => false } },
        [layoutMatch[1]]: { [layoutMatch[2]]: layout }
    });
    for (const modern of [true, false]) {
        layout.modern = modern;
        const heading = getRouteUrl({ Id: 'collection-1', Type: 'BoxSet', IsFolder: true }, { serverId: 'server-1' });
        assert.equal(heading, '#/details?id=collection-1&serverId=server-1');
        for (const type of ['Movie', 'Series', 'Season', 'Episode', 'MusicAlbum']) {
            assert.equal(getRouteUrl({ Id: 'media-1', Type: type }, { serverId: 'server-1' }),
                '#/details?id=media-1&serverId=server-1', `Unsupported ${type} card navigation`);
        }
    }
    const connections = onlyFactory(modules,
        candidate => candidate.includes('window.ApiClient='), 'global API client').toString();
    contains(connections, ['key:"setLocalApiClient"', 'window.ApiClient=', 'localusersignedout'], 'Server connections');
    const lifecycle = onlyFactory(modules,
        candidate => candidate.includes('viewbeforeshow') && candidate.includes('new URLSearchParams(') && candidate.includes('isRestored:') &&
            candidate.includes('new CustomEvent("viewshow"'), 'view lifecycle').toString();
    contains(lifecycle, ['new URLSearchParams(', 'params:', 'isRestored:', 'bubbles:!0',
        'new CustomEvent("viewshow"', 'viewbeforehide'], 'View lifecycle');
    const detailSource = smallestFunction(lifecycle,
        candidate => candidate.includes('new URLSearchParams(') && candidate.includes('isRestored:'));
    const propertiesMatch = detailSource.match(/properties:([\w$]+)\(/);
    assert.ok(propertiesMatch, 'Missing view properties helper');
    const getEventDetail = new Script(`(${detailSource})`).runInNewContext({
        URLSearchParams, [propertiesMatch[1]]: () => []
    });
    const eventDetail = getEventDetail({ getAttribute: () => 'item' }, {
        url: 'details?id=media-1&serverId=server-1', state: { restored: true }, options: {}
    }, true);
    assert.equal(eventDetail.detail.params.id, 'media-1');
    assert.equal(eventDetail.detail.params.serverId, 'server-1');
    assert.equal(eventDetail.detail.isRestored, true);
    assert.equal(eventDetail.bubbles, true);
    const viewContainer = onlyFactory(modules,
        candidate => candidate.includes('new CustomEvent("viewdestroy",{})'), 'cached view container').toString();
    contains(viewContainer, ['new CustomEvent("viewdestroy",{})', 'mainAnimatedPage'], 'Cached view container');
    const routes = Object.values(modules).map(factory => factory.toString()).filter(
        candidate => candidate.includes('controller:"itemDetails/index",view:"itemDetails/index.html"'));
    assert.equal(routes.length, 2, 'Both Modern and Legacy layouts must use the verified detail controller');
    return { apiGlobal: 'window.ApiClient', routeGlobal: 'window.Emby.Page.getRouteUrl',
        layouts: ['Modern', 'Legacy'], viewshowBubbles: true, viewdestroyBubbles: false };
}

async function verifyApiClient(modules, requests) {
    const factory = onlyFactory(modules,
        candidate => candidate.includes('ApiClientCore:') && candidate.includes('key:"getJSON"'), 'API client');
    const apiModule = { exports: {} };
    // The vendor's UMD module has no external module imports. Use a sandboxed
    // context from captureModules; only invoke its factory and client methods.
    factory(apiModule);
    const ApiClient = apiModule.exports.ApiClient;
    assert.equal(typeof ApiClient, 'function');
    const prototype = ApiClient.prototype;
    for (const name of ['getUrl', 'getJSON', 'getCurrentUserId', 'serverId', 'serverVersion',
        'accessToken', 'getImageUrl', 'setAuthenticationInfo', 'logout']) {
        assert.equal(typeof prototype[name], 'function', `Missing API client method ${name}`);
    }
    // Avoid invoking constructor networking/storage initialization. These are
    // the actual production methods with controlled state and request transport.
    const client = Object.create(prototype);
    client._serverAddress = 'https://example.test/jellyfin';
    client._serverInfo = { Id: 'server-1', UserId: 'viewer-1', AccessToken: 'test-token' };
    client._loggedIn = true;
    client._serverVersion = '12.0.0';
    const queryUrl = client.getUrl('Items/film-1/Collections', { userId: 'viewer-1', startIndex: 100, limit: 100 });
    assert.equal(queryUrl, 'https://example.test/jellyfin/Items/film-1/Collections?userId=viewer-1&startIndex=100&limit=100');
    assert.equal(client.getUrl('Items', { recursive: false, collapseBoxSetItems: false }),
        'https://example.test/jellyfin/Items?recursive=false&collapseBoxSetItems=false');
    client.enableAutomaticNetworking = false;
    await client.getJSON(queryUrl);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, queryUrl);
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.headers.accept, 'application/json');
    assert.match(requests[0].options.headers.Authorization, /Token="test-token"/);
    assert.equal(client.getCurrentUserId(), 'viewer-1');
    assert.equal(client.serverId(), 'server-1');
    assert.equal(client.serverVersion(), '12.0.0');
    const image = new URL(client.getImageUrl('media-1', { type: 'Primary', maxWidth: 320, tag: 'image-tag' }));
    assert.equal(image.pathname, '/jellyfin/Items/media-1/Images/Primary');
    assert.equal(image.searchParams.get('tag'), 'image-tag');
    assert.equal(image.searchParams.get('maxWidth'), '320');
    assert.equal(image.searchParams.has('type'), false);
    // This setter does not publish a DOM auth event. An injected adapter needs
    // synchronous observation of it/logout plus client-identity checks.
    client.enableAutomaticBitrateDetection = false;
    client.setAuthenticationInfo(null, null);
    assert.equal(client.getCurrentUserId(), null);
    assert.equal(client.accessToken(), null);
    return { authenticatedGetJSON: true, basePathPreserved: true, imageHelper: true,
        synchronousAuthState: true, abortSignalSupportRequired: false };
}

export async function verifyWebAsset(source, filename = 'production.bundle.js') {
    const asset = identifyWebAsset(source);
    assert.ok(asset, `Unrecognized Collections Exploded fixture ${filename}`);
    const requests = [];
    const modules = captureModules(source, filename, {
        fetch: async (url, options) => {
            requests.push({ url, options });
            return { status: 200, json: async () => ({ Items: [] }) };
        }
    });
    const details = asset.kind === 'item-details' ? verifyDetails(modules)
        : asset.kind === 'item-template' ? verifyTemplate(modules)
            : asset.kind === 'web-shell' ? verifyShell(modules)
                : asset.kind === 'native-card-builder' ? verifyCardBuilder(modules)
                    : await verifyApiClient(modules, requests);
    return { ...asset, ...details };
}

export async function verifyWebDirectory(directory) {
    const names = (await readdir(directory)).filter(originalAsset).sort();
    assert.ok(names.length, `No production fixtures in ${directory}`);
    let metadata;
    try { metadata = JSON.parse(await readFile(path.join(directory, 'fixtures.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (metadata) {
        assert.equal(metadata.schema, 1, 'Unsupported fixture manifest schema');
        assert.deepEqual(metadata.files.map(file => file.name).sort(), names,
            'Fixture files differ from the package manifest');
    }
    const assets = [];
    for (const name of names) {
        const bytes = await readFile(path.join(directory, name));
        if (metadata) {
            const record = metadata.files.find(file => file.name === name);
            assert.equal(hash(bytes), record.sha256, `${name} differs from the official package fixture`);
        }
        const result = await verifyWebAsset(bytes.toString('utf8'), name);
        if (metadata) assert.equal(result.kind, metadata.files.find(file => file.name === name).kind);
        assets.push({ name, ...result });
    }
    assertWebAssetCoverage(assets);
    return { directory, version: metadata?.webPackage?.version, assets };
}

async function main() {
    const inputs = process.argv.slice(2);
    const directories = inputs.length ? inputs : (await readdir('.research/fixtures')).sort()
        .map(name => path.join('.research/fixtures', name));
    const results = [];
    for (const directory of directories) {
        assert.ok((await stat(directory)).isDirectory(), `Expected fixture directory: ${directory}`);
        results.push(await verifyWebDirectory(directory));
    }
    assert.ok(results.length, 'No Jellyfin Web fixture directories found');
    console.log(JSON.stringify({ verified: true, scope: 'official production asset contract; not a live browser smoke test',
        versions: results }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(`Jellyfin Web compatibility verification failed: ${error.message}`);
        process.exitCode = 1;
    });
}
