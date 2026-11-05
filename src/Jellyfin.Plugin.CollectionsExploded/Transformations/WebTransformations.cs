using Jellyfin.Plugin.CollectionsExploded.Services;

namespace Jellyfin.Plugin.CollectionsExploded.Transformations;

/// <summary>File Transformation requires a public synchronous callback returning a plain string.</summary>
public static class WebTransformations
{
    internal static Func<string> BasePathProvider { get; set; } = static () => string.Empty;

    // Always bootstrap: settings are checked on every page activation, so enabling later needs no restart.
    public static string TransformIndex(TransformationRequest request) =>
        IndexPatcher.Patch(request.Contents, BasePathProvider(), EmbeddedAssets.Version);

    public static string TransformJavaScript(TransformationRequest request) =>
        NativeCardPatcher.PatchJavaScript(request.Contents);
}
