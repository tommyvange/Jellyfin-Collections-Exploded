using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.CollectionsExploded.Transformations;

/// <summary>Exposes the card builder already imported by the native item detail module.</summary>
public static class NativeCardPatcher
{
    public const string Marker = "/* jellyfin-collections-exploded-native:1 */";
    private const string Identifier = @"[A-Za-z_$][\w$]*";
    private static readonly TimeSpan RegexTimeout = TimeSpan.FromSeconds(2);

    public static string PatchJavaScript(string source)
    {
        if (string.IsNullOrEmpty(source) || source.Contains(Marker, StringComparison.Ordinal)) return source;
        const string collections = "\"#collectionsCollapsible\"";
        const string similar = "\"#similarCollapsible\"";
        const string setup = "window.ItemDetailPage=new function(){";
        int collectionStart = source.IndexOf(collections, StringComparison.Ordinal);
        int requestStart = source.IndexOf(".getItemCollections(", StringComparison.Ordinal);
        int similarStart = source.IndexOf(similar, StringComparison.Ordinal);
        int setupStart = source.IndexOf(setup, StringComparison.Ordinal);
        if (collectionStart < 0 || requestStart <= collectionStart || similarStart <= requestStart
            || setupStart <= similarStart || Count(source, collections) != 1
            || Count(source, ".getItemCollections(") != 1 || Count(source, setup) != 1)
        {
            return source;
        }

        // Match the native collection call and options together. This avoids exposing an
        // unrelated card builder if Jellyfin reorganizes or replaces its detail renderer.
        string collectionCode = source[collectionStart..similarStart];
        string builderPattern = @"(?<builder>(?<import>" + Identifier + @")\." + Identifier + @")\.buildCards\(" + Identifier
            + @",\{parentContainer:(?<container>" + Identifier + @"),itemsContainer:\k<container>\.querySelector\(""\.collectionsContent""\)"
            + @",shape:""overflowPortrait"",sectionTitleTagName:""h2"",scalable:!0,centerText:!0,showTitle:!0"
            + @",showParentTitle:!1,overlayText:!1,overlayPlayButton:!1,coverImage:!0,showYear:";
        Match[] builders = Regex.Matches(collectionCode, builderPattern, RegexOptions.CultureInvariant, RegexTimeout)
            .Cast<Match>().ToArray();
        if (builders.Length != 1 || !collectionCode.Contains("getItemCollections({itemId:", StringComparison.Ordinal)) return source;
        Match builder = builders[0];

        // The exposed expression must be an existing webpack import in the same module.
        // Capture the minified require argument from that module's native default export.
        string modulePattern = @"[0-9]+:function\(" + Identifier + @",(?<exports>" + Identifier + @"),(?<require>" + Identifier
            + @")\)\{\k<require>\.r\(\k<exports>\),\k<require>\.d\(\k<exports>,\{default:function\(\)\{return (?<controller>" + Identifier + @")\}\}\)";
        Match[] modules = Regex.Matches(source[..collectionStart], modulePattern, RegexOptions.CultureInvariant, RegexTimeout)
            .Cast<Match>().ToArray();
        if (modules.Length != 1) return source;
        Match module = modules[0];
        string importPattern = @"(?:var |,)" + Regex.Escape(builder.Groups["import"].Value) + "="
            + Regex.Escape(module.Groups["require"].Value) + @"\([0-9]+\)(?:,|;)";
        string preamble = source[module.Index..collectionStart];
        if (Regex.Matches(preamble, importPattern, RegexOptions.CultureInvariant, RegexTimeout).Count != 1) return source;
        string controllerPattern = @"function " + Regex.Escape(module.Groups["controller"].Value)
            + @"\(" + Identifier + @"," + Identifier + @"\)\{";
        if (Regex.Matches(source[similarStart..setupStart], controllerPattern, RegexOptions.CultureInvariant, RegexTimeout).Count != 1) return source;
        int setupEnd = source.IndexOf('}', setupStart + setup.Length);
        if (setupEnd < 0) return source;
        string nativeSetup = source[setupStart..setupEnd];
        if (!nativeSetup.Contains(".renderDetails=", StringComparison.Ordinal)
            || !nativeSetup.Contains(".renderCast=", StringComparison.Ordinal)) return source;

        // This module-level statement runs once after its imports initialize, before the
        // detail controller can register or dispatch viewshow. Native rendering is untouched.
        string injection = Marker + "window.JellyfinCollectionsExplodedNative={version:1,cardBuilder:"
            + builder.Groups["builder"].Value + "};";
        return source.Insert(setupStart, injection);
    }

    private static int Count(string source, string value) =>
        (source.Length - source.Replace(value, string.Empty, StringComparison.Ordinal).Length) / value.Length;
}
