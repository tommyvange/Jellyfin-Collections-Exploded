using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.CollectionsExploded.Transformations;

/// <summary>Conservative, idempotent modification of complete HTML documents only.</summary>
public static class IndexPatcher
{
    public const string BootstrapId = "jellyfin-collections-exploded-bootstrap";

    private static readonly Regex Document = new(
        @"\A\s*<!doctype\s+html\b[^>]*>\s*<html(?:\s[^>]*)?>[\s\S]*</html\s*>\s*\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking,
        TimeSpan.FromSeconds(1));
    private static readonly Regex HeadOpen = new(@"<head(?:\s[^>]*)?>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);
    private static readonly Regex BodyOpen = new(@"<body(?:\s[^>]*)?>",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.NonBacktracking);

    public static string Patch(string contents, string? basePath, string version)
    {
        if (string.IsNullOrEmpty(contents) || contents.Contains(BootstrapId, StringComparison.Ordinal)
            || !Document.IsMatch(contents))
        {
            return contents;
        }
        Match head = HeadOpen.Match(contents);
        int headEnd = contents.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        Match body = BodyOpen.Match(contents);
        int bodyEnd = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (!head.Success || headEnd <= head.Index || !body.Success || body.Index <= headEnd || bodyEnd <= body.Index)
        {
            return contents;
        }

        string prefix;
        try
        {
            prefix = NormalizeBasePath(basePath);
        }
        catch (ArgumentException)
        {
            // Leave the native client intact when server configuration is malformed.
            return contents;
        }
        string versionQuery = "?v=" + Uri.EscapeDataString(version);
        string script = WebUtility.HtmlEncode(prefix + "/CollectionsExploded/ClientScript" + versionQuery);
        string stylesheet = WebUtility.HtmlEncode(prefix + "/CollectionsExploded/Stylesheet" + versionQuery);
        string injection = "<link id=\"jellyfin-collections-exploded-styles\" rel=\"stylesheet\" href=\"" + stylesheet
            + "\">\n<script id=\"" + BootstrapId + "\" defer src=\"" + script + "\"></script>\n";
        // Deferred scripts execute in document order. Register lifecycle listeners before
        // Jellyfin's own deferred bundles can show the initial media detail page.
        return contents.Insert(head.Index + head.Length, injection);
    }

    public static string NormalizeBasePath(string? value)
    {
        string path = value?.Trim().Trim('/') ?? string.Empty;
        if (path.Length == 0) return string.Empty;
        // Jellyfin passes BaseUrl to app.Map(string), which decodes a URI component
        // into PathString. Match those semantics so existing % escapes survive once.
        string decoded = Uri.UnescapeDataString(path);
        if (decoded.Contains('\\') || decoded.Contains('?') || decoded.Contains('#') || decoded.Contains(':')
            || decoded.Any(char.IsControl) || decoded.Split('/').Any(segment => segment is "." or ".."))
        {
            throw new ArgumentException("Jellyfin BaseUrl must be a local URL path.", nameof(value));
        }
        return PathString.FromUriComponent("/" + path).ToUriComponent();
    }
}
