/// <reference path="../../core.d.ts" />
/// <reference path="../../plugin.d.ts" />
/// <reference path="../../app.d.ts" />
/// <reference path="../../system.d.ts" />

Seanime.registerSubtitleProvider({
    id: "azureillusion-subs",
    name: "AzureIllusion (PL)",
    version: "1.0.0",

    async searchSubtitles(media) {
        const apiKey = $getUserPreference("apiKey");
        const baseUrl = $getUserPreference("baseUrl") || "https://azureillusion-nuvio-addon.skoruppa.workers.dev";

        if (!apiKey) {
            console.error("[AzureIllusion] Brak klucza API! Wpisz go w ustawieniach rozszerzenia w Seanime.");
            return [];
        }

        const anilistId = media.anilistId;
        const episode = media.episodeNumber || 1;

        if (!anilistId) {
            console.warn("[AzureIllusion] Brak AniList ID dla tego tytułu.");
            return [];
        }

        const streamId = `anilist:${anilistId}:${episode}`;
        const requestUrl = `${baseUrl}/${apiKey}/subtitles/anime/${streamId}.json`;

        try {
            const response = await fetch(requestUrl);
            if (!response.ok) {
                console.error(`[AzureIllusion] Błąd API HTTP: ${response.status}`);
                return [];
            }

            const data = await response.json();
            if (!data.subtitles || data.subtitles.length === 0) {
                return [];
            }

            return data.subtitles.map((sub: any) => ({
                id: sub.id || sub.url,
                url: sub.url,
                language: "PL",
                title: sub.title || `[PL] AzureIllusion`,
                format: sub.url.endsWith(".ass") ? "ass" : "srt",
                headers: {
                    "Authorization": apiKey
                }
            }));

        } catch (err) {
            console.error("[AzureIllusion] Wystąpił błąd podczas pobierania napisów:", err);
            return [];
        }
    }
});
