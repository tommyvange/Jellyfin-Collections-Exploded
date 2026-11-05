Use Jellyfin’s stock theme-controlled collection-heading arrow. Keep the native empty icon span and remove the extra literal chevron, so the active theme controls its appearance.

Use Jellyfin’s native card renderer and row elements for theme compatibility.

- Replace custom cards and scrolling CSS with the same card builder, section markup, emby-scroller, and emby-itemscontainer used by Jellyfin.
- Include native play overlays, item menus, lazy images, keyboard behavior, and responsive card sizing.
- Preserve the native Collections section when the guarded rendering bridge is unavailable.

Collections Exploded for the server-hosted Jellyfin Web client.

- Replace the combined Collections section on media detail pages with a separate linked row for every accessible containing collection.
- Choose up to 100 items per row and sort by year, title, date added, or release date.
- Preserve the native Collections section when configuration or membership discovery cannot complete.
- Keep collection headings available for empty rows and failed previews, with retry controls for content requests.

Install File Transformation 3.x matching your Jellyfin server version before installing Collections Exploded. Restart Jellyfin and reload the web client after installation.

Requires Jellyfin 12.0.0 or newer. Applies to the Jellyfin Web interface served by the server.
