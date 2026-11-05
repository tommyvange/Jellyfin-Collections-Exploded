using Jellyfin.Plugin.CollectionsExploded.Configuration;

namespace Jellyfin.Plugin.CollectionsExploded;

// Controllers are tested with the real ASP.NET framework and a minimal plugin host.
public sealed class Plugin
{
    public static readonly Guid PluginGuid = Guid.Parse("3edf84d9-7187-4a64-8ef4-68878d3351ce");

    public static Plugin? Instance { get; set; }

    public PluginConfiguration Configuration { get; set; } = new();
}
