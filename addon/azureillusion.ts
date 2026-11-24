/// <reference path="./plugin.d.ts" />
/// <reference path="./app.d.ts" />
/// <reference path="./system.d.ts" />
/// <reference path="./core.d.ts" />

//@ts-ignore
function init() {
    $ui.register((ctx) => {
        const TAG = "[AzureIllusion]"
        const DEFAULT_BASE = "https://sea-azure.thalkas.workers.dev"
        const INJECT_DELAY_MS = 2000

        const FALLBACK_NAME = "AzureIllusion"
        const ALWAYS_SHOW_DETAILS = false

        let lastKey = ""
        let isInjecting = false

        // Zewnętrzny MPV (odtwarzacz z ustawień Seanime, nie wbudowany mpvcore)
        let lastExternalKey = ""
        let warnedNoMediaId = false

        function pref(name: string): string {
            try {
                return String($getUserPreference(name) || "").trim()
            } catch (_) {
                return ""
            }
        }

        // Segment ścieżki w workerze: "klucz_azure", "fsb_..." albo "klucz_azure,fsb_..."
        function keySegment(): string {
            return [pref("apiKey"), pref("fansubyKey")].filter(Boolean).join(",")
        }

        // Maskowanie kluczy API w logach
        function redact(text: string): string {
            try {
                let out = text
                for (const key of [pref("apiKey"), pref("fansubyKey")]) {
                    if (key) out = out.split(key).join("[REDACTED]")
                }
                return out
            } catch (_) {
                return text
            }
        }

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
            const f = (ctx as any).fetch ?? (globalThis as any).fetch
            return await f(url)
        }

        // Pobiera listę napisów z workera (AzureIllusion + fansuby + ANSI2.0)
        async function fetchSubList(anilistId: number | string, episode: number): Promise<any[] | null> {
            const seg = keySegment()
            const baseUrl = (($getUserPreference("baseUrl") || DEFAULT_BASE) as string).replace(/\/+$/, "")

            if (!seg) {
                console.error(TAG, "Brak klucza API (AzureIllusion lub fansuby) w ustawieniach wtyczki.")
                return null
            }

            const url = `${baseUrl}/${encodeURIComponent(seg)}/subtitles/anime/anilist:${anilistId}:${episode}.json`
            const res = await doFetch(url)
            if (!res || !res.ok) return null

            const data = await res.json()
            return data?.subtitles ?? []
        }

        function makeLabeler(subs: any[]) {
            const nameCount: Record<string, number> = {}
            const groupCounts: Record<string, number> = {}

            for (const s of subs) {
                const g = typeof s?.id === "string" ? groupFromId(s.id) : ""
                if (g) groupCounts[g] = (groupCounts[g] || 0) + 1
            }

            return (sub: any): string => {
                const fullId = typeof sub.id === "string" ? sub.id.trim() : ""
                const group = fullId ? groupFromId(fullId) : ""
                const base = !group
                    ? FALLBACK_NAME
                    : (ALWAYS_SHOW_DETAILS || groupCounts[group] > 1) ? fullId : group
                nameCount[base] = (nameCount[base] || 0) + 1
                return nameCount[base] > 1 ? `${base} #${nameCount[base]}` : base
            }
        }

        // ---------------- Wbudowany odtwarzacz (VideoCore / mpvcore) ----------------

        async function injectSubtitles() {
            if (isInjecting) return
            isInjecting = true

            try {
                const media: any = ctx.videoCore?.getCurrentMedia()
                const info: any = ctx.videoCore?.getCurrentPlaybackInfo()
                const state: any = ctx.videoCore?.getPlaybackState()

                if (!media || !info) return

                const anilistId = media?.id
                const episode = readEpisodeNumber(info, state)

                if (!anilistId || !episode) return

                const key = `${anilistId}:${episode}`
                if (key === lastKey) return
                lastKey = key

                const targetStr = String(info?.target || "").toLowerCase().trim()
                const isMpvCore = targetStr.includes("mpv") || info?.player === "mpv" || (ctx as any).currentVideoPlayer === "mpvcore"

                const subs = await fetchSubList(anilistId, episode)
                if (subs === null) {
                    lastKey = ""
                    return
                }
                if (!subs.length) {
                    ctx.videoCore.showMessage("AzureIllusion: brak napisów PL", 2500)
                    return
                }

                let added = 0
                const labelFor = makeLabeler(subs)

                for (const sub of subs) {
                    if (!sub?.url) continue
                    try {
                        const subRes = await doFetch(sub.url)
                        if (!subRes.ok) continue

                        const text: string = await subRes.text()
                        const type = detectType(sub.url, text)
                        const label = labelFor(sub)

                        // Dodawanie Napisow
                        if (isMpvCore) {
                            ctx.videoCore.addExternalSubtitleTrack({
                                label,
                                language: "pl",
                                type: type === "srt" ? "vtt" : type,
                                format: type === "srt" ? "vtt" : type,
                                url: sub.url,
                                uri: sub.url,
                                sourceUrl: sub.url,
                                src: sub.url,
                            } as any)
                        } else {
                            ctx.videoCore.addExternalSubtitleTrack({
                                label,
                                language: "pl",
                                type: type === "srt" ? "vtt" : type,
                                content: type === "srt" ? srtToVtt(text) : text,
                            })
                        }

                        added++
                    } catch (e) {
                        console.error(TAG, "Błąd dodawania ścieżki:", redact(String(e)))
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
            } finally {
                isInjecting = false
            }
        }

        ctx.videoCore.addEventListener("video-can-play", () => {
            const wait = (ctx as any).setTimeout ?? (globalThis as any).setTimeout
            wait(() => injectSubtitles(), INJECT_DELAY_MS)
        })

        ctx.videoCore.addEventListener("video-loaded", () => {
            lastKey = ""
        })

        // ---------------- Zewnętrzny MPV (aplikacja MPV uruchamiana przez Seanime) ----------------
        // Seanime nie daje pluginom połączenia IPC z tym MPV. Zamiast tego plugin sam pyta worker o napisy
        // i zapisuje wynik (AniList ID, odcinek, linki do napisów) do pliku seanime-now-playing.json w folderze MPV.
        // Dalej robi to skrypt seanime-subs.lua działający w MPV: czyta ten plik, pobiera napisy i je dodaje.
        // Wymaga w manifeście: scope "system" oraz writePaths obejmujące folder MPV (np. "D:/MPV/*").
        // Włączane w ustawieniach pluginu: "useExternalMpv" (przełącznik) i "mpvDir" (folder, np. D:/MPV).

        const NOW_PLAYING_FILE = "seanime-now-playing.json"

        function isOn(value: string): boolean {
            const v = value.toLowerCase()
            return v === "true" || v === "1" || v === "yes" || v === "tak" || v === "on"
        }

        // Zwraca folder MPV, gdy włączono zewnętrzny MPV i podano folder; w innym razie null.
        function externalMpvDir(): string | null {
            if (!isOn(pref("useExternalMpv"))) return null
            const dir = pref("mpvDir").replace(/[\\/]+$/, "")
            return dir ? dir : null
        }

        function writeNowPlaying(dir: string, data: any) {
            try {
                const os: any = (globalThis as any).$os
                const filepath: any = (globalThis as any).$filepath
                const toBytes: any = (globalThis as any).$toBytes
                const path = filepath.join(dir, NOW_PLAYING_FILE)
                const payload = JSON.stringify(data)
                os.writeFile(path, typeof toBytes === "function" ? toBytes(payload) : payload, 0o644)
                console.log(TAG, `MPV: zapisano ${path} (anilist:${data.anilistId}:${data.episode}, napisów: ${data.subtitles.length})`)
            } catch (e) {
                console.error(TAG, "MPV: nie udało się zapisać pliku now-playing:", redact(String(e)))
            }
        }

        // Pobiera listę napisów z workera (raz na odcinek) i zapisuje plik dla skryptu MPV.
        async function publishToMpv(dir: string, mediaId: number | string, episode: number, filename: string) {
            let subtitles: any[] = []
            try {
                const subs = await fetchSubList(mediaId, episode)
                if (subs === null) {
                    console.warn(TAG, `MPV: worker nie zwrócił listy dla ${mediaId}:${episode} (brak klucza lub błąd)`)
                } else {
                    const labelFor = makeLabeler(subs)
                    subtitles = subs
                        .filter((s: any) => s && s.url)
                        .map((s: any) => ({ title: labelFor(s), url: String(s.url) }))
                }
            } catch (e) {
                console.error(TAG, "MPV: błąd pobierania listy napisów:", redact(String(e)))
            }
            writeNowPlaying(dir, {
                anilistId: Number(mediaId),
                episode,
                filename,
                ts: Math.floor(Date.now() / 1000),
                subtitles,
            })
        }

        try {
            const playback: any = (ctx as any).playback
            const mpv: any = (ctx as any).mpv

            // Zdarzenia ctx.playback dotyczą tylko zewnętrznych odtwarzaczy (MPV/VLC/...), nie wbudowanego.
            if (playback?.registerEventListener) {
                playback.registerEventListener((event: any) => {
                    const dir = externalMpvDir()
                    if (!dir) return

                    const state = event?.state
                    if (!state) return

                    const mediaId = state.mediaId ?? state.media?.id
                    const episode = Number(state.episodeNumber)

                    if (!mediaId || !episode || isNaN(episode)) {
                        if (!warnedNoMediaId && event?.status) {
                            warnedNoMediaId = true
                            console.warn(TAG, "MPV: brak mediaId/episodeNumber w stanie odtwarzania. Pola state:", Object.keys(state).join(","))
                        }
                        return
                    }

                    const key = `${mediaId}:${episode}`
                    if (key === lastExternalKey) return
                    lastExternalKey = key

                    publishToMpv(dir, mediaId, episode, String(state.filename ?? event?.startedEvent?.filename ?? ""))
                })
            }

            // po zamknięciu MPV pozwól zapisać plik ponownie przy następnym uruchomieniu tego samego odcinka
            if (mpv?.onEvent) {
                mpv.onEvent((_event: any, closed: boolean) => {
                    if (closed) lastExternalKey = ""
                })
            }
        } catch (e) {
            console.warn(TAG, "Obsługa zewnętrznego MPV niedostępna:", redact(String(e)))
        }

        console.log(TAG, "Wtyczka załadowana pomyślnie.")
    })
}
