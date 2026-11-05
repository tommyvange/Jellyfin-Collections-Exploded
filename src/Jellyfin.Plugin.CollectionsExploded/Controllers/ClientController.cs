using System.Text;
using Jellyfin.Plugin.CollectionsExploded.Configuration;
using Jellyfin.Plugin.CollectionsExploded.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.CollectionsExploded.Controllers;

/// <summary>Authenticated viewer settings and public, settings-free bootstrap assets.</summary>
[ApiController]
[Route("CollectionsExploded")]
public sealed class ClientController : ControllerBase
{
    [Authorize]
    [HttpGet("Settings")]
    [ResponseCache(NoStore = true, Location = ResponseCacheLocation.None)]
    public ActionResult<EffectiveSettings> GetSettings()
    {
        Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
        Response.Headers.Pragma = "no-cache";
        return Plugin.Instance is { } plugin
            ? plugin.Configuration.GetEffectiveSettings()
            : StatusCode(503);
    }

    [AllowAnonymous]
    [HttpGet("ClientScript")]
    public ContentResult GetClientScript([FromQuery(Name = "v")] string? version = null)
    {
        SetAssetCacheHeaders(version);
        return Content(EmbeddedAssets.ClientScript, "application/javascript", Encoding.UTF8);
    }

    [AllowAnonymous]
    [HttpGet("Stylesheet")]
    public ContentResult GetStylesheet([FromQuery(Name = "v")] string? version = null)
    {
        SetAssetCacheHeaders(version);
        return Content(EmbeddedAssets.Stylesheet, "text/css", Encoding.UTF8);
    }

    private void SetAssetCacheHeaders(string? version)
    {
        // An unversioned request or an old URL after an upgrade must revalidate.
        Response.Headers.CacheControl = string.Equals(version, EmbeddedAssets.Version, StringComparison.Ordinal)
            ? "public, max-age=31536000, immutable"
            : "no-store";
        Response.Headers.XContentTypeOptions = "nosniff";
    }
}
