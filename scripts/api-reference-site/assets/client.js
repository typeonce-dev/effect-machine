const root = document.documentElement
const basePath = document.querySelector("meta[name=\"api-reference-base\"]")?.content ?? "/"
const themeButton = document.querySelector(".theme-button")
const navigationButton = document.querySelector(".mobile-navigation-button")
const navigationClose = document.querySelector(".navigation-close")
const navigationBackdrop = document.querySelector(".navigation-backdrop")
const searchDialog = document.querySelector("[data-search-dialog]")
const searchInput = document.querySelector("[data-search-input]")
const searchStatus = document.querySelector("[data-search-status]")
const searchResults = document.querySelector("[data-search-results]")

const themes = ["auto", "light", "dark"]
const themeLabels = { auto: "System", light: "Light", dark: "Dark" }

const updateThemeButton = () => {
  const theme = root.dataset.theme ?? "auto"
  const label = themeLabels[theme]
  themeButton.textContent = label
  themeButton.title = `Current theme: ${label}`
}

themeButton?.addEventListener("click", () => {
  const current = themes.indexOf(root.dataset.theme ?? "auto")
  const theme = themes[(current + 1) % themes.length]
  root.dataset.theme = theme
  localStorage.setItem("api-theme", theme)
  updateThemeButton()
})
updateThemeButton()

const setNavigationOpen = (open) => {
  document.body.classList.toggle("navigation-is-open", open)
  navigationButton?.setAttribute("aria-expanded", String(open))
}
navigationButton?.addEventListener("click", () => setNavigationOpen(true))
navigationClose?.addEventListener("click", () => setNavigationOpen(false))
navigationBackdrop?.addEventListener("click", () => setNavigationOpen(false))

let pagefindPromise
let searchSequence = 0

const loadPagefind = () => {
  pagefindPromise ??= import(`${basePath}pagefind/pagefind.js`).then(async (pagefind) => {
    await pagefind.options({ baseUrl: basePath })
    return pagefind
  })
  return pagefindPromise
}

const openSearch = () => {
  searchDialog?.showModal()
  searchInput?.focus()
}

const closeSearch = () => searchDialog?.close()

document.querySelectorAll("[data-open-search]").forEach((button) => button.addEventListener("click", openSearch))
document.querySelector("[data-close-search]")?.addEventListener("click", closeSearch)
searchDialog?.addEventListener("click", (event) => {
  if (event.target === searchDialog) closeSearch()
})

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault()
    openSearch()
  }
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !/input|textarea/i.test(event.target.tagName)) {
    event.preventDefault()
    openSearch()
  }
})

searchInput?.addEventListener("input", async () => {
  const query = searchInput.value.trim()
  const sequence = ++searchSequence
  searchResults.replaceChildren()
  if (query.length < 2) {
    searchStatus.textContent = "Type at least two characters to search."
    return
  }
  searchStatus.textContent = "Searching…"
  try {
    const pagefind = await loadPagefind()
    const search = await pagefind.search(query)
    const data = await Promise.all(search.results.slice(0, 12).map((result) => result.data()))
    if (sequence !== searchSequence) return
    searchStatus.textContent = `${search.results.length} result${search.results.length === 1 ? "" : "s"}`
    for (const result of data) {
      const item = document.createElement("li")
      const link = document.createElement("a")
      const title = document.createElement("strong")
      const excerpt = document.createElement("span")
      link.href = result.url
      title.textContent = result.meta.title
      excerpt.innerHTML = result.excerpt
      link.append(title, excerpt)
      item.append(link)
      searchResults.append(item)
    }
  } catch (error) {
    searchStatus.textContent = "Search is unavailable in this preview."
    console.error(error)
  }
})

document.querySelectorAll(".copy-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const source = button.parentElement?.querySelector("code")?.textContent
    if (source === undefined) return
    await navigator.clipboard.writeText(source)
    button.textContent = "Copied"
    setTimeout(() => {
      button.textContent = "Copy"
    }, 1_200)
  })
})
