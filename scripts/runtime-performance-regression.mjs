const regressionThreshold = (floorPercent, beforeVariability, afterVariability) =>
  Math.max(floorPercent, 3 * Math.max(beforeVariability, afterVariability))

export const findRuntimePerformanceRegressions = (
  base,
  pullRequest,
  { heapFloorPercent = 20, throughputFloorPercent = 15 } = {}
) => {
  const regressions = []
  const baseBenchmarks = new Map(
    base.benchmarks
      .filter((benchmark) => benchmark.implementation === "effect-machine")
      .map((benchmark) => [benchmark.id, benchmark])
  )
  for (const after of pullRequest.benchmarks.filter(
    (benchmark) => benchmark.implementation === "effect-machine"
  )) {
    const before = baseBenchmarks.get(after.id)
    if (before === undefined || before.unit !== after.unit || before.medianThroughput <= 0) {
      continue
    }
    const decreasePercent = (before.medianThroughput - after.medianThroughput) / before.medianThroughput * 100
    const thresholdPercent = regressionThreshold(
      throughputFloorPercent,
      before.processRelativeMad,
      after.processRelativeMad
    )
    if (decreasePercent > thresholdPercent) {
      regressions.push({
        changePercent: decreasePercent,
        id: after.id,
        kind: "throughput",
        label: after.label,
        thresholdPercent
      })
    }
  }

  const beforeMemory = base.memory.find((measurement) => measurement.implementation === "effect-machine")
  const afterMemory = pullRequest.memory.find((measurement) => measurement.implementation === "effect-machine")
  if (beforeMemory === undefined || afterMemory === undefined) {
    return regressions
  }
  for (const after of afterMemory.profiles ?? []) {
    const before = beforeMemory.profiles?.find((profile) => profile.id === after.id)
    if (before === undefined || before.heapBytesPerIdleMachine <= 0) {
      continue
    }
    const increasePercent = (after.heapBytesPerIdleMachine - before.heapBytesPerIdleMachine) /
      before.heapBytesPerIdleMachine * 100
    const thresholdPercent = regressionThreshold(
      heapFloorPercent,
      before.processRelativeMad,
      after.processRelativeMad
    )
    if (increasePercent > thresholdPercent) {
      regressions.push({
        changePercent: increasePercent,
        id: after.id,
        kind: "heap",
        label: after.label,
        thresholdPercent
      })
    }
  }

  return regressions
}
