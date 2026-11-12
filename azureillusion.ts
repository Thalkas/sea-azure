/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./core.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        const TAG = "[AzureIllusion]"
        const DEFAULT_BASE = "https://azureillusion-nuvio-addon.skoruppa.workers.dev"

        const INJECT_DELAY_MS = 2000
        // false = send subtitle text to the player; true = send only the file URL
        const USE_URL = false

        // Shown in the menu when the API doesn't tell us the fansub group
        const FALLBACK_NAME = "AzureIllusion"

        // The API puts a readable name in each subtitle's "id", e.g.
        //   "Miroro-sub [ASS] 12/12 WEB (05.11)"  = group [format] translated/total source (date)
        // false = the menu shows only the group name ("Miroro-sub"); the full id is used just
        // when one group has several releases for the episode, so they can be told apart.
        // true  = always show the full id.
        const ALWAYS_SHOW_DETAILS = false

        // Remember what we already injected so one episode isn't injected twice
        let lastKey = ""

        // ---------- helpers ----------

        // Replaces the API key with [REDACTED] in anything we log
        function redact(text: string): string {
            try {
                const key = ($getUserPreference("apiKey") || "").trim()
                if (!key) return text
                return text.split(key).join("[REDACTED]")
            } catch (_) {
                return text
            }
        }

        // "Miroro-sub [ASS] 12/12 WEB (05.11)" -> "Miroro-sub"
        function groupFromId(id: string): string {
            return id.replace(/\s*\[(ASS|SSA|SRT)\].*$/i, "").trim()
        }

        function srtToVtt(srt: string): string {
            const body = srt
                .replace(/^﻿/, "")
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
        // so we probe several likely places.
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
            console.log(TAG, "fetch ->", redact(url))
            try {
                const r = await f(url)
                console.log(TAG, "fetch <- status:", r?.status, "ok:", r?.ok)
                return r
            } catch (e) {
                console.error(TAG, "fetch FAILED:", redact(String(e)))
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
                console.log(TAG, "Zapytanie:", redact(url))

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
                const nameCount: Record<string, number> = {}

                // How many releases each group has, to know when the group name alone is ambiguous
                const groupCounts: Record<string, number> = {}
                for (const s of subs) {
                    const g = typeof s?.id === "string" ? groupFromId(s.id) : ""
                    if (g) groupCounts[g] = (groupCounts[g] || 0) + 1
                }

                for (const sub of subs) {
                    if (!sub?.url) continue
                    try {
                        // Shows which fields the API really returns (the key is masked)
                        console.log(TAG, "Dane napisów z API:", redact(JSON.stringify(sub)))

                        // Download the file ourselves, so no CORS / header problems in the player
                        const subRes = await doFetch(sub.url)
                        if (!subRes.ok) {
                            console.warn(TAG, "Nie udało się pobrać napisów:", redact(sub.url), subRes.status)
                            continue
                        }
                        const text: string = await subRes.text()
                        const type = detectType(sub.url, text)

                        // Label = fansub group name taken from the id. If the group has several releases
                        // (or ALWAYS_SHOW_DETAILS is on), show the full id (progress, source, date).
                        const fullId = typeof sub.id === "string" ? sub.id.trim() : ""
                        const group = fullId ? groupFromId(fullId) : ""
                        const base = !group
                            ? FALLBACK_NAME
                            : (ALWAYS_SHOW_DETAILS || groupCounts[group] > 1) ? fullId : group
                        nameCount[base] = (nameCount[base] || 0) + 1
                        const label = nameCount[base] > 1 ? `${base} #${nameCount[base]}` : base

                        if (USE_URL) {
                            ctx.videoCore.addExternalSubtitleTrack({
                                label,
                                language: "pl",
                                type: type === "srt" ? "vtt" : type,
                                url: sub.url,
                            })
                        } else {
                            ctx.videoCore.addExternalSubtitleTrack({
                                label,
                                language: "pl",
                                type: type === "srt" ? "vtt" : type,
                                content: type === "srt" ? srtToVtt(text) : text,
                            })
                        }
                        console.log(TAG, "Dodano ścieżkę:", label, type)
                        added++
                    } catch (e) {
                        console.error(TAG, "Błąd przy dodawaniu ścieżki:", redact(String(e)))
                    }
                }

                if (added > 0) {
                    ctx.videoCore.showMessage(`AzureIllusion: dodano napisy PL (${added})`, 2500)
                } else {
                    lastKey = ""
                }
            } catch (err) {
                console.error(TAG, "Wyjątek:", redact(String(err)))
                lastKey = ""
            }
        }

        // Inject only once the player is actually ready, then wait a moment
        ctx.videoCore.addEventListener("video-can-play", () => {
            const wait = (ctx as any).setTimeout ?? (globalThis as any).setTimeout
            wait(() => injectSubtitles("video-can-play+delay"), INJECT_DELAY_MS)
        })

        // Reset on new playback so the next episode gets its subtitles
        ctx.videoCore.addEventListener("video-loaded", () => {
            lastKey = ""
        })

        console.log(TAG, "Wtyczka załadowana.")
    })
}
