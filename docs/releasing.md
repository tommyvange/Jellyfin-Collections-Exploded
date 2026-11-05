# Publishing releases

Collections Exploded uses GitHub Releases for downloadable packages and a dedicated `manifest` branch for the Jellyfin catalog:

```text
https://raw.githubusercontent.com/tommyvange/Jellyfin-Collections-Exploded/manifest/manifest.json
```

The catalog appears after the first successful publication. GitHub Actions uses its built-in token; no repository secrets, separate hosting, or Pages setup are required. Build jobs receive read-only repository permissions, while the publication job receives `contents: write`.

## Normal release procedure

1. Set the next four-part plugin version in `Directory.Build.props`. The current release is `1.0.3.0`; later versions must be greater than the last public release. Update the three-part package version in `package.json` at the same time.
2. Update `release/notes.md`. Keep the GUID and name stable in `release/config.json` and `Plugin.cs`.
3. Commit to `main`, push, and let **Build and test** pass.
4. Create and push the exact matching tag:

   ```sh
   git tag -a v1.0.3.0 -m "Release 1.0.3.0"
   git push origin v1.0.3.0
   ```

The tag must point to a commit on `main`. Version mismatches and prerelease tags are rejected. **Publish release** runs the reusable build workflow again from the tagged source, so publication does not depend on another workflow's temporary artifacts.

## What Actions does

1. Validates the shared plugin version, tag, runtime GUID/name, and compatibility configuration.
2. Runs JavaScript behavior and release tooling tests, then the .NET server tests covering configuration and File Transformation integration.
3. Resolves the latest published stable Jellyfin release from the official GitHub API and selects its exact production web package and SHA-256 from the official Debian index. Checks that release and the pinned minimum baseline, deduplicating when equal.
4. Downloads or validates the exact production web package and fingerprints the item detail controller, item template, lifecycle/router shell, API client, and native card builder. The actual patched detail module, native card HTML, and customized-element attach/detach behavior are exercised. A missing or duplicate integration asset fails verification. Compiles against the latest server API to detect API/framework changes.
5. Builds the catalog package against `minimumJellyfinVersion`, creates a draft GitHub release, uploads the ZIP and SHA-256 sidecar, downloads and verifies their bytes, and publishes the draft.
6. Creates a catalog entry from the published ZIP, including `version`, minimum `targetAbi`, immutable `sourceUrl`, UTC `timestamp`, `changelog`, and Jellyfin's required MD5 checksum.
7. Preserves existing history and advances `manifest` with a normal Git commit and push. The catalog advertises the ZIP only after publication is confirmed.

`meta.json` inside the ZIP describes the installed plugin. The repository's `manifest.json` lists available releases. ZIPs contain the plugin DLL, `meta.json`, and the image configured in `release/config.json`; Jellyfin supplies server assemblies. The DLL embeds the JavaScript, stylesheet, and administrator settings page, so no frontend build or separate web deployment is needed. Packaged metadata references the image filename, while the catalog's `imageUrl` references the image at the exact release tag.

## Local verification and packaging

Use .NET 10, Node.js 20 or newer, and the `zip`, `unzip`, `ar`, and `tar` utilities. There are no npm dependencies to install.

```sh
npm test
npm run test:server
npm run build
npm run package
```

The current package is `artifacts/Jellyfin.Plugin.CollectionsExploded_1.0.3.0_jellyfin-12.0.0.zip`, accompanied by its `.sha256` sidecar. The archive places installable files at its root. Extract those files into the Jellyfin plugin directory while the server is stopped, preserving the separate plugin configuration file. Restart Jellyfin and reload the web client. Install File Transformation 3.x matching the server version first.

To reproduce production web compatibility checks:

```sh
bash scripts/fetch-web-fixtures.sh 12.0.0
node scripts/verify-web.mjs .research/fixtures/12.0.0
bash scripts/fetch-web-fixtures.sh latest
```

The downloader prints the resolved latest fixture directory. Pass that directory to the verifier. The optional `JELLYFIN_WEB_PACKAGE` environment variable fixes the exact descriptor for a CI run.

## One package per plugin version

Jellyfin treats `targetAbi` as a minimum version. Its updater requires a greater plugin version for an automatic update. This repository therefore builds one package against the oldest supported ABI and verifies integration at the baseline and latest stable release, with at most two targets. Intermediate minor versions do not accumulate as permanent targets.

If Jellyfin introduces a server API break, update the minimum ABI, framework, baseline package, and plugin version together. Future major versions enter the latest check automatically; passing static integration checks still requires confirmation on a running server before claiming support for a new release.

## Retrying publication

Rerun the failed workflow, or use **Publish release → Run workflow** with the existing tag. For an older tag created before a workflow/tooling change, rerun its original workflow run; a new manual dispatch uses the current workflow definition and requires its scripts to exist in the selected tag.

An incomplete draft can replace its draft assets and retry. An already public release downloads and uses its original assets instead of replacing them with newly built bytes. A retry can then complete or confirm the catalog update. Existing catalog entries are retained, and changing a published version's ZIP contents, URL, or ABI is rejected. Publication jobs are serialized.

Never move a published tag or overwrite a public ZIP. Publish a new version for fixes. Prereleases are excluded from the stable catalog.

## Compatibility policy

**Build and test** runs on pushes, pull requests, manual dispatch, release tags through the reusable workflow, and every Monday at 06:23 UTC. It selects `minimumJellyfinVersion` plus the latest stable version from the official GitHub API. Drafts and prereleases are rejected, and discovery failures fail the run instead of substituting an older version. If the official package index has not yet published a matching web package, rerun after publication completes.

The baseline package is pinned by URL, size, and SHA-256 in `release/config.json`. Each workflow run fixes its latest package descriptor once. Fixture caches include the package checksum and discovery code, verify the original bytes, and reject mixed or incomplete coverage. Asset identification uses content fingerprints, allowing webpack hashes and IDs to change without configuration updates.

Only change `minimumJellyfinVersion` and `compatibility.baselineWebPackage` when deliberately raising the support floor. Pin the matching official web package's final checksum and size, review its upstream behavior, and test a running server. The Debian distribution index may need updating when Jellyfin drops that distribution. Public release ZIPs remain immutable across retries.
