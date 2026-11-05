using Jellyfin.Plugin.CollectionsExploded.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.CollectionsExploded;

/// <summary>The Collections Exploded plugin and its administrator configuration page.</summary>
public sealed class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public const string PluginId = "3edf84d9-7187-4a64-8ef4-68878d3351ce";
    public static readonly Guid PluginGuid = Guid.Parse(PluginId);

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Collections Exploded";

    public override Guid Id => PluginGuid;

    public override string Description =>
        "Show a separate media row for every collection containing the item on Jellyfin web detail pages.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = "CollectionsExploded",
            EmbeddedResourcePath = "Jellyfin.Plugin.CollectionsExploded.Web.config.html"
        };
    }

    public override void UpdateConfiguration(BasePluginConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        if (configuration is not PluginConfiguration settings)
        {
            throw new ArgumentException("Unexpected Collections Exploded configuration type.", nameof(configuration));
        }
        settings.Validate();
        base.UpdateConfiguration(settings);
    }
}
