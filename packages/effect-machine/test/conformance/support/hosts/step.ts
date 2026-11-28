import { Cause, Deferred, Duration, Effect, Exit, Fiber, Queue, Scope, Semaphore, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Machine } from "../../../../src/index.js"
import type { Answer, Host, Outcome } from "../host.js"
import { decode, encode, fiberScheduling, renderFailure } from "../host.js"

/** A step function whose machine type does not matter to the suite. */
type AnyStep = Machine.MachineStep<any>

type Step = Machine.MachineStep.Step<any>

type Work = Machine.MachineStep.Work<any>

type Selector = Machine.ChildMachine.Any | Machine.ChildAddress<never>

// The services of the work of a suite machine are provided, and the host gives it a `Scope`.
type AnyLogic = Machine.Logic<unknown, unknown, unknown, Scope.Scope, unknown, unknown>

type AnyRef = Machine.MachineRef<unknown, never, unknown, unknown, unknown>

const isStopped = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 &&
  cause.reasons.every((reason) => Cause.isFailReason(reason) && reason.error instanceof Machine.StoppedError)

const notOffered = (member: string) => Effect.die(new Error(`The Machine.toStep host offers no ${member}`))

/** Whether a selector names a child, as the children of a local machine are matched. */
const selects = (selector: Selector, id: string, descriptor: Machine.ChildMachine.Any | undefined): boolean =>
  typeof selector === "string"
    ? selector === id
    : descriptor !== undefined && descriptor.id === selector.id && descriptor.machine === selector.machine

/**
 * A process that a machine owns: a child machine or process logic, invoked by a
 * state or spawned by work.
 */
interface Process {
  readonly id: string
  readonly descriptor: Machine.ChildMachine.Any | undefined
  readonly send: (event: unknown) => Effect.Effect<void>
  /** Stops the process, in the turn that holds the permit. Nothing of it is reported after. */
  readonly stop: Effect.Effect<void>
  readonly ref: AnyRef
}

/** What runs for one piece of work. */
interface Running {
  stopped: boolean
  fiber?: Fiber.Fiber<unknown, unknown>
  process?: Process
}

/**
 * A host written only against `Machine.toStep`. It keeps the state value, runs
 * the work a step starts, and reports how that work ended, one turn at a time.
 * It restarts from the encoded snapshot, which is what an application can
 * store.
 *
 * It keeps the timers of its machine itself, as a runtime with timers of its own
 * does: a timer is a due time on a clock of the host, and `advance` fires the
 * timers that fall due, in order. Nothing of a timer sleeps on a fiber or on the
 * `TestClock`.
 *
 * It owns the children of its machine: each child machine is hosted through
 * `Machine.toStep` again, with this machine as its `parent`, and process logic
 * runs on a fiber with contexts of this host. Every machine of one instance
 * takes its turns one at a time.
 */
