using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using ServerTests;
using Jellyfin.Plugin.CollectionsExploded;
using Jellyfin.Plugin.CollectionsExploded.Controllers;
using Jellyfin.Plugin.CollectionsExploded.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Jellyfin.Plugin.CollectionsExploded.Configuration;
using Jellyfin.Plugin.CollectionsExploded.Transformations;

int checks = 0;
void Check(bool condition, string message)
{
    checks++;
    if (!condition) throw new InvalidOperationException(message);
}
void Rejects(Action action, string message)
{
    bool rejected = false;
    try { action(); }
    catch (ArgumentException) { rejected = true; }
    Check(rejected, message);
}

var defaults = new PluginConfiguration();
defaults.Validate();
Check(defaults.GetEffectiveSettings() == new EffectiveSettings(true, 20, "ProductionYear", "Ascending"),
    "The initial settings must match the documented defaults.");
foreach (string field in new[] { "ProductionYear", "SortName", "DateCreated", "PremiereDate" })
{
    foreach (string direction in new[] { "Ascending", "Descending" })
    {
        var configuration = new PluginConfiguration { MaxItemsPerCollection = 100, SortBy = field, SortOrder = direction };
        configuration.Validate();
        Check(configuration.GetEffectiveSettings().SortBy == field && configuration.GetEffectiveSettings().SortOrder == direction,
            "Every advertised sorting combination must remain valid.");
    }
}
var invalid = new PluginConfiguration { Enabled = false, MaxItemsPerCollection = -8, SortBy = "Random", SortOrder = null! };
Check(invalid.GetEffectiveSettings() == new EffectiveSettings(false, 1, "ProductionYear", "Ascending"),
    "Invalid saved configuration must produce safe effective settings.");
Check(invalid.MaxItemsPerCollection == -8 && invalid.SortBy == "Random", "Reading settings must not mutate saved configuration.");
Check(new PluginConfiguration { MaxItemsPerCollection = 1000 }.GetEffectiveSettings().MaxItemsPerCollection == 100,
    "Saved limits must never exceed 100.");
Rejects(() => new PluginConfiguration { MaxItemsPerCollection = 0 }.Validate(), "Reject writes below the minimum.");
Rejects(() => new PluginConfiguration { MaxItemsPerCollection = 101 }.Validate(), "Reject writes above the maximum.");
Rejects(() => new PluginConfiguration { SortBy = "DatePlayed" }.Validate(), "Reject unsupported sort fields.");
Rejects(() => new PluginConfiguration { SortOrder = "ascending" }.Validate(), "Reject unknown sort directions.");
using (JsonDocument json = JsonDocument.Parse(JsonSerializer.Serialize(defaults.GetEffectiveSettings())))
{
    Check(json.RootElement.EnumerateObject().Count() == 4, "Viewer DTO must expose only its four display settings.");
    Check(json.RootElement.GetProperty("maxItemsPerCollection").GetInt32() == 20, "Viewer DTO uses explicit camelCase names.");
}

const string html = "<!doctype html><html lang=\"en\"><head><title>Jellyfin</title><script src=\"other-plugin.js\"></script></head><body><div id=\"app\"></div></body></html>";
string patched = IndexPatcher.Patch(html, "/jellyfin/", "v1");
Check(patched.Contains("href=\"/jellyfin/CollectionsExploded/Stylesheet?v=v1\""), "Stylesheet must honor a configured base URL.");
Check(patched.Contains("defer src=\"/jellyfin/CollectionsExploded/ClientScript?v=v1\""), "Script must be deferred and versioned.");
Check(patched.Contains("other-plugin.js"), "Preserve changes from other transformations.");
int bootstrapStart = patched.IndexOf(IndexPatcher.BootstrapId, StringComparison.Ordinal);
Check(bootstrapStart < patched.IndexOf("other-plugin.js", StringComparison.Ordinal),
    "Bootstrap must appear before existing head scripts so the initial lifecycle event is observed.");
string originalHeadContent = html[html.IndexOf("<title>", StringComparison.Ordinal)..];
Check(patched.StartsWith("<!doctype html><html lang=\"en\"><head>", StringComparison.Ordinal)
    && patched.EndsWith(originalHeadContent, StringComparison.Ordinal),
    "Adding the bootstrap must preserve the original document prefix and all original head/body content.");
