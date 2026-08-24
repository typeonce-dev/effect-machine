import type { InputSchema } from "../../MachineDocument.js"

type JsonPrimitive = string | number | boolean | null

export type InputField =
  | {
    readonly _tag: "String"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly defaultValue: string | undefined
    readonly format: string | undefined
    readonly minLength: number | undefined
    readonly maxLength: number | undefined
    readonly pattern: string | undefined
  }
  | {
    readonly _tag: "Number"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly defaultValue: number | undefined
    readonly integer: boolean
    readonly minimum: number | undefined
    readonly maximum: number | undefined
  }
  | {
    readonly _tag: "Boolean"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly defaultValue: boolean | undefined
  }
  | {
    readonly _tag: "Enum"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly values: ReadonlyArray<JsonPrimitive>
    readonly defaultValue: JsonPrimitive | undefined
  }
  | {
    readonly _tag: "Literal"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly value: JsonPrimitive
  }
  | {
    readonly _tag: "Object"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly fields: ReadonlyArray<{
      readonly key: string
      readonly required: boolean
      readonly field: InputField
    }>
  }
  | {
    readonly _tag: "Array"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly item: InputField
    readonly minItems: number
    readonly maxItems: number | undefined
  }
  | {
    readonly _tag: "Union"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly alternatives: ReadonlyArray<InputField>
  }
  | {
    readonly _tag: "Unsupported"
    readonly title: string | undefined
    readonly description: string | undefined
    readonly reason: string
  }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const stringValue = (value: unknown): string | undefined => typeof value === "string" ? value : undefined

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const primitiveValue = (value: unknown): JsonPrimitive | undefined =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined

const resolveReference = (
  value: unknown,
  definitions: Readonly<Record<string, unknown>>,
  seen: ReadonlySet<string> = new Set()
): unknown => {
  if (!isRecord(value) || typeof value.$ref !== "string" || !value.$ref.startsWith("#/$defs/")) return value
  const name = decodeURIComponent(value.$ref.slice("#/$defs/".length))
  if (seen.has(name)) return undefined
  const next = definitions[name]
  return resolveReference(next, definitions, new Set([...seen, name]))
}

const annotations = (schema: Record<string, unknown>) => ({
  title: stringValue(schema.title),
  description: stringValue(schema.description)
})

const project = (
  value: unknown,
  definitions: Readonly<Record<string, unknown>>
): InputField => {
  const resolved = resolveReference(value, definitions)
  if (!isRecord(resolved)) {
    return {
      _tag: "Unsupported",
      title: undefined,
      description: undefined,
      reason: "This input schema cannot be represented as fields."
    }
  }
  const common = annotations(resolved)
  const alternatives = Array.isArray(resolved.oneOf)
    ? resolved.oneOf
    : Array.isArray(resolved.anyOf)
    ? resolved.anyOf
    : undefined
  if (alternatives !== undefined) {
    return {
      _tag: "Union",
      ...common,
      alternatives: alternatives.map((alternative) => project(alternative, definitions))
    }
  }
  const constant = primitiveValue(resolved.const)
  if (constant !== undefined || resolved.const === null) {
    return { _tag: "Literal", ...common, value: constant ?? null }
  }
  if (Array.isArray(resolved.enum)) {
    const values = resolved.enum.map(primitiveValue).filter((item): item is JsonPrimitive => item !== undefined)
    if (values.length > 0) {
      return {
        _tag: "Enum",
        ...common,
        values,
        defaultValue: primitiveValue(resolved.default)
      }
    }
  }
  switch (resolved.type) {
    case "string":
      return {
        _tag: "String",
        ...common,
        defaultValue: stringValue(resolved.default),
        format: stringValue(resolved.format),
        minLength: numberValue(resolved.minLength),
        maxLength: numberValue(resolved.maxLength),
        pattern: stringValue(resolved.pattern)
      }
    case "integer":
    case "number":
      return {
        _tag: "Number",
        ...common,
        defaultValue: numberValue(resolved.default),
        integer: resolved.type === "integer",
        minimum: numberValue(resolved.minimum),
        maximum: numberValue(resolved.maximum)
      }
    case "boolean":
      return {
        _tag: "Boolean",
        ...common,
        defaultValue: typeof resolved.default === "boolean" ? resolved.default : undefined
      }
    case "null":
      return { _tag: "Literal", ...common, value: null }
    case "object": {
      if (!isRecord(resolved.properties)) {
        return { _tag: "Object", ...common, fields: [] }
      }
      const required = new Set(
        Array.isArray(resolved.required)
          ? resolved.required.filter((item): item is string => typeof item === "string")
          : []
      )
      return {
        _tag: "Object",
        ...common,
        fields: Object.entries(resolved.properties).map(([key, child]) => ({
          key,
          required: required.has(key),
          field: project(child, definitions)
        }))
      }
    }
    case "array":
      return {
        _tag: "Array",
        ...common,
        item: project(resolved.items, definitions),
        minItems: numberValue(resolved.minItems) ?? 0,
        maxItems: numberValue(resolved.maxItems)
      }
    default:
      return {
        _tag: "Unsupported",
        ...common,
        reason: "This input schema has no concrete JSON shape to render."
      }
  }
}

