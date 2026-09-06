/**
 * Compares decoded trace data without serializing it or invoking getters.
 * Collection order and cycles must agree. Decoding may copy a shared value,
 * so aliases outside the current comparison path do not require identity.
 * Functions, symbols, and objects with opaque state retain identity semantics.
 */
export const sameValue = (left: unknown, right: unknown): boolean => {
  const leftToRight = new WeakMap<object, object>()
  const rightToLeft = new WeakMap<object, object>()
  const compare = (a: unknown, b: unknown): boolean => {
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
      return Object.is(a, b)
    }
    const knownRight = leftToRight.get(a)
    const knownLeft = rightToLeft.get(b)
    if (knownRight !== undefined || knownLeft !== undefined) return knownRight === b && knownLeft === a
    leftToRight.set(a, b)
    rightToLeft.set(b, a)
    try {
      if (a === b) return true
      if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false

      if (a instanceof Date && b instanceof Date && !Object.is(a.getTime(), b.getTime())) return false
      if (a instanceof RegExp && b instanceof RegExp && (a.source !== b.source || a.flags !== b.flags)) return false
      if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
        if (!sameBytes(new Uint8Array(a), new Uint8Array(b))) return false
      } else if (
        typeof SharedArrayBuffer !== "undefined" && a instanceof SharedArrayBuffer && b instanceof SharedArrayBuffer
      ) {
        if (!sameBytes(new Uint8Array(a), new Uint8Array(b))) return false
      } else if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
        if (
          !sameBytes(
            new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
            new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
          )
        ) return false
      } else if (a instanceof Map && b instanceof Map) {
        if (a.size !== b.size) return false
        const entries = Array.from(b)
        if (
          !Array.from(a).every(([key, value], index) =>
            compare(key, entries[index]![0]) && compare(value, entries[index]![1])
          )
        ) return false
      } else if (a instanceof Set && b instanceof Set) {
        if (a.size !== b.size) return false
        const values = Array.from(b)
        if (!Array.from(a).every((value, index) => compare(value, values[index]))) return false
      } else if (a instanceof WeakMap || a instanceof WeakSet || a instanceof Promise) {
        return false
      }

      const keys = Reflect.ownKeys(a)
      if (keys.length !== Reflect.ownKeys(b).length) return false
      if (
        keys.length === 0 && Object.getPrototypeOf(a) !== null && Object.getPrototypeOf(a) !== Object.prototype &&
        !(a instanceof Date || a instanceof RegExp || a instanceof Map || a instanceof Set ||
          a instanceof ArrayBuffer || ArrayBuffer.isView(a)) &&
        !(typeof SharedArrayBuffer !== "undefined" && a instanceof SharedArrayBuffer)
      ) return false
      return keys.every((key) => {
        const x = Object.getOwnPropertyDescriptor(a, key)!
        const y = Object.getOwnPropertyDescriptor(b, key)
        if (y === undefined || x.enumerable !== y.enumerable || ("value" in x) !== ("value" in y)) return false
        return "value" in x ? compare(x.value, y.value) : x.get === y.get && x.set === y.set
      })
    } finally {
      leftToRight.delete(a)
      rightToLeft.delete(b)
    }
  }
  return compare(left, right)
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