const string deferredDocument = "<!doctype html><html><head data-test=\"attributes\"><script defer src=\"jellyfin.js\"></script></head><body></body></html>";
string deferredPatched = IndexPatcher.Patch(deferredDocument, "", "v1");
Check(deferredPatched.IndexOf(IndexPatcher.BootstrapId, StringComparison.Ordinal)
    < deferredPatched.IndexOf("jellyfin.js", StringComparison.Ordinal),
    "Bootstrap must precede native deferred bundles even when the head has attributes.");
Check(IndexPatcher.Patch(patched, "/jellyfin", "v2") == patched, "Transformation must be idempotent across repeated callbacks.");
Check(IndexPatcher.Patch(html, "", "v1").Contains("src=\"/CollectionsExploded/ClientScript?v=v1\""), "Root deployments use an absolute local asset URL.");
Check(IndexPatcher.Patch(html.ToUpperInvariant(), "jellyfin", "v1").Contains(IndexPatcher.BootstrapId), "HTML checks must ignore tag case.");
Check(IndexPatcher.Patch(html, "/my server", "v+1").Contains("/my%20server/CollectionsExploded/ClientScript?v=v%2B1"),
    "Path segments and version tokens must be URL encoded.");
foreach (string unsupported in new[]
{
    "", "<div>fragment</div>", "const value = '</head>';", "<!doctype html><html><head></head><body>",
    "<!doctype html><html><head></head></html>", "<!doctype html><html><body></body></html>",
    "<!doctype html><html><body></body><head></head></html>", "<!doctype html><html><head></head><body></html>"
})
{
    Check(IndexPatcher.Patch(unsupported, "", "v1") == unsupported, "Never alter partial documents or non-HTML assets.");
}
Check(IndexPatcher.NormalizeBasePath("/my%20server") == "/my%20server", "Existing valid percent escapes must not be encoded twice.");
Check(IndexPatcher.NormalizeBasePath("/a%26b") == "/a&b", "Base URL escaping must follow Jellyfin's ASP.NET PathString semantics.");
Check(IndexPatcher.NormalizeBasePath("/literal%25value") == "/literal%25value", "An encoded percent sign must survive exactly once.");
foreach (string unsafePath in new[] { "https://example.com", "/../other", "/%2e%2e/other", "/jellyfin?query", "/jellyfin#fragment", "jellyfin\\other", "/bad%0Apath" })
{
    Rejects(() => IndexPatcher.NormalizeBasePath(unsafePath), "Reject malformed server base URL syntax.");
    Check(IndexPatcher.Patch(html, unsafePath, "v1") == html, "Malformed server base URL must leave the native HTML intact.");
}
Check(IndexPatcher.NormalizeBasePath(null) == "" && IndexPatcher.NormalizeBasePath("/") == "", "Empty base URL must remain root-relative.");
var controller = new ClientController
{
    ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() }
};
Check(typeof(ClientController).GetMethod(nameof(ClientController.GetSettings))!
    .IsDefined(typeof(AuthorizeAttribute), inherit: true), "Runtime settings must require viewer authentication.");
Check(controller.GetSettings().Result is StatusCodeResult { StatusCode: 503 },
    "Missing plugin state must fail closed instead of returning enabled defaults.");
Plugin.Instance = new Plugin { Configuration = invalid };
Check(controller.GetSettings().Value == invalid.GetEffectiveSettings(), "Runtime settings must always expose normalized values.");
Check(controller.Response.Headers.CacheControl.ToString().Contains("no-store"), "Runtime settings must never be cached.");
foreach (string method in new[] { nameof(ClientController.GetClientScript), nameof(ClientController.GetStylesheet) })
{
    Check(typeof(ClientController).GetMethod(method)!.IsDefined(typeof(AllowAnonymousAttribute), inherit: true),
        "Bootstrap assets must be available before authentication.");
}
ContentResult script = controller.GetClientScript(EmbeddedAssets.Version);
Check(script.Content == EmbeddedAssets.ClientScript && script.ContentType!.StartsWith("application/javascript"),
    "Script endpoint must serve the exact embedded client with its expected MIME type.");
Check(controller.Response.Headers.CacheControl.ToString().Contains("immutable"), "Current versioned assets may be cached immutably.");
Check(controller.Response.Headers.XContentTypeOptions == "nosniff", "Assets must disable MIME sniffing.");
controller.GetClientScript("old-version");
Check(controller.Response.Headers.CacheControl == "no-store", "Old version URLs must not cache new content immutably.");
ContentResult css = controller.GetStylesheet();
Check(css.Content == EmbeddedAssets.Stylesheet && css.ContentType!.StartsWith("text/css"),
    "Stylesheet endpoint must serve the exact embedded CSS.");