export const projectInputSchema = (document: InputSchema): InputField => project(document.schema, document.definitions)

export interface InputFormResult {
  readonly ok: boolean
  readonly value?: unknown
}

export interface InputForm {
  readonly element: HTMLFormElement
  readonly hasFields: boolean
  readonly supported: boolean
  readonly read: () => InputFormResult
}

interface Control {
  readonly element: HTMLElement
  readonly interactive: boolean
  readonly supported: boolean
  readonly read: () => unknown
}

let nextControlId = 0

const element = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  className?: string,
  text?: string
): HTMLElementTagNameMap[Tag] => {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

const valueKey = (value: JsonPrimitive): string => JSON.stringify(value)

const labelText = (field: InputField, fallback: string): string => field.title ?? fallback

const description = (field: InputField): HTMLElement | undefined =>
  field.description === undefined ? undefined : element("p", "input-description", field.description)

const renderControl = (field: InputField, name: string): Control => {
  switch (field._tag) {
    case "String": {
      const input = element("input", "input-control")
      input.type = field.format === "date-time"
        ? "datetime-local"
        : field.format === "date"
        ? "date"
        : field.format === "email"
        ? "email"
        : field.format === "uri"
        ? "url"
        : "text"
      input.name = name
      input.value = field.defaultValue ?? ""
      if (field.minLength !== undefined) input.minLength = field.minLength
      if (field.maxLength !== undefined) input.maxLength = field.maxLength
      if (field.pattern !== undefined) input.pattern = field.pattern
      return { element: input, interactive: true, supported: true, read: () => input.value }
    }
    case "Number": {
      const input = element("input", "input-control")
      input.type = "number"
      input.name = name
      input.step = field.integer ? "1" : "any"
      if (field.defaultValue !== undefined) input.value = String(field.defaultValue)
      if (field.minimum !== undefined) input.min = String(field.minimum)
      if (field.maximum !== undefined) input.max = String(field.maximum)
      return {
        element: input,
        interactive: true,
        supported: true,
        read: () => input.value === "" ? undefined : Number(input.value)
      }
    }
    case "Boolean": {
      const wrapper = element("label", "boolean-control")
      const input = element("input")
      input.type = "checkbox"
      input.name = name
      input.checked = field.defaultValue ?? false
      wrapper.append(input, element("span", undefined, "Enabled"))
      return { element: wrapper, interactive: true, supported: true, read: () => input.checked }
    }
    case "Enum": {
      const select = element("select", "input-control")
      select.name = name
      field.values.forEach((value) => {
        const option = element("option", undefined, String(value))
        option.value = valueKey(value)
        option.selected = Object.is(value, field.defaultValue)
        select.append(option)
      })
      return {
        element: select,
        interactive: true,
        supported: true,
        read: () => JSON.parse(select.value) as JsonPrimitive
      }
    }
    case "Literal": {
      const output = element("output", "literal-control", String(field.value))
      return { element: output, interactive: false, supported: true, read: () => field.value }
    }
    case "Object": {
      const group = element("fieldset", "input-object")
      const legend = element("legend", undefined, labelText(field, name))
      group.append(legend)
      const controls: Array<{
        readonly key: string
        readonly included: HTMLInputElement | undefined
        readonly control: Control
      }> = []
      for (const property of field.fields) {
        const row = element("div", "input-field")
        const heading = element("div", "input-field-heading")
        const label = element("label", "input-label", labelText(property.field, property.key))
        const required = property.required ? element("span", "input-required", "required") : undefined
        let included: HTMLInputElement | undefined
        const control = renderControl(property.field, `${name}.${property.key}`)
        const labelled = control.element instanceof HTMLInputElement || control.element instanceof HTMLSelectElement
          ? control.element
          : control.element.querySelector<HTMLInputElement | HTMLSelectElement>(":scope > input, :scope > select")
        if (labelled !== null) {
          const id = `machine-input-${nextControlId++}`
          labelled.id = id
          label.htmlFor = id
        }
        if (property.required) {
          if (
            control.element instanceof HTMLSelectElement ||
            (control.element instanceof HTMLInputElement && control.element.type !== "checkbox")
          ) {
            control.element.required = true
          }
          heading.append(label, required!)
        } else {
          const optional = element("label", "input-optional")
          included = element("input")
          included.type = "checkbox"
          optional.append(included, element("span", undefined, "include"))
          heading.append(label, optional)
          control.element.toggleAttribute("inert", true)
          control.element.classList.add("is-disabled")
          control.element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
            "input, select, button"
          ).forEach((item) => item.disabled = true)
          if (
            control.element instanceof HTMLInputElement ||
            control.element instanceof HTMLSelectElement ||
            control.element instanceof HTMLButtonElement
          ) control.element.disabled = true
          included.addEventListener("change", () => {
            control.element.toggleAttribute("inert", !included!.checked)
            control.element.classList.toggle("is-disabled", !included!.checked)
            control.element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(
              "input, select, button"
            ).forEach((item) => item.disabled = !included!.checked)
            if (
              control.element instanceof HTMLInputElement ||
              control.element instanceof HTMLSelectElement ||
              control.element instanceof HTMLButtonElement
            ) control.element.disabled = !included!.checked
          })
        }
        row.append(heading, control.element)
        const details = description(property.field)
        if (details !== undefined) row.append(details)
        group.append(row)
        controls.push({ key: property.key, included, control })
      }
      return {
        element: group,
        interactive: controls.some(({ control }) => control.interactive),
        supported: controls.every(({ control }) => control.supported),
        read: () =>
          Object.fromEntries(
            controls
              .filter(({ included }) => included === undefined || included.checked)
              .map(({ key, control }) => [key, control.read()])
              .filter((entry) => entry[1] !== undefined)
          )
      }
    }
    case "Array": {
      const group = element("fieldset", "input-array")
      group.append(element("legend", undefined, labelText(field, name)))
      const items = element("div", "input-array-items")
      const controls: Array<{ readonly row: HTMLElement; readonly control: Control }> = []
      const add = element("button", "input-array-add", "Add item")
      add.type = "button"
      const addItem = (): void => {
        if (field.maxItems !== undefined && controls.length >= field.maxItems) return
        const row = element("div", "input-array-item")
        const control = renderControl(field.item, `${name}.${controls.length}`)
        const remove = element("button", "input-array-remove", "Remove")
        remove.type = "button"
        remove.addEventListener("click", () => {
          row.remove()
          const index = controls.findIndex((item) => item.row === row)
          if (index >= 0) controls.splice(index, 1)
          add.disabled = false
        })
        row.append(control.element, remove)
        items.append(row)
        controls.push({ row, control })
        add.disabled = field.maxItems !== undefined && controls.length >= field.maxItems
      }
      for (let index = 0; index < field.minItems; index++) addItem()
      add.addEventListener("click", addItem)
      group.append(items, add)
      return {
        element: group,
        interactive: true,
        supported: controls.every(({ control }) => control.supported) && field.item._tag !== "Unsupported",
        read: () => controls.map(({ control }) => control.read())
      }
    }
    case "Union": {
      const group = element("fieldset", "input-union")
      group.append(element("legend", undefined, labelText(field, name)))
      const select = element("select", "input-control")
      const body = element("div", "input-union-body")
      let selected = 0
      const controls = field.alternatives.map((alternative, index) => {
        const control = renderControl(alternative, `${name}.${index}`)
        const option = element("option", undefined, labelText(alternative, `Option ${index + 1}`))
        option.value = String(index)
        select.append(option)
        return control
      })
      const update = (): void => {
        selected = Number(select.value)
        body.replaceChildren(controls[selected]?.element ?? element("div"))
      }
      select.addEventListener("change", update)
      group.append(select, body)
      update()
      return {
        element: group,
        interactive: true,
        supported: controls.every(({ supported }) => supported),
        read: () => controls[selected]?.read()
      }
    }
    case "Unsupported": {
      const message = element("p", "input-unsupported", field.reason)
      return { element: message, interactive: false, supported: false, read: () => undefined }
    }
  }
}

export const renderInputForm = (
  schema: InputSchema,
  options: {
    readonly name: string
    readonly fixed?: Readonly<Record<string, JsonPrimitive>>
    readonly omit?: ReadonlyArray<string>
  }
): InputForm => {
  const form = element("form", "schema-form")
  const projected = projectInputSchema(schema)
  const visible = projected._tag === "Object" && options.omit !== undefined
    ? { ...projected, fields: projected.fields.filter(({ key }) => !options.omit!.includes(key)) }
    : projected
  const control = renderControl(visible, options.name)
  form.append(control.element)
  return {
    element: form,
    hasFields: control.interactive,
    supported: control.supported,
    read: () => {
      if (!form.reportValidity() || !control.supported) return { ok: false }
      const value = control.read()
      return {
        ok: true,
        value: isRecord(value) && options.fixed !== undefined ? { ...value, ...options.fixed } : value
      }
    }
  }
}
