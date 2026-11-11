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

        // EXPERIMENTAL (MpvCore only). When true and the player is MpvCore, the plugin also tries
        // to send mpv's own `sub-add` command through any command-like method found on
        // ctx.videoCore. Leave false until the probe log shows such a method exists.
        const MPV_COMMANDS = false

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

        // Lists every method on ctx.videoCore (documented or not) and returns the command-like ones
        function probePlayerApi(): string[] {
            const names = new Set<string>()
            try {
                let o: any = ctx.videoCore
                for (let i = 0; o && i < 4; i++) {
                    for (const k of Object.getOwnPropertyNames(o)) names.add(k)
                    o = Object.getPrototypeOf(o)
                }
            } catch (e) {
                console.warn(TAG, "Nie udało się wylistować metod:", redact(String(e)))
            }
            const all = Array.from(names).sort()
            console.log(TAG, "Metody ctx.videoCore:", all.join(", "))
            const commandLike = all.filter((n) => /command|mpv|exec|raw|eval|ipc/i.test(n))
            console.log(TAG, "Metody podobne do komend:", commandLike.length ? commandLike.join(", ") : "(brak)")
            return commandLike
        }

        // EXPERIMENTAL: try to send mpv's `sub-add <url> select <title> <lang>` through a command-like method.
        // mpv downloads the file from the URL by itself, so no headers are needed (the API key is in the URL).
        function tryMpvSubAdd(commandLike: string[], url: string, label: string): boolean {
            for (const name of commandLike) {
                const fn = (ctx.videoCore as any)[name]
                if (typeof fn !== "function") continue
                try {
                    const res = fn.call(ctx.videoCore, ["sub-add", url, "select", label, "pl"])
                    console.log(TAG, `MPV komenda przez ${name}() wysłana:`, redact(JSON.stringify(res) ?? "ok"))
                    return true
                } catch (e) {
                    console.warn(TAG, `MPV komenda przez ${name}() nie powiodła się:`, redact(String(e)))
                }
            }
            return false
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
                console.log(TAG, `(${trigger}) playbackInfo:`, redact(JSON.stringify(info)?.slice(0, 600) ?? ""))

                const anilistId = media?.id
                const episode = readEpisodeNumber(info, state)

                if (!anilistId || !episode) {
                    console.warn(TAG, "Nie udało się ustalić AniList ID / numeru odcinka.", anilistId, episode)
                    return
                }

                const key = `${anilistId}:${episode}`
                if (key === lastKey) return
                lastKey = key

                const isMpvCore = info?.target === "mpvcore"
                const commandLike = probePlayerApi()

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
                for (const sub of subs) {
                    if (!sub?.url) continue
                    try {
                        // Download the file ourselves, so no CORS / header problems in the player
                        const subRes = await doFetch(sub.url)
                        if (!subRes.ok) {
                            console.warn(TAG, "Nie udało się pobrać napisów:", redact(sub.url), subRes.status)
                            continue
                        }
                        const text: string = await subRes.text()
                        const type = detectType(sub.url, text)

                        const titleLine = text.match(/^Title:[ \t]*([^\r\n]+)/m)
                        const label = `[PL] ${sub.title || sub.label || (titleLine ? titleLine[1].trim() : "AzureIllusion")} #${added + 1}`

                        // Standard path (works in VideoCore)
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

                        // Experimental path for MpvCore
                        if (MPV_COMMANDS && isMpvCore) {
                            const ok = tryMpvSubAdd(commandLike, sub.url, label)
                            if (!ok) console.warn(TAG, "Brak działającej metody do komend mpv.")
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

        // Inject only once the player is actually ready, then wait a moment,
        // otherwise mpv can drop tracks that were added during loading.
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
