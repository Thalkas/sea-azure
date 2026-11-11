/// <reference path="../../core.d.ts" />
/// <reference path="../../plugin.d.ts" />
/// <reference path="../../app.d.ts" />
/// <reference path="../../system.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        // Nasłuchiwanie lub obsługa żądań napisów w sesji odtwarzacza
        ctx.videoCore.onPlaybackStarted(async () => {
            const apiKey = $getUserPreference("apiKey");
            const baseUrl = $getUserPreference("baseUrl") || "https://azureillusion-nuvio-addon.skoruppa.workers.dev";

            if (!apiKey) return;

            try {
                const info = await ctx.videoCore.getCurrentPlaybackInfo();
                const anilistId = info.media?.id;
                const episode = info.episode?.episodeNumber || 1;

                if (!anilistId) return;

                const streamId = `anilist:${anilistId}:${episode}`;
                const requestUrl = `${baseUrl}/${apiKey}/subtitles/anime/${streamId}.json`;

                const response = await fetch(requestUrl);
                if (!response.ok) return;

                const data = await response.json();
                if (!data.subtitles || data.subtitles.length === 0) return;

                for (const sub of data.subtitles) {
                    await ctx.videoCore.addExternalSubtitleTrack({
                        src: sub.url,
                        label: sub.title || "[PL] AzureIllusion",
                        language: "pl",
                        type: sub.url.endsWith(".ass") ? "ass" : "srt",
                    });
                }
            } catch (err) {
                console.error("[AzureIllusion] Błąd wstrzykiwania napisów:", err);
            }
        });
    });
}
