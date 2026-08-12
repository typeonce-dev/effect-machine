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
const githubStars = document.querySelector("[data-github-stars]")

const themes = ["auto", "light", "dark"]
const themeLabels = { auto: "System theme", light: "Light theme", dark: "Dark theme" }

const updateThemeButton = () => {
  const theme = root.dataset.theme ?? "auto"
  themeButton.textContent = theme === "dark" ? "Light" : theme === "light" ? "Dark" : "Theme"
  themeButton.title = themeLabels[theme]
}

themeButton?.addEventListener("click", () => {
  const current = themes.indexOf(root.dataset.theme ?? "auto")
  const theme = themes[(current + 1) % themes.length]
  root.dataset.theme = theme
  localStorage.setItem("api-theme", theme)
  updateThemeButton()
})
updateThemeButton()

const showGitHubStars = (count) => {
  const countElement = githubStars?.querySelector("[data-github-star-count]")
  if (githubStars === null || countElement === null || !Number.isSafeInteger(count) || count < 0) return
  countElement.textContent = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
    notation: count >= 1_000 ? "compact" : "standard"
  }).format(count)
  githubStars.title = `${count.toLocaleString()} GitHub star${count === 1 ? "" : "s"}`
  githubStars.hidden = false
}

const loadGitHubStars = async () => {
  const repository = githubStars?.dataset.githubStars
  if (repository === undefined) return
  const cacheKey = `api-reference:github-stars:${repository}`
  try {
    const cached = sessionStorage.getItem(cacheKey)
    if (cached !== null) {
      showGitHubStars(Number(cached))
      return
    }
    const response = await fetch(`https://api.github.com/repos/${repository}`)
    if (!response.ok) return
    const body = await response.json()
    if (!Number.isSafeInteger(body.stargazers_count) || body.stargazers_count < 0) return
    sessionStorage.setItem(cacheKey, String(body.stargazers_count))
    showGitHubStars(body.stargazers_count)
  } catch {
    // The repository link remains usable when storage or GitHub is unavailable.
  }
}
void loadGitHubStars()

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
