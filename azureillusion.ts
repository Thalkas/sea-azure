/// <reference path="../../core.d.ts" />
/// <reference path="../../plugin.d.ts" />
/// <reference path="../../app.d.ts" />
/// <reference path="../../system.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        // Rejestrujemy jako dostawca napisów (subtitle provider)
        Seanime.registerSubtitleProvider({
            id: "azureillusion-subs",
            name: "AzureIllusion (PL)",
            version: "1.0.3",

            async searchSubtitles(media: any) {
                const apiKey = $getUserPreference("apiKey");
                const baseUrl = $getUserPreference("baseUrl") || "https://azureillusion-nuvio-addon.skoruppa.workers.dev";

                console.log("[AzureIllusion] Rozpoczęto szukanie napisów. AniList ID:", media.anilistId, "Odcinek:", media.episodeNumber);

                if (!apiKey) {
                    console.error("[AzureIllusion] BŁĄD: Brak klucza API w preferencjach wtyczki!");
                    return [];
                }

                const anilistId = media.anilistId;
                const episode = media.episodeNumber || 1;

                if (!anilistId) {
                    console.warn("[AzureIllusion] Brak AniList ID w obiekcie media.");
                    return [];
                }

                const streamId = `anilist:${anilistId}:${episode}`;
                const requestUrl = `${baseUrl}/${apiKey}/subtitles/anime/${streamId}.json`;
                console.log("[AzureIllusion] Wysyłam zapytanie do URL:", requestUrl);

                try {
                    const response = await fetch(requestUrl);
                    console.log("[AzureIllusion] Status odpowiedzi HTTP:", response.status);

                    if (!response.ok) {
                        console.error("[AzureIllusion] Serwer zwrócił błąd HTTP:", response.status);
                        return [];
                    }

                    const data = await response.json();
                    console.log("[AzureIllusion] Otrzymane dane z API:", data);

                    if (!data.subtitles || data.subtitles.length === 0) {
                        console.log("[AzureIllusion] Brak napisów w odpowiedzi dla tego odcinka.");
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
                    console.error("[AzureIllusion] Wyjątek podczas fetchowania:", err);
                    return [];
                }
            }
        });
    });
}