Check(controller.Response.Headers.CacheControl == "no-store", "Unversioned asset requests must not be cached.");
Check(EmbeddedAssets.Version.Length == 20 && EmbeddedAssets.Version.All(char.IsAsciiHexDigitLower),
    "The asset version must be a content-derived URL-safe hash.");
var callback = typeof(WebTransformations).GetMethod(nameof(WebTransformations.TransformIndex))!;
Check(callback.IsStatic && callback.ReturnType == typeof(string) && callback.GetParameters().Length == 1
    && callback.GetParameters()[0].ParameterType == typeof(TransformationRequest),
    "File Transformation callback must be public, static, synchronous, and accept one Contents payload.");
WebTransformations.BasePathProvider = () => "/server";
Check(WebTransformations.TransformIndex(new TransformationRequest { Contents = html })
    .Contains("/server/CollectionsExploded/ClientScript?v=" + EmbeddedAssets.Version),
    "The reflection callback must use the configured base path and actual embedded asset hash.");
WebTransformations.BasePathProvider = () => "/%2e%2e/other";
Check(WebTransformations.TransformIndex(new TransformationRequest { Contents = html }) == html,
    "A malformed configured base path must return original contents from the reflection callback.");
var javaScriptCallback = typeof(WebTransformations).GetMethod(nameof(WebTransformations.TransformJavaScript))!;
Check(javaScriptCallback.IsStatic && javaScriptCallback.ReturnType == typeof(string)
    && javaScriptCallback.GetParameters().Length == 1
    && javaScriptCallback.GetParameters()[0].ParameterType == typeof(TransformationRequest),
    "Native JavaScript transformation must use File Transformation's synchronous callback contract.");
const string nativeModule = "(self.webpackChunk=self.webpackChunk||[]).push([[1],{1:function(e,t,r){r.r(t),r.d(t,{default:function(){return Detail}});var card=r(24);function render(){var a=e.querySelector(\"#collectionsCollapsible\");r.getItemCollections({itemId:item.Id});card.default.buildCards(items,{parentContainer:a,itemsContainer:a.querySelector(\".collectionsContent\"),shape:\"overflowPortrait\",sectionTitleTagName:\"h2\",scalable:!0,centerText:!0,showTitle:!0,showParentTitle:!1,overlayText:!1,overlayPlayButton:!1,coverImage:!0,showYear:true});e.querySelector(\"#similarCollapsible\")}function Detail(e,t){}window.ItemDetailPage=new function(){var e=this;e.renderDetails=render,e.renderCast=render}}}]);";
string nativePatched = NativeCardPatcher.PatchJavaScript(nativeModule);
const string bridge = "window.JellyfinCollectionsExplodedNative={version:1,cardBuilder:card.default};";
Check(nativePatched.Contains(bridge), "Native bridge must expose the actual imported card builder.");
Check(nativePatched.Replace(NativeCardPatcher.Marker + bridge, "", StringComparison.Ordinal) == nativeModule,
    "Exposing the native renderer must preserve every original byte of the item detail module.");
Check(nativePatched.IndexOf(bridge, StringComparison.Ordinal) < nativePatched.IndexOf("window.ItemDetailPage=", StringComparison.Ordinal),
    "Native bridge must initialize at module execution before detail controller activation.");
Check(NativeCardPatcher.PatchJavaScript(nativePatched) == nativePatched, "Native renderer transformation must be idempotent.");
Check(WebTransformations.TransformJavaScript(new TransformationRequest { Contents = nativeModule }) == nativePatched,
    "Reflection callback must use the guarded native renderer patcher.");
string renamedModule = nativeModule.Replace("card", "otherCards", StringComparison.Ordinal).Replace(".default", ".Ay", StringComparison.Ordinal);
Check(NativeCardPatcher.PatchJavaScript(renamedModule).Contains("cardBuilder:otherCards.Ay"),
    "Native import names must be captured rather than hard-coded to a production minifier symbol.");
