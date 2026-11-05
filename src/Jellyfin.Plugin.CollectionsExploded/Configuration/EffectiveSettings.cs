using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.CollectionsExploded.Configuration;

/// <summary>Only the non-sensitive settings required by an authenticated web viewer.</summary>
public sealed record EffectiveSettings(
    [property: JsonPropertyName("enabled")] bool Enabled,
    [property: JsonPropertyName("maxItemsPerCollection")] int MaxItemsPerCollection,
    [property: JsonPropertyName("sortBy")] string SortBy,
    [property: JsonPropertyName("sortOrder")] string SortOrder);
