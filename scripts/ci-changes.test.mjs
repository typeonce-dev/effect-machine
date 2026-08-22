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
    beforePackageJson: packageJson,
    changedFiles
  })

test("skips performance for documentation changes", () => {
  assert.deepEqual(classify(["README.md", "docs/agent-guide.md"]), {
    runtimePerformance: false,
    typePerformance: false
  })
})

test("runs type performance for public source changes", () => {
  assert.deepEqual(classify(["src/index.ts"]), {
    runtimePerformance: false,
    typePerformance: true
  })
})

test("adds runtime performance for machine implementation changes", () => {
  assert.deepEqual(classify(["src/internal/machine/runtime.ts"]), {
    runtimePerformance: true,
    typePerformance: true
  })
})

test("distinguishes performance dependencies from unrelated tooling", () => {
  assert.deepEqual(classify(["package.json"], {
    ...packageJson,
    devDependencies: { ...packageJson.devDependencies, dprint: "2.0.0" }
  }), {
    runtimePerformance: false,
    typePerformance: false
  })
  assert.deepEqual(classify(["package.json"], {
    ...packageJson,
    devDependencies: { ...packageJson.devDependencies, effect: "4.1.0" }
  }), {
    runtimePerformance: true,
    typePerformance: true
  })
})

test("classifies performance harness and classifier changes", () => {
  assert.deepEqual(classify(["scripts/type-performance.mjs"]), {
    runtimePerformance: false,
    typePerformance: true
  })
  assert.deepEqual(classify(["scripts/ci-changes.mjs"]), {
    runtimePerformance: true,
    typePerformance: true
  })
})
