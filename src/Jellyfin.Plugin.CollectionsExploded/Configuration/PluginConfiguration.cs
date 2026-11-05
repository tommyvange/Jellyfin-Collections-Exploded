using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.CollectionsExploded.Configuration;

/// <summary>Administrator-owned display settings shared by all viewers.</summary>
public sealed class PluginConfiguration : BasePluginConfiguration
{
    public const int DefaultMaximum = 20;
    public const int MinimumMaximum = 1;
    public const int MaximumMaximum = 100;
    public const string DefaultSortBy = "ProductionYear";
    public const string DefaultSortOrder = "Ascending";

    public bool Enabled { get; set; } = true;

    public int MaxItemsPerCollection { get; set; } = DefaultMaximum;

    public string SortBy { get; set; } = DefaultSortBy;

    public string SortOrder { get; set; } = DefaultSortOrder;

    public static bool IsSupportedSortBy(string? value) =>
        value is "ProductionYear" or "SortName" or "DateCreated" or "PremiereDate";

    public static bool IsSupportedSortOrder(string? value) =>
        value is "Ascending" or "Descending";

    /// <summary>Repairs obsolete or manually edited configuration without changing its stored form.</summary>
    public EffectiveSettings GetEffectiveSettings() => new(
        Enabled,
        Math.Clamp(MaxItemsPerCollection, MinimumMaximum, MaximumMaximum),
        IsSupportedSortBy(SortBy) ? SortBy : DefaultSortBy,
        IsSupportedSortOrder(SortOrder) ? SortOrder : DefaultSortOrder);

    /// <summary>Reject invalid administrator writes before the native plugin API persists them.</summary>
    public void Validate()
    {
        if (MaxItemsPerCollection is < MinimumMaximum or > MaximumMaximum)
        {
            throw new ArgumentOutOfRangeException(nameof(MaxItemsPerCollection), MaxItemsPerCollection,
                "Maximum items per collection must be between 1 and 100.");
        }
        if (!IsSupportedSortBy(SortBy))
        {
            throw new ArgumentException("Choose a supported collection sort field.", nameof(SortBy));
        }
        if (!IsSupportedSortOrder(SortOrder))
        {
            throw new ArgumentException("Sort order must be Ascending or Descending.", nameof(SortOrder));
        }
    }
}
