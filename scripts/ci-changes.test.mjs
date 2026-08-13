import { strict as assert } from "node:assert"
import { test } from "node:test"
import { classifyChanges } from "./ci-changes.mjs"

const packageJson = {
  devDependencies: {
    dprint: "1.0.0",
    effect: "4.0.0",
    tinybench: "2.0.0",
    typescript: "6.0.0"
  }
}

const classify = (changedFiles, afterPackageJson = packageJson) =>
  classifyChanges({
    afterPackageJson,
    availableExamples: ["platformer", "playground", "pokemon"],
    beforePackageJson: packageJson,
    changedFiles
  })

test("skips performance and examples for documentation changes", () => {
  assert.deepEqual(classify(["README.md", "docs/agent-guide.md"]), {
    examples: [],
    runtimePerformance: false,
    typePerformance: false
  })
})

test("selects only the changed example", () => {
  assert.deepEqual(classify(["examples/pokemon/src/machine.ts"]), {
    examples: ["pokemon"],
    runtimePerformance: false,
    typePerformance: false
  })
})

test("runs type performance and every example for public source changes", () => {
  assert.deepEqual(classify(["src/index.ts"]), {
    examples: ["platformer", "playground", "pokemon"],
    runtimePerformance: false,
    typePerformance: true
  })
})

test("adds runtime performance for machine implementation changes", () => {
  assert.deepEqual(classify(["src/internal/machine/runtime.ts"]), {
    examples: ["platformer", "playground", "pokemon"],
    runtimePerformance: true,
    typePerformance: true
  })
})

test("distinguishes performance dependencies from unrelated tooling", () => {
  assert.deepEqual(classify(["package.json"], {
    ...packageJson,
    devDependencies: { ...packageJson.devDependencies, dprint: "2.0.0" }
  }), {
    examples: ["platformer", "playground", "pokemon"],
    runtimePerformance: false,
    typePerformance: false
  })
  assert.deepEqual(classify(["package.json"], {
    ...packageJson,
    devDependencies: { ...packageJson.devDependencies, effect: "4.1.0" }
  }), {
    examples: ["platformer", "playground", "pokemon"],
    runtimePerformance: true,
    typePerformance: true
  })
})

test("classifies performance harness and classifier changes", () => {
  assert.deepEqual(classify(["scripts/type-performance.mjs"]), {
    examples: [],
    runtimePerformance: false,
    typePerformance: true
  })
  assert.deepEqual(classify(["scripts/ci-changes.mjs"]), {
    examples: ["platformer", "playground", "pokemon"],
    runtimePerformance: true,
    typePerformance: true
  })
})
