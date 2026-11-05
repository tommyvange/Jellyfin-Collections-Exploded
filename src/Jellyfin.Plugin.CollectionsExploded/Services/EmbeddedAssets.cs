using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.CollectionsExploded.Services;

/// <summary>Immutable resources with a content-derived cache key, independent of runtime settings.</summary>
public static class EmbeddedAssets
{
    private static readonly Lazy<string> Script = new(() => Read("collections-exploded.js"));
    private static readonly Lazy<string> Styles = new(() => Read("collections-exploded.css"));
    private static readonly Lazy<string> ContentVersion = new(() =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            typeof(EmbeddedAssets).Assembly.GetName().Version + "\n" + Script.Value + "\n" + Styles.Value)))
            .ToLowerInvariant()[..20]);

    public static string ClientScript => Script.Value;

    public static string Stylesheet => Styles.Value;

    public static string Version => ContentVersion.Value;

    private static string Read(string name)
    {
        using Stream stream = typeof(EmbeddedAssets).Assembly.GetManifestResourceStream(
            "Jellyfin.Plugin.CollectionsExploded.Web." + name)
            ?? throw new InvalidOperationException("Missing embedded Collections Exploded resource: " + name);
        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