foreach (string unsupported in new[]
{
    "", "window.cardBuilder={buildCards:function(){}};", nativeModule + nativeModule,
    nativeModule.Replace("#collectionsCollapsible", "#otherCollapsible", StringComparison.Ordinal),
    nativeModule.Replace("getItemCollections", "getItems", StringComparison.Ordinal),
    nativeModule.Replace(".collectionsContent", ".otherContent", StringComparison.Ordinal),
    nativeModule.Replace("overflowPortrait", "portrait", StringComparison.Ordinal),
    nativeModule.Replace("card=r(24)", "card=unrelated", StringComparison.Ordinal),
    nativeModule.Replace("function Detail(e,t)", "function Different(e,t)", StringComparison.Ordinal),
    nativeModule.Replace("window.ItemDetailPage", "window.OtherDetailPage", StringComparison.Ordinal),
    nativeModule.Replace(".renderDetails=", ".otherDetails=", StringComparison.Ordinal)
})
{
    Check(NativeCardPatcher.PatchJavaScript(unsupported) == unsupported,
        "Unsupported or ambiguous modules must keep all native rendering unchanged.");
}
Guid pluginId = Guid.Parse("3edf84d9-7187-4a64-8ef4-68878d3351ce");
string scannerRoot = Path.Combine(Path.GetTempPath(), "collections-exploded-scanner-" + Guid.NewGuid().ToString("N"));
try
{
    Directory.CreateDirectory(Path.Combine(scannerRoot, "nested"));
    File.WriteAllText(Path.Combine(scannerRoot, "itemDetails.known.chunk.js"), nativeModule);
    File.WriteAllText(Path.Combine(scannerRoot, "nested", "itemDetails.other.chunk.js"), renamedModule);
    File.WriteAllText(Path.Combine(scannerRoot, "unrelated.chunk.js"), "const untouched = true;");
    File.WriteAllText(Path.Combine(scannerRoot, "already-patched.chunk.js"), nativePatched);
    File.WriteAllText(Path.Combine(scannerRoot, "not-a-chunk.js"), nativeModule);
    IReadOnlyList<WebAssetRegistration> registrations = WebAssetScanner.Discover(scannerRoot, pluginId);
    Check(registrations.Select(asset => asset.RelativePath).SequenceEqual(new[]
        { "itemDetails.known.chunk.js", "nested/itemDetails.other.chunk.js" }),
        "Register exact compatible chunk paths only, with nested paths normalized and sorted.");
    Check(registrations.Select(asset => asset.Id).Distinct().Count() == 2 && registrations.All(asset => asset.Id != pluginId),
        "Each exact chunk needs a distinct registration identity separate from index.html.");
    Check(WebAssetScanner.Discover(scannerRoot, pluginId).SequenceEqual(registrations),
        "Chunk registration identities must be stable across startup scans.");
    Check(WebAssetScanner.Discover(scannerRoot, Guid.NewGuid()).Zip(registrations).All(pair => pair.First.Id != pair.Second.Id),
        "Registration identities must be scoped to this plugin.");
    Check(WebAssetScanner.Discover(Path.Combine(scannerRoot, "missing"), pluginId).Count == 0,
        "Missing web roots must leave startup operational.");
    TransformationRegistrationService RegistrationService(string root, Version? serverVersion = null) => new(
        NullLogger<TransformationRegistrationService>.Instance,
        new TestHost(serverVersion ?? new Version(12, 0, 0)), new TestConfiguration("/server"), new TestPaths(root));
    TransformationRegistrationService missingDependency = RegistrationService(scannerRoot);
    await missingDependency.StartAsync(CancellationToken.None);
    Check(TransformationRegistry.Active.Count == 0, "A missing File Transformation dependency must leave startup operational.");
    TransformationRegistry.LoadDependency();
    TransformationRegistrationService oldServer = RegistrationService(scannerRoot, new Version(11, 0, 0));
    await oldServer.StartAsync(CancellationToken.None);
    Check(TransformationRegistry.Active.Count == 0, "Unsupported server versions must not register transformations.");
    TransformationRegistrationService cancelled = RegistrationService(scannerRoot);
    await cancelled.StartAsync(new CancellationToken(canceled: true));
    Check(TransformationRegistry.Active.Count == 0, "Cancelled startup must not register transformations.");
    TransformationRegistrationService service = RegistrationService(scannerRoot);
    await service.StartAsync(CancellationToken.None);
    Check(TransformationRegistry.Active.Count == 3, "Startup must register index.html and both compatible exact chunks.");
    Check(TransformationRegistry.Active[pluginId].Pattern == "index.html"
        && TransformationRegistry.Active[pluginId].CallbackMethod == nameof(WebTransformations.TransformIndex),
        "The existing literal index pipeline and plugin identity must be preserved.");
    Check(TransformationRegistry.Active.Values.Where(payload => payload.Id != pluginId).All(payload =>
        payload.CallbackMethod == nameof(WebTransformations.TransformJavaScript)
        && payload.CallbackClass == typeof(WebTransformations).FullName
        && payload.CallbackAssembly == typeof(WebTransformations).Assembly.FullName
        && registrations.Any(asset => asset.Id == payload.Id && asset.RelativePath == payload.Pattern)),
        "Native chunk payloads must use exact paths, stable IDs, and the public synchronous callback.");
    Check(WebTransformations.TransformIndex(new TransformationRequest { Contents = html }).Contains("/server/CollectionsExploded/ClientScript"),
        "Startup must configure the existing base-path-aware bootstrap callback.");
    await service.StartAsync(CancellationToken.None);
    Check(TransformationRegistry.Active.Count == 3, "Repeated startup must not register duplicate callbacks.");
    await service.StopAsync(CancellationToken.None);
    Check(TransformationRegistry.Active.Count == 0 && TransformationRegistry.Removed.Count == 3
        && TransformationRegistry.Removed.Contains(pluginId)
        && registrations.All(asset => TransformationRegistry.Removed.Contains(asset.Id)),
        "Shutdown must remove the index callback and every registered native chunk callback.");
    await service.StopAsync(CancellationToken.None);
    Check(TransformationRegistry.Removed.Count == 3, "Repeated shutdown must not remove callbacks twice.");
    TransformationRegistry.FailPattern = "nested/itemDetails.other.chunk.js";
    await service.StartAsync(CancellationToken.None);
    Check(TransformationRegistry.Active.Count == 0, "A partial registration failure must remove all callbacks already registered.");
    TransformationRegistry.FailPattern = null;
    await service.StartAsync(CancellationToken.None);
    Check(TransformationRegistry.Active.Count == 3, "The registration service must be able to retry after a partial failure.");
    await service.StopAsync(CancellationToken.None);
    TransformationRegistrationService noChunks = RegistrationService(Path.Combine(scannerRoot, "missing"));
    await noChunks.StartAsync(CancellationToken.None);
    Check(TransformationRegistry.Active.Count == 1 && TransformationRegistry.Active.ContainsKey(pluginId),
        "An unsupported or absent web directory must preserve the index bootstrap without wildcard registrations.");
    await noChunks.StopAsync(CancellationToken.None);
}
finally
{
    if (Directory.Exists(scannerRoot)) Directory.Delete(scannerRoot, recursive: true);
}

