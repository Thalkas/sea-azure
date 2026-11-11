/// <reference path="../../core.d.ts" />
/// <reference path="../../plugin.d.ts" />
/// <reference path="../../app.d.ts" />
/// <reference path="../../system.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        const tray = ctx.newTray({
            iconUrl: "https://raw.githubusercontent.com/Thalkas/sea-azure/main/azureillusion-logo-v3.png",
            withContent: true,
            width: "600px"
        });

        const subtitleResults = ctx.state<any[]>([]);
        const isSearching = ctx.state<boolean>(false);
        const lastSearchedKey = ctx.state<string>("");

        async function injectSubtitle(sub: any) {
            try {
                await ctx.videoCore.addExternalSubtitleTrack({
                    src: sub.url,
                    label: sub.title || "[PL] AzureIllusion",
                    language: "pl",
                    type: sub.format.toLowerCase(),
                });
                ctx.toast.success("Dodano napisy pomyślnie!");
            } catch (err) {
                ctx.toast.error("Nie udało się wstrzyknąć napisów", err);
            }
        }

        async function fetchAzureSubtitles() {
            const apiKey = $getUserPreference("apiKey");
            const baseUrl = $getUserPreference("baseUrl") || "https://azureillusion-nuvio-addon.skoruppa.workers.dev";

            if (!apiKey) {
                ctx.toast.warning("Wpisz klucz API w ustawieniach wtyczki!");
                return;
            }

            try {
                isSearching.set(true);
                const info = await ctx.videoCore.getCurrentPlaybackInfo();
                const anilistId = info.media?.id;
                const episode = info.episode?.episodeNumber || 1;

                if (!anilistId) {
                    ctx.toast.warning("Brak aktywnego AniList ID");
                    return;
                }

                const streamId = `anilist:${anilistId}:${episode}`;
                const requestUrl = `${baseUrl}/${apiKey}/subtitles/anime/${streamId}.json`;

                const response = await fetch(requestUrl);
                if (!response.ok) {
                    subtitleResults.set([]);
                    return;
                }

                const data = await response.json();
                if (!data.subtitles || data.subtitles.length === 0) {
                    subtitleResults.set([]);
                    return;
                }

                const mapped = data.subtitles.map((sub: any) => ({
                    id: sub.id || sub.url,
                    url: sub.url,
                    language: "PL",
                    title: sub.title || "[PL] AzureIllusion",
                    format: sub.url.endsWith(".ass") ? "ass" : "srt",
                }));

                subtitleResults.set(mapped);
                tray.update();
            } catch (err) {
                console.error("[AzureIllusion] Błąd pobierania:", err);
                ctx.toast.error("Błąd połączenia z API AzureIllusion");
            } finally {
                isSearching.set(false);
            }
        }

        // Automatyczne pobranie po starcie tray'a
        fetchAzureSubtitles();
    });
}
