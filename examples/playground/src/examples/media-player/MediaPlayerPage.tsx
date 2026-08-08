import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/unstable/reactivity"
import { useCallback, useEffect, useState } from "react"
import { ExamplePage } from "../../components/ExamplePage.tsx"
import { mediaPlayerAtom } from "./atoms.ts"
import { initialAudioSettings, initialPlaybackData, MediaPlayerEvent, MediaPlayerStates } from "./schemas.ts"

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
  const snapshotResult = useAtomValue(mediaPlayerAtom.snapshot)
  const send = useAtomSet(mediaPlayerAtom.send)
  const [source, setSource] = useState<AudioSource>()

  const registerAudioElement = useCallback(
    (audioRef: HTMLAudioElement | null) => {
      if (audioRef !== null) {
        send(MediaPlayerEvent.cases.AudioElementMounted.make({ audioRef }))
      }
    },
    [send]
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
      {AsyncResult.isInitial(snapshotResult) ?
        <div className="media-player-message">Starting the media player machine…</div> :
        AsyncResult.isFailure(snapshotResult) ?
        <div className="media-player-message is-error">The media player machine failed to start.</div> :
        (
          (() => {
            const runtimeSnapshot = snapshotResult.value
            const snapshot = runtimeSnapshot.state
            const paused = Option.getOrUndefined(
              MediaPlayerStates.get(snapshot, "Player.transport.Ready.Paused")
            )
            const playing = Option.getOrUndefined(
              MediaPlayerStates.get(snapshot, "Player.transport.Ready.Playing")
            )
            const buffering = Option.getOrUndefined(
              MediaPlayerStates.get(snapshot, "Player.transport.Ready.Buffering")
            )
            const restarting = Option.getOrUndefined(
              MediaPlayerStates.get(snapshot, "Player.transport.Ready.Restarting")
            )
            const ended = Option.getOrUndefined(
              MediaPlayerStates.get(snapshot, "Player.transport.Ready.Ended")
            )
            const failed = Option.getOrUndefined(
              MediaPlayerStates.get(snapshot, "Player.transport.Failed")
            )
            const audible = Option.getOrUndefined(
              MediaPlayerStates.get(snapshot, "Player.settings.Audible")
            )
            const muted = Option.getOrUndefined(
              MediaPlayerStates.get(snapshot, "Player.settings.Muted")
            )
            const playback = paused ?? playing ?? buffering ?? restarting ?? ended
            const playbackData = playback ?? initialPlaybackData
            const settings = audible ?? muted ?? initialAudioSettings
            const isMuted = muted !== undefined
            const isPaused = paused !== undefined
            const isPlaying = playing !== undefined
            const isBuffering = buffering !== undefined
            const isEnded = ended !== undefined
            const canPlay = isPaused || isEnded
            const canPause = isPlaying || isBuffering
            const canRestart = canPlay || canPause
            const transportPath = isPlaying ?
              "Player.transport.Ready.Playing"
              : isBuffering ?
              "Player.transport.Ready.Buffering"
              : restarting !== undefined ?
              "Player.transport.Ready.Restarting"
              : isEnded ?
              "Player.transport.Ready.Ended"
              : isPaused ?
              "Player.transport.Ready.Paused"
              : failed !== undefined ?
              "Player.transport.Failed"
              : MediaPlayerStates.matches(snapshot, "Player.transport.Loading") ?
              "Player.transport.Loading"
              : "Player.transport.Empty"
            const stateName = transportPath.slice(transportPath.lastIndexOf(".") + 1)
            const settingsPath = isMuted ? "Player.settings.Muted" : "Player.settings.Audible"
            const loudness = playing?.loudness ?? null
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
                    <span className={`media-state-chip is-${stateName.toLowerCase()}`}>{stateName}</span>
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
                          send(MediaPlayerEvent.cases.SourceSelected.make({ url: next.url }))
                        }}
                      />
                    </label>
                  </div>
                </header>

                <audio
                  ref={registerAudioElement}
                  className="media-audio-element"
                  preload="auto"
                  onWaiting={() => send(MediaPlayerEvent.cases.MediaWaiting.make({}))}
                  onCanPlay={() => send(MediaPlayerEvent.cases.MediaCanPlay.make({}))}
                  onError={({ currentTarget }) =>
                    send(MediaPlayerEvent.cases.MediaFailed.make({
                      message: currentTarget.error?.message ?? "The selected audio file could not be loaded"
                    }))}
                  onTimeUpdate={({ currentTarget }) =>
                    send(MediaPlayerEvent.cases.TimeUpdated.make({ currentTime: currentTarget.currentTime }))}
                  onEnded={({ currentTarget }) =>
                    send(MediaPlayerEvent.cases.PlaybackEnded.make({ currentTime: currentTarget.currentTime }))}
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
                      <strong>{formatTime(playbackData.currentTime)}</strong>
                    </div>

                    <div className="media-controls">
                      <button
                        type="button"
                        disabled={!canPlay || source === undefined}
                        onClick={() => send(MediaPlayerEvent.cases.PlayRequested.make({}))}
                      >
                        Play
                      </button>
                      <button
                        type="button"
                        disabled={!canPause}
                        onClick={() => send(MediaPlayerEvent.cases.PauseRequested.make({}))}
                      >
                        Pause
                      </button>
                      <button
                        type="button"
                        disabled={!canRestart}
                        onClick={() => send(MediaPlayerEvent.cases.RestartRequested.make({}))}
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
                        <strong>{isMuted ? "Muted" : "Audible"} · {Math.round(settings.volume * 100)}%</strong>
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
                            send(MediaPlayerEvent.cases.VolumeChanged.make({
                              volume: currentTarget.valueAsNumber
                            }))}
                        />
                      </label>
                      <label>
                        <span>Muted</span>
                        <input
                          type="checkbox"
                          checked={isMuted}
                          onChange={({ currentTarget }) =>
                            send(
                              currentTarget.checked
                                ? MediaPlayerEvent.cases.MuteRequested.make({})
                                : MediaPlayerEvent.cases.UnmuteRequested.make({})
                            )}
                        />
                      </label>
                      <label>
                        <span>Speed</span>
                        <select
                          value={settings.playbackRate}
                          onChange={({ currentTarget }) =>
                            send(MediaPlayerEvent.cases.PlaybackRateChanged.make({
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
                        <strong>{runtimeSnapshot.status}</strong>
                      </div>
                      <pre>
                      {JSON.stringify({
                        status: runtimeSnapshot.status,
                        states: {
                          transport: transportPath,
                          settings: settingsPath
                        },
                        data: {
                          transport: playback ?? failed ?? null,
                          settings
                        }
                      }, null, 2)}
                      </pre>
                    </section>

                    {failed !== undefined && <p className="media-error-message" role="alert">{failed.message}</p>}
                  </aside>
                </div>
              </div>
            )
          })()
        )}
    </ExamplePage>
  )
}