// The compatibility workflow supplies complete official Jellyfin Web fixture directories.
// Write the exact C# result so the JavaScript verifier can execute the transformed module.
IEnumerable<string> fixtureDirectories = args.Length > 0 ? args
    : Directory.Exists(".research/fixtures") ? Directory.EnumerateDirectories(".research/fixtures") : Array.Empty<string>();
foreach (string fixtureDirectory in fixtureDirectories)
{
    string[] details = Directory.GetFiles(fixtureDirectory, "itemDetails.*.chunk.js", SearchOption.TopDirectoryOnly);
    Check(details.Length == 1, "Each official fixture directory must contain one complete native item detail chunk.");
    string original = File.ReadAllText(details[0]);
    string transformed = NativeCardPatcher.PatchJavaScript(original);
    Check(original != transformed && transformed.Contains(NativeCardPatcher.Marker),
        "The guarded native bridge must recognize the complete official item detail module: " + fixtureDirectory);
    Check(NativeCardPatcher.PatchJavaScript(transformed) == transformed,
        "The complete official item detail transformation must remain idempotent.");
    Check(WebAssetScanner.Discover(fixtureDirectory, pluginId).Select(asset => asset.RelativePath)
        .SequenceEqual(new[] { Path.GetFileName(details[0]) }),
        "Only the official item detail chunk may receive a native renderer registration.");
    File.WriteAllText(details[0] + ".patched.js", transformed);
    Console.WriteLine("Verified native renderer bridge: " + details[0]);
}
Console.WriteLine($"Passed {checks} server configuration, controller, asset, HTML, native renderer and registration checks.");
