/* Collections Exploded: authenticated collection previews for Jellyfin Web 12+. */
(function (root) {
    'use strict';

    const PAGE_SIZE = 100;
    const ACTIVE_CLASS = 'jfce-active';
    const SORT_FIELDS = new Set(['ProductionYear', 'SortName', 'DateCreated', 'PremiereDate']);
    const canceled = () => Object.assign(new Error('Page is no longer active.'), { name: 'AbortError' });

    function normalizeSettings(value) {
        if (!value || typeof value.enabled !== 'boolean') throw new Error('Invalid display settings.');
        return {
            enabled: value.enabled,
            maxItemsPerCollection: Number.isInteger(value.maxItemsPerCollection)
                ? Math.max(1, Math.min(100, value.maxItemsPerCollection)) : 20,
            sortBy: SORT_FIELDS.has(value.sortBy) ? value.sortBy : 'ProductionYear',
            sortOrder: value.sortOrder === 'Descending' ? 'Descending' : 'Ascending'
        };
    }

    function contentQuery(collectionId, userId, settings) {
        const secondary = settings.sortBy !== 'SortName';
        return {
            userId, parentId: collectionId, recursive: false, collapseBoxSetItems: false,
            sortBy: settings.sortBy + (secondary ? ',SortName' : ''),
            sortOrder: settings.sortOrder + (secondary ? ',Ascending' : ''),
            startIndex: 0, limit: settings.maxItemsPerCollection,
            enableImages: true, enableUserData: true, fields: 'PrimaryImageAspectRatio,SortName'
        };
    }

    // A single queue bounds content requests across pages and retries. In-flight
    // getJSON promises cannot be aborted; their slots remain occupied until settled.
    function createQueue(limit) {
        let running = 0;
        let pending = [];
        function pump() {
            while (running < limit && pending.length) {
                const entry = pending.shift();
                if (!entry.valid()) { entry.reject(canceled()); continue; }
                running++;
                Promise.resolve().then(() => {
                    if (!entry.valid()) throw canceled();
                    return entry.task();
                }).then(entry.resolve, entry.reject).finally(() => { running--; pump(); });
            }
        }
        return {
            add(owner, valid, task) {
                return new Promise((resolve, reject) => {
                    pending.push({ owner, valid, task, resolve, reject });
                    pump();
                });
            },
            cancel(owner) {
                const removed = pending.filter(entry => entry.owner === owner);
                pending = pending.filter(entry => entry.owner !== owner);
                removed.forEach(entry => entry.reject(canceled()));
            }
        };
    }

    async function discoverCollections(adapter, context, valid) {
        const collections = [];
        const seen = new Set();
        let startIndex = 0;
        let total;
        do {
            if (!valid()) throw canceled();
            const result = await adapter.request(context, 'Items/' + encodeURIComponent(context.itemId) + '/Collections', {
                userId: context.userId, startIndex, limit: PAGE_SIZE
            });
            if (!valid()) throw canceled();
            if (!result || !Array.isArray(result.Items) || !Number.isSafeInteger(result.TotalRecordCount)
                || result.TotalRecordCount < 0) throw new Error('Invalid collection membership response.');
            if (total !== undefined && total !== result.TotalRecordCount) throw new Error('Collection membership changed during discovery.');
            total = result.TotalRecordCount;
            if ((!result.Items.length && startIndex < total) || startIndex + result.Items.length > total)
                throw new Error('Incomplete collection membership response.');
            for (const collection of result.Items) {
                if (!collection || typeof collection.Id !== 'string' || !collection.Id) throw new Error('Collection has no identity.');
                if (!seen.has(collection.Id)) { seen.add(collection.Id); collections.push(collection); }
            }
            startIndex += result.Items.length;
        } while (startIndex < total);
        return collections;
    }

    function createAdapter(window) {
        const getClient = () => window.ApiClient;
        function identity(client) {
            try {
                return { client, serverId: client.serverId(), userId: client.getCurrentUserId(), token: client.accessToken() };
            } catch (_) { return null; }
        }
        function matches(context) {
            const current = identity(getClient());
            return !!current && current.client === context.client && current.serverId === context.serverId
                && current.userId === context.userId && current.token === context.token;
        }
        return {
            capture(page, params, itemId) {
                const client = getClient();
                const router = window.Emby && window.Emby.Page;
                const nativeRenderer = window.JellyfinCollectionsExplodedNative;
                if (!page || !page.matches('.itemDetailPage') || !page.querySelector('#collectionsCollapsible')
                    || !router || typeof router.getRouteUrl !== 'function' || !client
                    || !nativeRenderer || nativeRenderer.version !== 1 || !nativeRenderer.cardBuilder
                    || typeof nativeRenderer.cardBuilder.buildCards !== 'function'
                    || ['getUrl', 'getJSON', 'serverId', 'getCurrentUserId', 'accessToken'].some(key => typeof client[key] !== 'function')) return null;
                const current = identity(client);
                if (!current || !current.serverId || !current.userId || !current.token || !itemId
                    || (params.serverId && params.serverId !== current.serverId)) return null;
                return Object.assign(current, { page, itemId, route: window.location.href, nativeRenderer, routeContext: params.context });
            },
            matches,
            async supported(context) {
                let version = typeof context.client.serverVersion === 'function' && context.client.serverVersion();
                if (!version) {
                    const info = await this.request(context, 'System/Info/Public');
                    version = info && info.Version;
                }
                return /^\d+\.\d+(?:\.\d+)?/.test(String(version)) && Number(String(version).split('.')[0]) >= 12;
            },
            request(context, path, query) {
                if (!matches(context)) return Promise.reject(canceled());
                // Jellyfin's helper supplies the current session authorization.
                return context.client.getJSON(context.client.getUrl(path, query));
            },
            route(context, item) {
                const url = window.Emby.Page.getRouteUrl(item, { serverId: context.serverId });
                // A route helper must return a same-origin, base-path-safe link.
                if (typeof url !== 'string' || !url) throw new Error('Missing media route.');
                const parsed = new URL(url, window.location.href);
                if (parsed.origin !== window.location.origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid media route.');
                return url;
            },
            // Clear displayed media synchronously on the client's authentication
            // mutations. Wrappers preserve receivers, arguments and return values.
            watchIdentity(context, invalidate) {
                const cleanups = [];
                for (const name of ['logout', 'setAuthenticationInfo', 'clearAuthenticationInfo']) {
                    const client = context.client;
                    const original = client[name];
                    if (typeof original !== 'function') continue;
                    const wrapped = function () {
                        if (name !== 'setAuthenticationInfo' || arguments[0] !== context.token || arguments[1] !== context.userId) invalidate();
                        return original.apply(this, arguments);
                    };
                    try {
                        client[name] = wrapped;
                        cleanups.push(() => { if (client[name] === wrapped) client[name] = original; });
                    } catch (_) { /* Read-only clients still have lifecycle/identity guards. */ }
                }
                return () => cleanups.forEach(cleanup => cleanup());
            }
        };
    }

    function createRuntime(window, adapter = createAdapter(window)) {
        const document = window.document;
        const states = new WeakMap();
        const bindings = new Set();
        const queue = createQueue(4);
        let active = null;
        let identityTimer = null;
        let destroyed = false;

        function element(tag, className, text, customElement) {
            const node = customElement ? document.createElement(tag, customElement) : document.createElement(tag);
            if (customElement) node.setAttribute('is', customElement);
            if (className) node.classList.add(...className.split(' '));
            if (text !== undefined) node.textContent = text;
            return node;
        }
        function clear(state) {
            state.generation++;
            queue.cancel(state);
            if (state.unwatch) { state.unwatch(); state.unwatch = null; }
            // Removing native elements lets Jellyfin detach its input handlers,
            // subscriptions, scroll buttons and scroller instances normally.
            for (const row of state.rows) row.section.remove();
            state.rows = [];
            state.page.classList.remove(ACTIVE_CLASS);
            if (active === state) {
                active = null;
                if (identityTimer !== null) window.clearInterval(identityTimer);
                identityTimer = null;
            }
        }
        function current(state, generation) {
            const context = state.context;
            return !destroyed && active === state && state.generation === generation && state.page.isConnected
                && window.location.href === context.route && adapter.matches(context);
        }
        function checkIdentity() {
            if (active && !current(active, active.generation)) clear(active);
        }
        function bind(page) {
            let state = states.get(page);
            if (state) return state;
            state = { page, generation: 0, rows: [], params: null, context: null, unwatch: null };
            states.set(page, state);
            const hide = () => clear(state);
            const source = event => {
                if (active === state && event.target.matches('.selectSource')) activate(page, state.params, event.target.value || state.params.id);
            };
            const destroy = () => {
                clear(state);
                page.removeEventListener('viewbeforehide', hide);
                page.removeEventListener('viewdestroy', destroy);
                page.removeEventListener('change', source);
                states.delete(page);
                bindings.delete(state);
            };
            state.dispose = destroy;
            bindings.add(state);
            page.addEventListener('viewbeforehide', hide);
            page.addEventListener('viewdestroy', destroy);
            page.addEventListener('change', source);
            return state;
        }
        function message(row, text) {
            row.status.replaceChildren(element('p', 'fieldDescription padded-left padded-right', text));
            row.status.classList.remove('hide');
            row.scroller.classList.add('hide');
            row.section.setAttribute('aria-busy', 'false');
        }
        function renderCards(row, items, context) {
            const visible = items.filter(item => item && item.Id);
            if (!visible.length) { message(row, 'No visible items in this collection.'); return; }
            row.status.replaceChildren();
            row.status.classList.add('hide');
            row.scroller.classList.remove('hide');
            // Use Jellyfin's actual card builder and the same options as its
            // More Like This row. Native code owns all artwork, card markup,
            // image loading, playback controls and item-menu behavior.
            context.nativeRenderer.cardBuilder.buildCards(visible, {
                parentContainer: row.section,
                itemsContainer: row.cards,
                shape: 'autooverflow',
                sectionTitleTagName: 'h2',
                scalable: true,
                centerText: true,
                showTitle: true,
                showParentTitle: false,
                overlayText: false,
                overlayPlayButton: true,
                showDetailsMenu: true,
                coverImage: false,
                lazy: true,
                showYear: true,
                context: context.routeContext
            });
            row.section.setAttribute('aria-busy', 'false');
        }
        function makeRow(collection, context) {
            const section = element('div', 'verticalSection detailVerticalSection verticalSection-extrabottompadding jfce-row');
            section.setAttribute('data-jfce-collection-id', collection.Id);
            const heading = element('h2', 'sectionTitle sectionTitle-cards padded-right');
            const link = element('a', 'more button-flat button-flat-mini sectionTitleTextButton', undefined, 'emby-linkbutton');
            link.href = adapter.route(context, collection);
            link.appendChild(element('span', '', collection.Name || 'Untitled collection'));
            // Match Jellyfin's stock empty icon span so the active theme supplies
            // its glyph. Literal icon text would render an additional arrow.
            const arrow = element('span', 'material-icons chevron_right');
            arrow.setAttribute('aria-hidden', 'true');
            link.appendChild(arrow);
            heading.appendChild(link);
            section.appendChild(heading);
            const status = element('div');
            status.setAttribute('aria-live', 'polite');
            section.appendChild(status);
            const scroller = element('div', 'padded-top-focusscale padded-bottom-focusscale no-padding', undefined, 'emby-scroller');
            scroller.setAttribute('data-centerfocus', 'true');
            const cards = element('div', 'scrollSlider focuscontainer-x itemsContainer collectionsContent', undefined, 'emby-itemscontainer');
            scroller.appendChild(cards);
            section.appendChild(scroller);
            const row = { section, status, scroller, cards, collection, name: collection.Name || 'Collection', loading: false };
            message(row, 'Loading collection…');
            section.setAttribute('aria-busy', 'true');
            return row;
        }
        async function loadRow(state, generation, row, settings) {
            if (!current(state, generation) || row.loading) return;
            row.loading = true;
            message(row, 'Loading collection…');
            row.section.setAttribute('aria-busy', 'true');
            const valid = () => current(state, generation);
            try {
                const result = await queue.add(state, valid, () => adapter.request(state.context, 'Items', contentQuery(row.collection.Id, state.context.userId, settings)));
                if (!valid()) return;
                if (!result || !Array.isArray(result.Items)) throw new Error('Invalid collection contents.');
                renderCards(row, result.Items.slice(0, settings.maxItemsPerCollection), state.context);
            } catch (error) {
                if (!valid()) return;
                message(row, 'Could not load this collection.');
                const retry = element('button', 'raised jfce-retry', 'Retry', 'emby-button');
                retry.type = 'button';
                retry.setAttribute('aria-label', 'Retry ' + row.name);
                retry.addEventListener('click', () => loadRow(state, generation, row, settings));
                row.status.appendChild(retry);
            } finally { row.loading = false; }
        }
        async function activate(page, params, itemId) {
            if (destroyed) return;
            if (active) clear(active);
            const state = bind(page);
            clear(state);
            state.params = params;
            const context = adapter.capture(page, params, itemId || params.id);
            if (!context) return;
            state.context = context;
            active = state;
            const generation = state.generation;
            const valid = () => current(state, generation);
            state.unwatch = adapter.watchIdentity(context, () => clear(state));
            // Also detect replacement API clients and external credential changes.
            identityTimer = window.setInterval(checkIdentity, 250);
            try {
                if (!await adapter.supported(context) || !valid()) { if (valid()) clear(state); return; }
                const settings = normalizeSettings(await adapter.request(context, 'CollectionsExploded/Settings'));
                if (!valid()) return;
                if (!settings.enabled) { clear(state); return; }
                const collections = await discoverCollections(adapter, context, valid);
                if (!valid()) return;
                const rows = collections.map(collection => makeRow(collection, context));
                // Native sections are direct siblings, so theme selectors that
                // target the detail page's own section hierarchy still match.
                state.rows = rows;
                const native = page.querySelector('#collectionsCollapsible');
                rows.forEach(row => native.parentNode.insertBefore(row.section, native));
                page.classList.add(ACTIVE_CLASS);
                rows.forEach(row => { void loadRow(state, generation, row, settings); });
            } catch (error) {
                // Settings, route or any membership-page failure restores native UI.
                if (valid()) clear(state);
            }
        }
        function show(event) {
            const page = event.target;
            const params = event.detail && event.detail.params;
            if (active && active.page !== page) clear(active);
            if (!params || !params.id || !page || typeof page.matches !== 'function' || !page.matches('.itemDetailPage')) return;
            const source = event.detail.isRestored && page.querySelector('.selectSource');
            void activate(page, params, (source && source.value) || params.id);
        }
        document.addEventListener('viewshow', show);
        document.addEventListener('viewbeforeshow', checkIdentity);
        document.addEventListener('visibilitychange', checkIdentity);
        window.addEventListener('hashchange', checkIdentity);
        window.addEventListener('popstate', checkIdentity);
        window.addEventListener('storage', checkIdentity);
        return {
            activate,
            destroy() {
                destroyed = true;
                for (const state of [...bindings]) state.dispose();
                document.removeEventListener('viewshow', show);
                document.removeEventListener('viewbeforeshow', checkIdentity);
                document.removeEventListener('visibilitychange', checkIdentity);
                window.removeEventListener('hashchange', checkIdentity);
                window.removeEventListener('popstate', checkIdentity);
                window.removeEventListener('storage', checkIdentity);
            }
        };
    }

    if (typeof module === 'object' && module.exports) {
        module.exports = { normalizeSettings, contentQuery, createQueue, discoverCollections, createAdapter, createRuntime };
    } else if (root && root.document && !root.JellyfinCollectionsExploded) {
        root.JellyfinCollectionsExploded = createRuntime(root);
    }
})(typeof window === 'undefined' ? null : window);
