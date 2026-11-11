/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./core.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        const TAG = "[AzureIllusion]"
        const DEFAULT_BASE = "https://azureillusion-nuvio-addon.skoruppa.workers.dev"

        // Remember what we already injected so one episode isn't injected twice
        let lastKey = ""

        // ---------- helpers ----------

        function srtToVtt(srt: string): string {
            const body = srt
                .replace(/^\uFEFF/, "")
                .replace(/\r+\n/g, "\n")
                .replace(/\r/g, "\n")
                .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
            return "WEBVTT\n\n" + body
        }

        function detectType(url: string, content: string): "ass" | "vtt" | "srt" {
            const clean = (url || "").split("?")[0].toLowerCase()
            if (clean.endsWith(".ass") || clean.endsWith(".ssa")) return "ass"
            if (clean.endsWith(".vtt")) return "vtt"
            if (clean.endsWith(".srt")) return "srt"
            const head = (content || "").slice(0, 200)
            if (head.includes("[Script Info]")) return "ass"
            if (head.trim().startsWith("WEBVTT")) return "vtt"
            return "srt"
        }

        // The exact shape of playback info differs a bit between playback types,
        // so we probe several likely places and log everything for debugging.
        function readEpisodeNumber(info: any, state: any): number | null {
            const candidates = [
                info?.episode?.progressNumber,
                info?.episode?.episodeNumber,
                info?.episodeNumber,
                state?.playbackInfo?.episode?.progressNumber,
                state?.playbackInfo?.episode?.episodeNumber,
                state?.playbackInfo?.episodeNumber,
            ]
            for (const c of candidates) {
                const n = Number(c)
                if (c !== undefined && c !== null && !isNaN(n) && n > 0) return n
            }
            return null
        }

        async function doFetch(url: string): Promise<any> {
            // ctx.fetch is the UI-context fetch; fall back to the global one
            const f = (ctx as any).fetch ?? (globalThis as any).fetch
            console.log(TAG, "fetch ->", url.replace(/\/[^/]{8,}\/subtitles/, "/***/subtitles"))
            try {
                const r = await f(url)
                console.log(TAG, "fetch <- status:", r?.status, "ok:", r?.ok)
                return r
            } catch (e) {
                console.error(TAG, "fetch FAILED:", String(e))
                throw e
            }
        }

        // ---------- main logic ----------

        async function injectSubtitles(trigger: string) {
            try {
                const apiKey = ($getUserPreference("apiKey") || "").trim()
                const baseUrl = (($getUserPreference("baseUrl") || DEFAULT_BASE) as string).replace(/\/+$/, "")

                if (!apiKey) {
                    console.error(TAG, "Brak klucza API w ustawieniach wtyczki.")
                    return
                }

                const media: any = ctx.videoCore.getCurrentMedia()
                const info: any = ctx.videoCore.getCurrentPlaybackInfo()
                const state: any = ctx.videoCore.getPlaybackState()

                console.log(TAG, `(${trigger}) media:`, JSON.stringify(media)?.slice(0, 300))
                console.log(TAG, `(${trigger}) playbackInfo:`, JSON.stringify(info)?.slice(0, 600))

                const anilistId = media?.id
                const episode = readEpisodeNumber(info, state)

                if (!anilistId || !episode) {
                    console.warn(TAG, "Nie udało się ustalić AniList ID / numeru odcinka.", anilistId, episode)
                    return
                }

                const key = `${anilistId}:${episode}`
                if (key === lastKey) return
                lastKey = key

                const url = `${baseUrl}/${apiKey}/subtitles/anime/anilist:${anilistId}:${episode}.json`
                console.log(TAG, "Zapytanie:", url.replace(apiKey, "***"))

                const res = await doFetch(url)
                if (!res.ok) {
                    console.error(TAG, "Błąd HTTP:", res.status)
                    lastKey = "" // allow retry
                    return
                }

                const data = await res.json()
                const subs: any[] = data?.subtitles ?? []
                if (!subs.length) {
                    console.log(TAG, "Brak napisów dla tego odcinka.")
                    ctx.videoCore.showMessage("AzureIllusion: brak napisów PL", 2500)
                    return
                }

                let added = 0
                for (const sub of subs) {
                    if (!sub?.url) continue
                    try {
                        // Download the file ourselves, so no CORS / header problems in the player
                        const subRes = await doFetch(sub.url)
                        if (!subRes.ok) {
                            console.warn(TAG, "Nie udało się pobrać napisów:", sub.url, subRes.status)
                            continue
                        }
                        const text: string = await subRes.text()
                        const type = detectType(sub.url, text)

                        ctx.videoCore.addExternalSubtitleTrack({
                            label: sub.title || sub.label || "[PL] AzureIllusion",
                            language: "pl",
                            type: type === "srt" ? "vtt" : type,
                            content: type === "srt" ? srtToVtt(text) : text,
                        })
                        added++
                    } catch (e) {
                        console.error(TAG, "Błąd przy dodawaniu ścieżki:", e)
                    }
                }

                if (added > 0) {
                    ctx.videoCore.showMessage(`AzureIllusion: dodano napisy PL (${added})`, 2500)
                } else {
                    lastKey = ""
                }
            } catch (err) {
                console.error(TAG, "Wyjątek:", err)
                lastKey = ""
            }
        }

        // Fires when the player has loaded the video metadata (track list is ready)
        ctx.videoCore.addEventListener("video-loaded-metadata", () => {
            injectSubtitles("video-loaded-metadata")
        })

        // Reset on new playback so the next episode gets its subtitles
        ctx.videoCore.addEventListener("video-loaded", () => {
            lastKey = ""
        })

        console.log(TAG, "Wtyczka załadowana.")
    })
}