export const stepHost: Host = {
  name: "Machine.toStep",
  capabilities: {
    invocations: ["Effect", "Timer", "Stream", "Logic", "Child"],
    ownedChildren: true,
    commands: true,
    restart: true,
    stop: true,
    emissions: true,
    rejection: true,
    initialState: "AtStart"
  },
  start: Effect.fnUntraced(function*({ activity, input, machine }) {
    const outer = yield* Effect.scope
    // Effects and streams run on fibers, so the host settles as one on fibers does.
    const { settle } = fiberScheduling(activity)
    const turns = Semaphore.makeUnsafe(1)
    const states: Array<Machine.Machine.EncodedSnapshot> = []
    const emitted: Array<unknown> = []
    let sessions = 0

    const turn = <A>(effect: Effect.Effect<A>): Effect.Effect<A> => Semaphore.withPermit(turns)(effect)

    /** One life of the host. A restart ends it, with every fiber and child it forked. */
    interface Life {
      readonly scope: Scope.Closeable
      startFailure: string | undefined
    }
    let life: Life

    /** The clock of the host, in milliseconds since it started. */
    let now = 0
    /** Timers that wait, by due time, and in the order they started when due together. */
    const timers: Array<{ readonly due: number; readonly life: Life; readonly runner: Runner; readonly work: Work }> =
      []
    const forget = (work: Work): void => {
      const index = timers.findIndex((timer) => timer.work === work)
      if (index >= 0) timers.splice(index, 1)
    }

    /** One machine that this instance hosts, the one of the suite or a child of it. */
    interface Runner {
      readonly life: Life
      readonly scope: Scope.Closeable
      readonly step: AnyStep
      readonly self: Machine.MachineTarget<unknown>
      readonly running: Map<Work, Running>
      /** The children that its work spawned, by address. */
      readonly spawned: Map<string, Process>
      state: Machine.MachineStep.State<any> | undefined
      exit: Step["exit"]
      readonly done: Deferred.Deferred<unknown, unknown>
      /** Publishes a state that a step reached. */
      readonly publish: (done: Step) => Effect.Effect<void>
      /** Reports how the machine ended, unless its owner stopped it. */
      readonly ended: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>
    }

    const findProcess = (runner: Runner, selector: Selector): Process | undefined => {
      for (const running of runner.running.values()) {
        const process = running.process
        if (process !== undefined && !running.stopped && selects(selector, process.id, process.descriptor)) {
          return process
        }
      }
      for (const process of runner.spawned.values()) {
        if (selects(selector, process.id, process.descriptor)) return process
      }
      return undefined
    }

    /** The children of a runner, as `Machine.toStep` asks a host for them. */
    const childrenOf = (runner: () => Runner): Machine.MachineStep.Children => ({
      spawn: (child, options) =>
        Effect.suspend(() => {
          const owner = runner()
          if (findProcess(owner, child.id as Selector) !== undefined) {
            return Effect.fail(new Machine.ChildAlreadyExistsError({ id: child.id }))
          }
          return Effect.map(
            hostMachine(owner, child.machine, child.id, child, options === undefined ? [] : [options.input], {
              current: () => owner.spawned.get(child.id) !== undefined,
              onEnd: () => Effect.sync(() => owner.spawned.delete(child.id)),
              onSnapshot: () => Effect.void
            }),
            (process) => {
              owner.spawned.set(child.id, process)
              return process.ref
            }
          )
        }),
      spawnLogic: (logic, options) =>
        Effect.suspend(() => {
          const owner = runner()
          const id = options?.id ?? `spawned:${sessions++}`
          if (findProcess(owner, id as Selector) !== undefined) {
            return Effect.fail(new Machine.ChildAlreadyExistsError({ id }))
          }
          return Effect.map(
            runLogic(owner, logic as AnyLogic, id, {
              current: () => owner.spawned.get(id) !== undefined,
              onEnd: () => Effect.sync(() => owner.spawned.delete(id)),
              onSnapshot: () => Effect.void
            }),
            (process) => {
              owner.spawned.set(id, process)
              return process.ref
            }
          )
        }),
      sendTo: (child, event) => Effect.suspend(() => findProcess(runner(), child)?.send(event) ?? Effect.void),
      stop: (child) => turn(Effect.suspend(() => stopChild(runner(), child)))
    })

    const stopChild = (runner: Runner, selector: Selector): Effect.Effect<void> => {
      const process = findProcess(runner, selector)
      if (process === undefined) return Effect.void
      runner.spawned.delete(process.id)
      return process.stop
    }

    /** How a process reports to the machine that owns it. */
    interface Owned {
      /** Whether the owner still runs the process. */
      readonly current: () => boolean
      readonly onEnd: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>
      readonly onSnapshot: (snapshot: unknown) => Effect.Effect<void>
    }

    const refOf = (
      id: string,
      sessionId: string,
      send: (event: unknown) => Effect.Effect<void, Machine.StoppedError | Machine.MachineSchemaDecodeError>,
      stop: Effect.Effect<void>,
      snapshot: () => unknown,
      done: Deferred.Deferred<unknown, unknown>
    ): AnyRef => ({
      id,
      sessionId,
      send,
      stop,
      state: Effect.sync(snapshot),
      snapshot: Effect.sync(() => ({ status: "active", state: snapshot() }) as const),
      join: Deferred.await(done),
      changes: Stream.die(new Error("The Machine.toStep host offers no changes")),
      emissions: Stream.die(new Error("The Machine.toStep host offers no emissions")),
      child: () => notOffered("child"),
      childChanges: () => Stream.die(new Error("The Machine.toStep host offers no childChanges"))
    })

    /** Makes a runner for a machine, which `start` then starts or resumes. */
    const makeRunner = Effect.fnUntraced(function*(
      owner: { readonly life: Life; readonly scope: Scope.Scope },
      hosted: Machine.Machine.Any,
      options: {
        readonly id: string
        readonly parent: Machine.MachineTarget<unknown> | undefined
        readonly publish: (done: Step) => Effect.Effect<void>
        readonly ended: (exit: Exit.Exit<unknown, unknown>) => Effect.Effect<void>
      }
    ) {
      const scope = yield* Scope.fork(owner.scope)
      let runner: Runner
      const self: Machine.MachineTarget<unknown> = {
        id: options.id,
        sessionId: `${options.id}:step:${sessions++}`,
        // Planned in a later turn, as a local machine does.
        send: (event) =>
          Effect.suspend(() =>
            runner.exit !== undefined
              ? Effect.fail(new Machine.StoppedError())
              : Effect.asVoid(Effect.forkIn(turn(takeEvent(runner, event as object)), scope))
          )
      }
      const step: AnyStep = Machine.toStep(
        hosted as never,
        { self, parent: options.parent, children: childrenOf(() => runner) } as never
      )
      runner = {
        life: owner.life,
        scope,
        step,
        self,
        running: new Map(),
        spawned: new Map(),
        state: undefined,
        exit: undefined,
        done: Deferred.makeUnsafe(),
        publish: options.publish,
        ended: options.ended
      }
      return runner
    })

    /** Hosts a child machine through `Machine.toStep`, with `owner` as its parent. */
    const hostMachine = (
      owner: Runner,
      hosted: Machine.Machine.Any,
      id: string,
      descriptor: Machine.ChildMachine.Any | undefined,
      args: ReadonlyArray<unknown>,
      owned: Owned
    ): Effect.Effect<Process, unknown> =>
      Effect.gen(function*() {
        let stopped = false
        let latest: unknown
        const child: Runner = yield* makeRunner(owner, hosted, {
          id,
          // What the child sends to its parent reaches it while the parent runs it.
          parent: {
            id: owner.self.id,
            sessionId: owner.self.sessionId,
            send: (event) => !stopped && owned.current() ? owner.self.send(event) : Effect.void
          },
          // An active child reports each state it reaches to its parent, which
          // takes it in a later turn.
          publish: (done) =>
            Effect.suspend(() => {
              latest = done.snapshot
              return done.exit === undefined && !stopped && owned.current()
                ? Effect.asVoid(Effect.forkIn(owned.onSnapshot(done.snapshot), owner.scope))
                : Effect.void
            }),
          ended: (exit) => stopped ? Effect.void : owned.onEnd(exit)
        })
        const started = child.step.start(...(args as []))
        if (Exit.isFailure(started)) {
          yield* Scope.close(child.scope, Exit.void)
          return yield* Effect.failCause(started.cause)
        }
        yield* carryOut(child, started.value)
        const stop = Effect.suspend(() => {
          if (stopped) return Effect.void
          stopped = true
          return Effect.andThen(
            child.state === undefined || child.exit !== undefined
              ? Effect.void
              : carryOut(child, child.step.stop(child.state)),
            Scope.close(child.scope, Exit.void)
          )
        })
        return {
          id,
          descriptor,
          send: (event) => Effect.ignore(child.self.send(event)),
          stop,
          ref: refOf(id, child.self.sessionId, (event) => child.self.send(event), turn(stop), () => latest, child.done)
        }
      })

    /** Runs process logic on a fiber, with `owner` as its parent. */
    const runLogic = (
      owner: Runner,
      logic: AnyLogic,
      id: string,
      owned: Owned
    ): Effect.Effect<Process, unknown> =>
      Effect.gen(function*() {
        const scope = yield* Scope.fork(owner.scope)
        const mailbox = yield* Queue.unbounded<unknown>()
        const done = Deferred.makeUnsafe<unknown, unknown>()
        let stopped = false
        let state: unknown
        const endpoint: Machine.Logic.Endpoint<unknown> = {
          id,
          sessionId: `${id}:logic:${sessions++}`,
          stop: notOffered("stop of process logic by itself"),
          send: (event) => Effect.asVoid(Queue.offer(mailbox, event))
        }
        const parent: Machine.Logic.Endpoint<unknown> = {
          id: owner.self.id,
          sessionId: owner.self.sessionId,
          stop: notOffered("stop of an owner by its process logic"),
          send: (event) => !stopped && owned.current() ? Effect.orDie(owner.self.send(event)) : Effect.void
        }
        const initialContext: Machine.Logic.InitialContext<unknown> = {
          self: endpoint,
          parent,
          spawn: () => notOffered("children of process logic"),
          sendTo: ((target: Machine.MachineTarget<unknown> | string, event: unknown) =>
            typeof target === "string"
              ? notOffered("children of process logic")
              : target.send(event)) as Machine.Logic.InitialContext<unknown>["sendTo"],
          stopChild: () => notOffered("children of process logic")
        }
        const setState = (next: unknown) =>
          Effect.suspend(() => {
            state = next
            return !stopped && owned.current()
              ? Effect.asVoid(Effect.forkIn(owned.onSnapshot(next), owner.scope))
              : Effect.void
          })
        const runContext: Machine.Logic.RunContext<unknown, unknown> = {
          ...initialContext,
          receive: Queue.take(mailbox),
          state: Effect.sync(() => state),
          setState,
          updateState: (update) => Effect.flatMap(Effect.suspend(() => update(state)), setState)
        }
        const initial = yield* Effect.exit(Scope.provide(logic.initial(initialContext), scope))
        if (Exit.isFailure(initial)) {
          yield* Scope.close(scope, initial)
          return yield* Effect.failCause(initial.cause)
        }
        yield* setState(initial.value)
        const fiber = yield* Effect.forkIn(Scope.provide(logic.run(runContext), scope), scope, {
          startImmediately: true
        })
        yield* Effect.forkIn(
          Effect.flatMap(Fiber.await(fiber), (exit) => {
            Deferred.doneUnsafe(done, exit)
            return stopped ? Effect.void : Effect.andThen(Scope.close(scope, exit), owned.onEnd(exit))
          }),
          owner.scope
        )
        const stop = Effect.suspend(() => {
          if (stopped) return Effect.void
          stopped = true
          return Effect.andThen(Fiber.interrupt(fiber), Scope.close(scope, Exit.void))
        })
        return {
          id,
          descriptor: undefined,
          send: endpoint.send as Process["send"],
          stop,
          ref: refOf(id, endpoint.sessionId, endpoint.send, turn(stop), () => state, done)
        }
      })

    /** Stops what runs for a piece of work, and reports nothing of it after. */
    const stopWork = (runner: Runner, work: Work): Effect.Effect<void> =>
      Effect.suspend(() => {
        forget(work)
        const running = runner.running.get(work)
        runner.running.delete(work)
        if (running === undefined || running.stopped) return Effect.void
        running.stopped = true
        if (running.process !== undefined) return running.process.stop
        return running.fiber === undefined ? Effect.void : Fiber.interrupt(running.fiber)
      })

    /** Carries out what one step says, in the order it is given in. */
    const carryOut = (runner: Runner, done: Step): Effect.Effect<void> =>
      Effect.gen(function*() {
        runner.state = done.state
        runner.exit = done.exit
        for (const command of done.commands) {
          switch (command._tag) {
            case "Send":
              yield* Effect.ignore(command.target.send(command.event))
              break
            case "SendToChild": {
              const process = command.work === undefined
                ? findProcess(runner, command.child)
                : runner.running.get(command.work)?.process
              if (process !== undefined) yield* process.send(command.event)
              break
            }
            case "StopChild":
              yield* command.work === undefined ? stopChild(runner, command.child) : stopWork(runner, command.work)
              break
          }
        }
        // Stopped together, as a local machine interrupts the work of exited states.
        yield* Effect.all(done.stop.map((work) => stopWork(runner, work)), { concurrency: "unbounded", discard: true })
        yield* runner.publish(done)
        for (const work of done.start) {
          // Work that could not start fails the machine, which starts nothing more.
          if (runner.state !== done.state) break
          yield* startWork(runner, work)
        }
        if (done.exit !== undefined) {
          const spawned = Array.from(runner.spawned.values())
          runner.spawned.clear()
          yield* Effect.forEach(spawned.reverse(), (process) => process.stop, { discard: true })
          Deferred.doneUnsafe(runner.done, done.exit)
          yield* runner.ended(done.exit)
        }
      })

    /** Reports in a turn of its own how work ended, unless the host stopped it. */
    const settleLater = (runner: Runner, work: Work, running: Running) => (exit: Exit.Exit<unknown, unknown>) =>
      Effect.asVoid(Effect.forkIn(
        turn(Effect.suspend(() => {
          if (running.stopped) return Effect.void
          runner.running.delete(work)
          return carryOut(runner, runner.step.settle(runner.state!, work, exit))
        })),
        runner.scope
      ))

    /** Work that could not start: the step fails the machine at once. */
    const cannotStart = (runner: Runner, work: Work, exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
      carryOut(runner, runner.step.settle(runner.state!, work, exit))

    const fork = (runner: Runner, work: Work, effect: Effect.Effect<unknown, unknown>): Effect.Effect<void> =>
      Effect.gen(function*() {
        const running: Running = { stopped: false }
        const fiber = yield* Effect.forkIn(effect, runner.scope, { startImmediately: true })
        running.fiber = fiber
        runner.running.set(work, running)
        yield* Effect.forkIn(Effect.flatMap(Fiber.await(fiber), settleLater(runner, work, running)), runner.scope, {
          startImmediately: true
        })
      })

    const own = (
      runner: Runner,
      work: Machine.MachineStep.Work.Logic<any> | Machine.MachineStep.Work.Child<any>,
      start: (owned: Owned) => Effect.Effect<Process, unknown>
    ) =>
      Effect.gen(function*() {
        const running: Running = { stopped: false }
        runner.running.set(work, running)
        const owned: Owned = {
          current: () => !running.stopped,
          onEnd: (exit) => running.stopped ? Effect.void : settleLater(runner, work, running)(exit),
          onSnapshot: (snapshot) =>
            turn(Effect.suspend(() =>
              running.stopped ? Effect.void : carryOut(runner, runner.step.report(runner.state!, work, snapshot))
            ))
        }
        const started = yield* Effect.exit(start(owned))
        if (Exit.isFailure(started)) {
          runner.running.delete(work)
          return yield* cannotStart(runner, work, started)
        }
        running.process = started.value
      })

    const startWork = (runner: Runner, work: Work): Effect.Effect<void> => {
      switch (work._tag) {
        case "Effect": {
          const effect = work.effect()
          return Exit.isFailure(effect)
            ? cannotStart(runner, work, effect)
            : fork(runner, work, effect.value as Effect.Effect<unknown, unknown>)
        }
        case "Timer": {
          const duration = work.duration()
          if (Exit.isFailure(duration)) return cannotStart(runner, work, duration)
          const millis = Duration.toMillis(duration.value)
          if (millis <= 0) return fork(runner, work, Effect.void)
          return Effect.sync(() => {
            runner.running.set(work, { stopped: false })
            // A timer of infinite duration never falls due, so no clock keeps it.
            if (millis === Infinity) return
            const due = now + millis
            const index = timers.findIndex((timer) => timer.due > due)
            timers.splice(index < 0 ? timers.length : index, 0, { due, life: runner.life, runner, work })
          })
        }
        case "Stream": {
          const stream = work.stream()
          if (Exit.isFailure(stream)) return cannotStart(runner, work, stream)
          return fork(
            runner,
            work,
            Stream.runForEach(stream.value as Stream.Stream<unknown, unknown>, (element) =>
              // Taken in a turn of its own, which may stop this stream, and the
              // next element is pulled once it is taken.
              Effect.flatMap(
                Effect.forkIn(
                  turn(Effect.suspend(() => carryOut(runner, runner.step.element(runner.state!, work, element)))),
                  runner.scope,
                  { startImmediately: true }
                ),
                Fiber.join
              ))
          )
        }
        case "Logic": {
          const logic = work.logic()
          if (Exit.isFailure(logic)) return cannotStart(runner, work, logic)
          return own(runner, work, (owned) => runLogic(runner, logic.value as AnyLogic, work.address, owned))
        }
        case "Child": {
          const input = work.input()
          if (Exit.isFailure(input)) return cannotStart(runner, work, input)
          return own(
            runner,
            work,
            (owned) => hostMachine(runner, work.child.machine, work.child.id, work.child, input.value, owned)
          )
        }
      }
    }

    const takeEvent = (runner: Runner, event: object): Effect.Effect<Answer> =>
      Effect.suspend(() => {
        if (runner.state === undefined || runner.exit !== undefined) return Effect.succeed("Ended" as const)
        const result = runner.step.send(runner.state, event)
        if (Exit.isSuccess(result)) return Effect.as(carryOut(runner, result.value), "Accepted" as const)
        return Effect.succeed(isStopped(result.cause) ? "Ended" as const : "Rejected" as const)
      })

    let root: Runner

    const open = Effect.fnUntraced(function*(starting: (step: AnyStep) => Exit.Exit<Step, unknown>) {
      const current: Life = { scope: yield* Scope.fork(outer), startFailure: undefined }
      life = current
      // The timers of a life end with it.
      yield* Scope.addFinalizer(
        current.scope,
        Effect.sync(() => {
          for (const timer of timers.filter((timer) => timer.life === current)) forget(timer.work)
        })
      )
      root = yield* makeRunner({ life: current, scope: current.scope }, machine, {
        id: machine.id ?? "Machine",
        parent: undefined,
        publish: (done) =>
          Effect.sync(() => {
            states.push(encode(machine, done.snapshot))
            emitted.push(...done.emitted)
          }),
        ended: () => Effect.void
      })
      const started = starting(root.step)
      if (Exit.isFailure(started)) {
        current.startFailure = renderFailure(started.cause)
        return
      }
      yield* turn(carryOut(root, started.value))
    })

    // The suite passes the decoded input of a machine that declares one.
    yield* open((step) => step.start(...(input as [])))

    /** Fires a timer that fell due, in a turn of its own. */
    const fire = (runner: Runner, work: Work): Effect.Effect<void> =>
      turn(Effect.suspend(() => {
        const running = runner.running.get(work)
        if (running === undefined || running.stopped) return Effect.void
        runner.running.delete(work)
        return carryOut(runner, runner.step.settle(runner.state!, work, Exit.void))
      }))

    const advance = Effect.fnUntraced(function*(duration: Duration.Input) {
      const until = now + Duration.toMillis(Duration.fromInputUnsafe(duration))
      while (timers.length > 0 && timers[0]!.due <= until) {
        const next = timers[0]!
        if (next.due > now) {
          // The test clock moves to the due time before the timer fires, and
          // what wakes on it settles first. Work of the scenario that sleeps
          // until that time has then happened, as it has on a host whose timers
          // wait on the same clock, and work that the timer starts reads the
          // time at which the timer fired. A timer that this stops never fires.
          yield* TestClock.adjust(next.due - now)
          now = next.due
          yield* settle
          continue
        }
        timers.shift()
        yield* fire(next.runner, next.work)
        yield* settle
      }
      yield* TestClock.adjust(until - now)
      now = until
    })

    return {
      settle,
      advance,
      states,
      emitted,
      // The state that a step publishes holds until the next one, also while its
      // work starts.
      current: () => root.state === undefined ? undefined : states.at(-1),
      send: (event) => turn(takeEvent(root, event)),
      outcome: Effect.sync((): Outcome => {
        if (life.startFailure !== undefined) return { _tag: "Failed", failure: life.startFailure }
        const exit = root.exit
        if (exit === undefined) return { _tag: "Running" }
        if (Exit.isSuccess(exit)) {
          return exit.value === undefined
            ? { _tag: "Final" }
            : { _tag: "Final", output: exit.value }
        }
        return isStopped(exit.cause) ? { _tag: "Stopped" } : { _tag: "Failed", failure: renderFailure(exit.cause) }
      }),
      stop: turn(
        Effect.suspend(() =>
          root.state === undefined || root.exit !== undefined ? Effect.void : carryOut(root, root.step.stop(root.state))
        )
      ),
      restart: Effect.fnUntraced(function*(downtimeMillis) {
        if (root.state === undefined) return
        const stored = states.at(-1)!
        yield* Scope.close(life.scope, Exit.void)
        yield* advance(downtimeMillis)
        yield* open((step) => step.resume(decode(machine, stored)))
      })
    }
  })
}
