import { useEffect, useState } from "react"
import { ExamplePage, StarterPanel } from "../../components/ExamplePage.tsx"
import { MediaPlayerMachine } from "./machine.ts"

export function MediaPlayerPage() {
  void MediaPlayerMachine

  const [source, setSource] = useState<string>()

  useEffect(
    () => () => {
      if (source !== undefined) URL.revokeObjectURL(source)
    },
    [source]
  )

  return (
    <ExamplePage
      title="Media player"
      summary="Use a real audio element as an external system and translate its lifecycle events into a typed machine protocol."
      machineFile="src/examples/media-player/machine.ts"
    >
      <StarterPanel>
        <label className="file-picker">
          <span>Choose an audio file</span>
          <input
            type="file"
            accept="audio/*"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0]
              if (file === undefined) return
              if (source !== undefined) URL.revokeObjectURL(source)
              setSource(URL.createObjectURL(file))
            }}
          />
        </label>
        <audio className="audio-player" src={source} controls preload="metadata">
          Your browser does not support audio playback.
        </audio>
        <h2>Translate DOM events</h2>
        <p>
          The statechart separates playback and volume. Wire <code>playing</code>, <code>pause</code>,{" "}
          <code>waiting</code>,{` `}
          <code>canplay</code>, <code>ended</code>, and <code>error</code> into the prepared events.
        </p>
      </StarterPanel>
    </ExamplePage>
  )
}
