/// <reference path="../../core.d.ts" />
/// <reference path="../../plugin.d.ts" />
/// <reference path="../../app.d.ts" />
/// <reference path="../../system.d.ts" />

Seanime.registerSubtitleProvider({
    id: "azureillusion-subs",
    name: "AzureIllusion (PL)",
    version: "1.0.2",

    async searchSubtitles(media: any) {
        const apiKey = $getUserPreference("apiKey");
        const baseUrl = $getUserPreference("baseUrl") || "https://azureillusion-nuvio-addon.skoruppa.workers.dev";

        if (!apiKey) {
            console.error("[AzureIllusion] Brak klucza API! Wpisz go w ustawieniach rozszerzenia w Seanime.");
            return [];
        }

        const anilistId = media.anilistId;
        const episode = media.episodeNumber || 1;

        if (!anilistId) {
            return [];
        }

        const streamId = `anilist:${anilistId}:${episode}`;
        const requestUrl = `${baseUrl}/${apiKey}/subtitles/anime/${streamId}.json`;

        try {
            const response = await fetch(requestUrl);
            if (!response.ok) {
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
                title: sub.title || "[PL] AzureIllusion",
                format: sub.url && sub.url.endsWith(".ass") ? "ass" : "srt",
                headers: {
                    "Authorization": apiKey
                }
            }));

        } catch (err) {
            console.error("[AzureIllusion] Błąd pobierania:", err);
            return [];
        }
    }
});
