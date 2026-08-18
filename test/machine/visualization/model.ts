export interface StateNode {
  readonly path: string
  readonly key: string
  readonly annotations: {
    readonly title?: string | undefined
  } | undefined
  readonly type: "atomic" | "compound" | "parallel" | "final" | "history" | "choice"
  readonly history: "shallow" | "deep" | undefined
  readonly parent: string | undefined
  readonly children: ReadonlyArray<string>
  readonly initial: string | undefined
}

export interface MachineValue {
  readonly id: string | undefined
}

export interface InitialDefinition {
  readonly target: string
}

export interface TransitionDefinition {
  readonly source: string
  readonly trigger:
    | {
      readonly type: "event"
      readonly event: PropertyKey
    }
    | {
      readonly type: "always"
    }
    | {
      readonly type: "done"
    }
    | {
      readonly type: "choice"
    }
    | {
      readonly type: "invoke"
      readonly id: string
      readonly outcome: "element" | "done" | "failure" | "snapshot"
    }
  readonly reenter: boolean
  readonly branches: ReadonlyArray<
    | {
      readonly type: "direct"
      readonly target: string | undefined
    }
    | {
      readonly type: "branch"
      readonly key: string
      readonly title: string
      readonly target: string | undefined
    }
  >
}

export type ActivityDefinition =
  | {
    readonly source: string
    readonly id: string
    readonly type: "process"
  }
  | {
    readonly source: string
    readonly id: string
    readonly type: "effect"
    readonly outcomes: {
      readonly success: "dynamic"
      readonly failure: "dynamic" | "none"
    }
  }
  | {
    readonly source: string
    readonly id: string
    readonly type: "timer"
    readonly duration: string | "dynamic"
  }
  | {
    readonly source: string
    readonly id: string
    readonly type: "stream"
  }
  | {
    readonly source: string
    readonly id: string
    readonly type: "machine"
    readonly child: {
      readonly id: string
      readonly machineId: string | null
    }
  }

export interface InspectionApi<Machine, Snapshot> {
  readonly stateNodes: (machine: Machine) => ReadonlyArray<StateNode>
  readonly initialDefinition: (machine: Machine) => InitialDefinition
  readonly transitionDefinitions: (machine: Machine) => ReadonlyArray<TransitionDefinition>
  readonly activityDefinitions?: (machine: Machine) => ReadonlyArray<ActivityDefinition>
  readonly configuration: (machine: Machine, snapshot: Snapshot) => ReadonlyArray<StateNode>
  readonly enabled: (machine: Machine, snapshot: Snapshot) => ReadonlyArray<PropertyKey>
}
