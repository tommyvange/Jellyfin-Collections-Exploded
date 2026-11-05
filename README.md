# Jellyfin Collections Exploded

[![Build and test](https://github.com/tommyvange/Jellyfin-Collections-Exploded/actions/workflows/build.yml/badge.svg)](https://github.com/tommyvange/Jellyfin-Collections-Exploded/actions/workflows/build.yml)

A Jellyfin server plugin that gives **every collection containing a media item its own horizontal row** on that item's detail page. Each heading opens the collection, and its cards show the collection's media in your chosen order.

For example, a movie belonging to three collections gets three separate rows in place of the combined Collections section. Each row defaults to **20 items, sorted by year, oldest first**. The limit applies to each row independently; every accessible collection still gets a row.

<p align="center"><img src="assets/Jellyfin-Collections-Exploded.png" alt="Collections Exploded plugin artwork" width="240"></p>

Requires **Jellyfin 12.0 or newer**, **.NET 10**, and a matching **File Transformation 3.x** installation. It works in the **server-hosted Jellyfin Web client**, in both Modern and Legacy layouts. Native apps and separately hosted web clients render their own interfaces.

## Install

The source and manual ZIP can be built locally now. **Catalog installation becomes available after the first GitHub release is published.**

1. Install **File Transformation 3.x** matching your Jellyfin server version. Add [IAmParadox27's repository](https://www.iamparadox.dev/jellyfin/plugins/manifest.json) in **Dashboard → Plugins → Repositories**, install **File Transformation**, and restart Jellyfin. It is an explicit prerequisite; Jellyfin does not install it automatically.
2. After the first release, add **Collections Exploded** as a plugin repository using:

   ```text
   https://raw.githubusercontent.com/tommyvange/Jellyfin-Collections-Exploded/manifest/manifest.json
   ```

3. Install **Collections Exploded** from the catalog and restart Jellyfin. The server log should report `Collections Exploded registered index.html and 1 native item detail web transformations.` Hard-refresh the server's web client once after installation.
4. Open **Dashboard → Plugins → Collections Exploded**, choose your item limit and sorting, and save. Reopen or refresh a media detail page to apply changes. Settings are shared by all users.

For manual installation, stop Jellyfin and extract the ZIP's contents directly into `plugins/Collections Exploded_1.0.3.0/` (use the actual version for later releases). The DLL, `meta.json`, and plugin image must sit at that directory's root. In the official Docker image this is normally `/config/plugins/Collections Exploded_1.0.3.0/`. Restart Jellyfin and refresh the web client.

To disable it, clear **Enable Collections Exploded** and reopen the media page. Uninstall through the dashboard, or stop Jellyfin and remove its plugin directory.

## Settings and behavior

| Setting | Default | Choices |
| --- | --- | --- |
| Enabled | On | On or off |
| Maximum items per collection | 20 | Whole number from 1 to 100 |
| Sort collection contents | Year: oldest first | Year, title, date added, or release date, in either direction |

Year, date added, and release date use ascending title order as a secondary sort. Sorting and the maximum are sent to Jellyfin together, so a row contains the first N items in the selected order. **Date added** is the item's library date. Unknown years follow Jellyfin's native sorting rules.

- Rows retain Jellyfin's alphabetical collection order. Collections with identical names remain separate because identity is based on IDs.
- The current item remains eligible in its normal sorted position. Shared media may appear in several rows.
- Membership follows Jellyfin's direct collection links. An episode does not inherit its series' collections. Collection contents are direct children; nested collections and series are not expanded.
- Requests use the signed-in viewer's API client. Library and parental-access restrictions continue to apply. Viewers can read effective display settings; configuration writes use Jellyfin's normal administrator API.
- Rows use Jellyfin’s native detail-section markup, `emby-scroller`, `emby-itemscontainer`, and actual card builder with the More Like This card options. Artwork, focus behavior, play overlays, item menus, and card sizing come from Jellyfin. Existing themes can style these native classes and elements. There is no plugin-defined card CSS or extra row wrapper.

## Loading and recovery

The native Collections section stays in the DOM. The plugin hides it only after all membership pages have loaded and every replacement heading has been created. Settings or discovery failures restore the native section, including failures after the first membership page. If the native card-rendering bridge is unavailable or the installed web bundle is unsupported, the original section remains usable.

Each discovered collection keeps its linked heading while loading, when empty, and when a content request fails. Failed previews have a **Retry** button. A single queue limits collection-content requests to four at a time, including retries; request completion does not rearrange rows.

Navigation, cached pages, alternate-version changes, and authentication changes invalidate old work. Queued requests are canceled and late responses are ignored. Jellyfin's `getJSON` helper does not expose an abort signal, so already-started requests retain their queue slot until they settle. No persistent media cache is used, and runtime settings are read on every detail-page activation.

## Build and package

Requirements: **.NET 10 SDK**, **Node.js 20+**, and the `zip` utility. There are no npm dependencies or separate frontend build steps. The DLL embeds its JavaScript, CSS, and settings page; Jellyfin supplies server assemblies.

```sh
npm test
npm run test:server
npm run build
npm run package
```

The current installable archive is:

```text
artifacts/Jellyfin.Plugin.CollectionsExploded_1.0.3.0_jellyfin-12.0.0.zip
```

A SHA-256 sidecar is generated alongside it. Set `DOTNET=/absolute/path/to/dotnet` if necessary. `Directory.Build.props` defines the plugin version; release tooling validates that the assembly identity matches `release/config.json`.

To verify official production web assets (also requires `ar` and `tar`):

```sh
bash scripts/fetch-web-fixtures.sh 12.0.0
node scripts/verify-web.mjs .research/fixtures/12.0.0
dotnet run --project tests/Server -- .research/fixtures/12.0.0
node scripts/verify-native-bridge.mjs .research/fixtures/12.0.0
bash scripts/fetch-web-fixtures.sh latest
```

Use the latest fixture directory printed by the downloader as the verifier argument. The downloader verifies the official Debian package's SHA-256 and retains only the required bundles. Compatibility checks fingerprint the detail controller/template, both layout routes, lifecycle events, API client, native card builder, custom-element lifecycle, and collection/media navigation. They execute production API-client, router, and native card-rendering methods and verify the actual patched detail module, while runtime tests exercise collection loading, paging, permissions in request construction, failures, queue limits, and stale-result protection.

These automated checks do not replace an installation test on a running Jellyfin server. Before publishing, verify the complete File Transformation startup path, an ordinary restricted viewer, both layouts, mobile and keyboard use, a reverse-proxy base path, and browser refreshes with warm caches. The implementation has been compiled and its web contract verified against **12.0.0 and 12.4.0**; live server installation has not been performed as part of this build.

## Releases and deployment

Deployment follows **Jellyfin-Infinite-Scroll**: push a tag matching `Directory.Build.props`, such as `v1.0.3.0`. GitHub Actions runs the checks, publishes the minimum-ABI ZIP and checksum to GitHub Releases, and updates the catalog on the **`manifest` branch**. The catalog retains prior versions and uses Jellyfin's required MD5 of the published archive. The workflow uses GitHub's built-in token and needs no custom hosting, personal access token, or GitHub Pages setup.

CI checks the minimum baseline plus the latest stable Jellyfin release, resolving official release/package metadata once per run. It also compiles against the latest server package and checks weekly for upstream changes. Discovery failures fail verification instead of silently selecting an older release. Future releases require their server API, framework, and web integration to remain compatible.

See [docs/releasing.md](docs/releasing.md) for first publication, versioning, immutable release retries, and catalog recovery. The repository URL above assumes `tommyvange/Jellyfin-Collections-Exploded`; release workflows derive their actual owner/repository from GitHub.

## Integration references

The plugin uses File Transformation's [reflection registration bridge](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation/blob/main/src/Jellyfin.Plugin.FileTransformation/PluginInterface.cs), joining the shared literal `index.html` pipeline. A guarded synchronous callback inserts versioned assets before Jellyfin's deferred bundles, preserving other transformations and the server base path. Repeated transformations insert one bootstrap, and unrelated content is left unchanged. At startup the plugin also discovers the supported item-detail chunk and registers only its exact relative path. A guarded transformation exposes the card builder that Jellyfin already imports; it preserves the native renderer. Restart Jellyfin after replacing its web assets. Unsupported bundles keep the native Collections section.

Browser integration is isolated in `createAdapter` in `Web/collections-exploded.js`. The supported contract comes from Jellyfin Web's [item detail controller](https://github.com/jellyfin/jellyfin-web/blob/v12.4/src/apps/legacy/controllers/itemDetails/index.js), [view manager](https://github.com/jellyfin/jellyfin-web/blob/v12.4/src/components/viewManager/viewManager.js), [router](https://github.com/jellyfin/jellyfin-web/blob/v12.4/src/components/router/appRouter.js), and [API client](https://github.com/jellyfin-archive/jellyfin-apiclient-javascript/blob/v1.11.0/src/apiClient.js). The plugin uses Jellyfin's existing [collection lookup](https://github.com/jellyfin/jellyfin/blob/v12.0/Jellyfin.Api/Controllers/LibraryController.cs) and [items](https://github.com/jellyfin/jellyfin/blob/v12.0/Jellyfin.Api/Controllers/ItemsController.cs) endpoints.
