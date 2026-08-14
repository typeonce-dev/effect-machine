import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Match } from "effect"
import { useCallback, useEffect, useState } from "react"
import { ExamplePage } from "../../components/ExamplePage.tsx"
import { mediaPlayerAtom, mediaPlayerViewAtom, registerMediaPlayerElement } from "./atoms.ts"
import { MediaPlayerEvents } from "./definition.ts"

interface AudioSource {
  readonly name: string
  readonly url: string
}

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return "0:00"

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`
}

export function MediaPlayerPage() {
  const viewResult = useAtomValue(mediaPlayerViewAtom)
  const send = useAtomSet(mediaPlayerAtom.send)
  const register = useAtomSet(registerMediaPlayerElement)
  const [source, setSource] = useState<AudioSource>()

  const registerAudioElement = useCallback(
    (audioRef: HTMLAudioElement | null) => {
      if (audioRef !== null) {
        register(audioRef)
      }
    },
    [register]
  )

  useEffect(
    () => () => {
      if (source !== undefined) URL.revokeObjectURL(source.url)
    },
    [source]
  )

  return (
    <ExamplePage
      title="Media player"
      summary="Coordinate a compound transport lifecycle and independent sound modes inside a parallel Effect statechart."
      machineFile="src/examples/media-player/machine.ts"
    >
      {Match.value(viewResult).pipe(
        Match.tagsExhaustive({
          Initial: () => <div className="media-player-message">Starting the media player machine…</div>,
          Failure: () => <div className="media-player-message is-error">The media player machine failed to start.</div>,
          Success: ({ value: view }) => {
            const { settings, status, transport } = view
            const { canPause, canPlay, canRestart, isPlaying, loudness, playback } = transport
            const loudnessLevel = Math.min(100, Math.round((loudness?.rms ?? 0) * 220))
            const peakLevel = Math.min(100, Math.round((loudness?.peak ?? 0) * 100))

            return (
              <div className="media-player-console">
                <header className="media-player-toolbar">
                  <div>
                    <p className="media-player-kicker">Effect audio session</p>
                    <h2>{source?.name ?? "Choose a local audio track"}</h2>
                  </div>
                  <div className="media-player-toolbar-actions">
                    <span className={`media-state-chip is-${transport.name.toLowerCase()}`}>{transport.name}</span>
                    <label className="media-file-button">
                      <span>{source === undefined ? "Choose audio" : "Replace audio"}</span>
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0]
                          if (file === undefined) return
                          const next = { name: file.name, url: URL.createObjectURL(file) }
                          setSource(next)
                          send(MediaPlayerEvents.SourceSelected({ url: next.url }))
                        }}
                      />
                    </label>
                  </div>
                </header>

                <audio
                  ref={registerAudioElement}
                  className="media-audio-element"
                  preload="auto"
                  onWaiting={() => send(MediaPlayerEvents.MediaWaiting())}
                  onCanPlay={() => send(MediaPlayerEvents.MediaCanPlay())}
                  onError={({ currentTarget }) =>
                    send(MediaPlayerEvents.MediaFailed({
                      message: currentTarget.error?.message ?? "The selected audio file could not be loaded"
                    }))}
                  onTimeUpdate={({ currentTarget }) =>
                    send(MediaPlayerEvents.TimeUpdated({ currentTime: currentTarget.currentTime }))}
                  onEnded={({ currentTarget }) =>
                    send(MediaPlayerEvents.PlaybackEnded({ currentTime: currentTarget.currentTime }))}
                />

                <div className="media-player-layout">
                  <section className="media-now-playing" aria-label="Playback controls">
                    <div className={`media-artwork${isPlaying ? " is-playing" : ""}`} aria-hidden="true">
                      <div className="media-record">
                        <span />
                      </div>
                      <div className="media-tonearm" />
                    </div>

                    <div className="media-time-row">
                      <span>Current time</span>
                      <strong>{formatTime(playback.currentTime)}</strong>
                    </div>

                    <div className="media-controls">
                      <button
                        type="button"
                        disabled={!canPlay || source === undefined}
                        onClick={() => send(MediaPlayerEvents.PlayRequested())}
                      >
                        Play
                      </button>
                      <button
                        type="button"
                        disabled={!canPause}
                        onClick={() => send(MediaPlayerEvents.PauseRequested())}
                      >
                        Pause
                      </button>
                      <button
                        type="button"
                        disabled={!canRestart}
                        onClick={() => send(MediaPlayerEvents.RestartRequested())}
                      >
                        Restart
                      </button>
                    </div>

                    <section className="media-meter" aria-label="Live loudness">
                      <div className="media-panel-heading">
                        <span>Loudness</span>
                        <strong>{loudness?.decibels.toFixed(1) ?? "-80.0"} dB</strong>
                      </div>
                      <div className="media-meter-track">
                        <span className="media-meter-fill" style={{ width: `${loudnessLevel}%` }} />
                        <span className="media-meter-peak" style={{ left: `${peakLevel}%` }} />
                      </div>
                      <p>RMS {loudnessLevel}% · Peak {peakLevel}%</p>
                    </section>
                  </section>

                  <aside className="media-player-inspector">
                    <section className="media-settings">
                      <div className="media-panel-heading">
                        <span>Audio settings</span>
                        <strong>{settings.muted ? "Muted" : "Audible"} · {Math.round(settings.volume * 100)}%</strong>
                      </div>
                      <label>
                        <span>Volume</span>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={settings.volume}
                          onChange={({ currentTarget }) =>
                            send(MediaPlayerEvents.VolumeChanged({
                              volume: currentTarget.valueAsNumber
                            }))}
                        />
                      </label>
                      <label>
                        <span>Muted</span>
                        <input
                          type="checkbox"
                          checked={settings.muted}
                          onChange={({ currentTarget }) =>
                            send(
                              currentTarget.checked
                                ? MediaPlayerEvents.MuteRequested()
                                : MediaPlayerEvents.UnmuteRequested()
                            )}
                        />
                      </label>
                      <label>
                        <span>Speed</span>
                        <select
                          value={settings.playbackRate}
                          onChange={({ currentTarget }) =>
                            send(MediaPlayerEvents.PlaybackRateChanged({
                              playbackRate: Number(currentTarget.value)
                            }))}
                        >
                          <option value={0.75}>0.75x</option>
                          <option value={1}>1x</option>
                          <option value={1.25}>1.25x</option>
                          <option value={1.5}>1.5x</option>
                          <option value={2}>2x</option>
                        </select>
                      </label>
                    </section>

                    <section className="media-state-preview">
                      <div className="media-panel-heading">
                        <span>Machine snapshot</span>
                        <strong>{status}</strong>
                      </div>
                      <pre>
                      {JSON.stringify({
                        status,
                        states: {
                          transport: transport.path,
                          settings: settings.path
                        },
                        data: {
                          transport: transport.value,
                          settings: settings.value
                        }
                      }, null, 2)}
                      </pre>
                    </section>

                    {transport.error !== null && <p className="media-error-message" role="alert">{transport.error}</p>}
                  </aside>
                </div>
              </div>
            )
          }
        })
      )}
    </ExamplePage>
  )
}
