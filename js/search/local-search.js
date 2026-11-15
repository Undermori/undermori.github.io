/**
 * Refer to hexo-generator-searchdb
 * https://github.com/next-theme/hexo-generator-searchdb/blob/main/dist/search.js
 * Modified by hexo-theme-butterfly
 */

class LocalSearch {
  constructor ({
    path = '',
    unescape = false,
    top_n_per_article = 1
  }) {
    this.path = path
    this.unescape = unescape
    this.top_n_per_article = top_n_per_article
    this.isfetched = false
    this.datas = null
    this._processedKeywords = null
  }

  _processKeywords (keywords) {
    if (this._processedKeywords) return this._processedKeywords
    this._processedKeywords = keywords.map(word => {
      if (this.unescape) {
        return word
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
      }
      return word
    })
    return this._processedKeywords
  }

  getIndexByWord (words, text, caseSensitive = false) {
    const index = []
    const included = new Set()
    const processedWords = this._processKeywords(words)

    if (!caseSensitive) {
      text = text.toLowerCase()
    }
    processedWords.forEach((word, i) => {
      const wordLen = word.length
      if (wordLen === 0) return
      let startPosition = 0
      let position = -1
      const searchWord = caseSensitive ? word : word.toLowerCase()
      while ((position = text.indexOf(searchWord, startPosition)) > -1) {
        index.push({ position, word })
        included.add(words[i])
        startPosition = position + wordLen
      }
    })
    // Sort index by position of keyword
    index.sort((left, right) => {
      if (left.position !== right.position) {
        return left.position - right.position
      }
      return right.word.length - left.word.length
    })
    return [index, included]
  }

  // Merge hits into slices
  mergeIntoSlice (start, end, index) {
    let item = index[0]
    let { position, word } = item
    const hits = []
    const count = new Set()
    while (position + word.length <= end && index.length !== 0) {
      count.add(word)
      hits.push({
        position,
        length: word.length
      })
      const wordEnd = position + word.length

      // Move to next position of hit
      index.shift()
      while (index.length !== 0) {
        item = index[0]
        position = item.position
        word = item.word
        if (wordEnd > position) {
          index.shift()
        } else {
          break
        }
      }
    }
    return {
      hits,
      start,
      end,
      count: count.size
    }
  }

  // Safely append highlighted text and <mark> nodes without innerHTML
  appendHighlightedText (parent, val, slice) {
    let index = slice.start
    for (const { position, length } of slice.hits) {
      if (position > index) {
        parent.appendChild(document.createTextNode(val.substring(index, position)))
      }
      index = position + length
      const mark = document.createElement('mark')
      mark.className = 'search-keyword'
      mark.textContent = val.substring(position, index)
      parent.appendChild(mark)
    }
    if (index < slice.end) {
      parent.appendChild(document.createTextNode(val.substring(index, slice.end)))
    }
  }

  buildResultNode (result, itemNumber) {
    const li = document.createElement('li')
    li.className = 'local-search-hit-item'
    li.value = itemNumber

    const link = document.createElement('a')
    link.href = result.href

    const titleSpan = document.createElement('span')
    titleSpan.className = 'search-result-title'
    if (result.slicesOfTitle.length !== 0) {
      this.appendHighlightedText(titleSpan, result.title, result.slicesOfTitle[0])
    } else {
      titleSpan.textContent = result.title
    }
    link.appendChild(titleSpan)

    result.slicesOfContent.forEach(slice => {
      const p = document.createElement('p')
      p.className = 'search-result'
      this.appendHighlightedText(p, result.content, slice)
      p.appendChild(document.createTextNode('...'))
      link.appendChild(p)
    })

    li.appendChild(link)
    return li
  }

  getResultItems (keywords) {
    const resultItems = []
    this._processedKeywords = null
    // Compute highlight param once instead of per-article
    const highlightParam = keywords.join(' ')
    this.datas.forEach(({ title, content, url }) => {
      // The number of different keywords included in the article.
      const [indexOfTitle, keysOfTitle] = this.getIndexByWord(keywords, title)
      const [indexOfContent, keysOfContent] = this.getIndexByWord(keywords, content)
      const includedCount = new Set([...keysOfTitle, ...keysOfContent]).size

      // Show search results
      const hitCount = indexOfTitle.length + indexOfContent.length
      if (hitCount === 0) return

      const slicesOfTitle = []
      if (indexOfTitle.length !== 0) {
        slicesOfTitle.push(this.mergeIntoSlice(0, title.length, indexOfTitle))
      }

      let slicesOfContent = []
      while (indexOfContent.length !== 0) {
        const item = indexOfContent[0]
        const { position } = item
        // Cut out 120 characters. The maxlength of .search-input is 80.
        const start = Math.max(0, position - 20)
        const end = Math.min(content.length, position + 100)
        slicesOfContent.push(this.mergeIntoSlice(start, end, indexOfContent))
      }

      // Sort slices in content by included keywords' count and hits' count
      slicesOfContent.sort((left, right) => {
        if (left.count !== right.count) {
          return right.count - left.count
        } else if (left.hits.length !== right.hits.length) {
          return right.hits.length - left.hits.length
        }
        return left.start - right.start
      })

      // Select top N slices in content
      const upperBound = parseInt(this.top_n_per_article, 10)
      if (upperBound >= 0) {
        slicesOfContent = slicesOfContent.slice(0, upperBound)
      }

      let safeUrl
      try {
        safeUrl = new URL(url, location.origin)
      } catch {
        return
      }
      if ((safeUrl.protocol !== 'http:' && safeUrl.protocol !== 'https:') || safeUrl.origin !== location.origin) {
        return
      }
      safeUrl.searchParams.append('highlight', highlightParam)

      resultItems.push({
        href: safeUrl.href,
        title,
        slicesOfTitle,
        content,
        slicesOfContent,
        id: resultItems.length,
        hitCount,
        includedCount
      })
    })
    return resultItems
  }

  fetchData () {
    const isXml = !this.path.endsWith('json')
    fetch(this.path)
      .then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
        return response.text()
      })
      .then(res => {
        // Get the contents from search data
        this.isfetched = true
        this.datas = isXml
          ? [...new DOMParser().parseFromString(res, 'text/xml').querySelectorAll('entry')].map(element => ({
              title: element.querySelector('title').textContent,
              content: element.querySelector('content').textContent,
              url: element.querySelector('url').textContent
            }))
          : JSON.parse(res)
        // Only match articles with non-empty titles
        this.datas = this.datas.filter(data => data.title).map(data => {
          data.title = data.title.trim()
          data.content = data.content ? data.content.trim().replace(/<[^>]+>/g, '') : ''
          data.url = decodeURIComponent(data.url).replace(/\/{2,}/g, '/')
          return data
        })
        // Remove loading animation
        window.dispatchEvent(new Event('search:loaded'))
      })
      .catch(error => {
        console.error('Local search data fetch failed:', error)
        this.isfetched = true
        this.datas = []
        window.dispatchEvent(new Event('search:loaded'))
      })
  }

  // Highlight by wrapping node in mark elements with the given class name
  highlightText (node, slice, className) {
    const val = node.nodeValue
    let index = slice.start
    const children = []
    for (const { position, length } of slice.hits) {
      const text = document.createTextNode(val.substring(index, position))
      index = position + length
      const mark = document.createElement('mark')
      mark.className = className
      mark.appendChild(document.createTextNode(val.substring(position, position + length)))
      children.push(text, mark)
    }
    node.nodeValue = val.substring(index, slice.end)
    children.forEach(element => {
      node.parentNode.insertBefore(element, node)
    })
  }

  // Highlight the search words provided in the url in the text
  highlightSearchWords (body) {
    const params = new URL(location.href).searchParams.get('highlight')
    const keywords = params ? params.split(' ') : []
    if (!keywords.length || !body) return
    const walk = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null)
    const allNodes = []
    while (walk.nextNode()) {
      if (!walk.currentNode.parentNode.matches('button, select, textarea, .mermaid')) allNodes.push(walk.currentNode)
    }
    allNodes.forEach(node => {
      const [indexOfNode] = this.getIndexByWord(keywords, node.nodeValue)
      if (!indexOfNode.length) return
      const slice = this.mergeIntoSlice(0, node.nodeValue.length, indexOfNode)
      this.highlightText(node, slice, 'search-keyword')
    })
  }
}

window.addEventListener('load', () => {
  // Search
  const { path, top_n_per_article, unescape, languages, pagination } = GLOBAL_CONFIG.localSearch
  const enablePagination = pagination && pagination.enable
  const localSearch = new LocalSearch({
    path,
    top_n_per_article,
    unescape
  })

  const $input = document.querySelector('#local-search-input input')
  const $statsItem = document.getElementById('local-search-stats-wrap')
  const $loadingStatus = document.getElementById('loading-status')
  const $searchDialog = document.getElementById('local-search-dialog') || document.querySelector('#local-search .search-dialog')
  const $results = document.getElementById('local-search-results')
  const $pagination = document.getElementById('local-search-pagination')
  const $paginationList = document.querySelector('#local-search-pagination .ais-Pagination-list')

  let isComposing = false
  let lastFocusedElement = null

  // Pagination variables (only initialize if pagination is enabled)
  let currentPage = 0
  const hitsPerPage = pagination.hitsPerPage || 10

  let currentResultItems = []

  if (!enablePagination) {
    currentPage = undefined
    currentResultItems = undefined
  }

  // Show/hide search results area
  const toggleResultsVisibility = hasResults => {
    $pagination.style.display = (hasResults && enablePagination && currentResultItems.length > hitsPerPage) ? '' : 'none'
  }

  // Render search results for current page (pure DOM nodes, zero innerHTML)
  const renderResults = (searchText, resultItems) => {
    const itemsToDisplay = enablePagination
      ? currentResultItems.slice(currentPage * hitsPerPage, (currentPage + 1) * hitsPerPage)
      : resultItems

    if (enablePagination && itemsToDisplay.length === 0 && currentResultItems.length > 0) {
      currentPage = 0
      renderResults(searchText, resultItems)
      return
    }

    const ol = document.createElement('ol')
    ol.className = 'search-result-list'
    itemsToDisplay.forEach((result, index) => {
      const itemNumber = enablePagination
        ? currentPage * hitsPerPage + index + 1
        : index + 1
      ol.appendChild(localSearch.buildResultNode(result, itemNumber))
    })
    $results.replaceChildren(ol)

    const displayCount = enablePagination ? currentResultItems.length : resultItems.length
    const statsText = languages.hits_stats.replace(/\$\{hits}/, displayCount)
    const hr = document.createElement('hr')
    const statsDiv = document.createElement('div')
    statsDiv.className = 'search-result-stats'
    statsDiv.textContent = statsText
    $statsItem.replaceChildren(hr, statsDiv)

    if (enablePagination) {
      const nbPages = Math.ceil(currentResultItems.length / hitsPerPage)
      renderPagination(currentPage, nbPages)
    }

    const hasResults = resultItems.length > 0
    toggleResultsVisibility(hasResults)

    window.pjax && window.pjax.refresh($results)
  }

  const createPaginationIconItem = (extraClass, disabled, label, targetPage, iconClass) => {
    const li = document.createElement('li')
    li.className = `ais-Pagination-item ${extraClass}${disabled ? ' ais-Pagination-item--disabled' : ''}`
    const el = document.createElement(disabled ? 'span' : 'a')
    el.className = `ais-Pagination-link${disabled ? ' ais-Pagination-link--disabled' : ''}`
    el.setAttribute('aria-label', label)
    if (!disabled) {
      el.href = '#'
      el.dataset.page = String(targetPage)
    }
    const icon = document.createElement('i')
    icon.className = iconClass
    icon.setAttribute('aria-hidden', 'true')
    el.appendChild(icon)
    li.appendChild(el)
    return li
  }

  const createPaginationNumberItem = (pageIndex, isSelected) => {
    const li = document.createElement('li')
    li.className = `ais-Pagination-item ais-Pagination-item--page${isSelected ? ' ais-Pagination-item--selected' : ''}`
    const el = document.createElement(isSelected ? 'span' : 'a')
    el.className = 'ais-Pagination-link'
    el.setAttribute('aria-label', `Page ${pageIndex + 1}`)
    if (isSelected) {
      el.setAttribute('aria-current', 'page')
    } else {
      el.href = '#'
      el.dataset.page = String(pageIndex)
    }
    el.textContent = String(pageIndex + 1)
    li.appendChild(el)
    return li
  }

  const createPaginationEllipsisItem = () => {
    const li = document.createElement('li')
    li.className = 'ais-Pagination-item ais-Pagination-item--ellipsis'
    const span = document.createElement('span')
    span.className = 'ais-Pagination-link'
    span.textContent = '...'
    li.appendChild(span)
    return li
  }

  // Render pagination
  const renderPagination = (page, nbPages) => {
    if (nbPages <= 1) {
      $pagination.style.display = 'none'
      $paginationList.replaceChildren()
      return
    }

    const isFirstPage = page === 0
    const isLastPage = page === nbPages - 1

    const isMobile = window.innerWidth < 768
    const maxVisiblePages = isMobile ? 3 : 5
    let startPage = Math.max(0, page - Math.floor(maxVisiblePages / 2))
    const endPage = Math.min(nbPages - 1, startPage + maxVisiblePages - 1)

    if (endPage - startPage + 1 < maxVisiblePages) {
      startPage = Math.max(0, endPage - maxVisiblePages + 1)
    }

    const frag = document.createDocumentFragment()
    frag.appendChild(createPaginationIconItem('ais-Pagination-item--previousPage', isFirstPage, 'Previous Page', page - 1, 'fas fa-angle-left'))

    if (nbPages > maxVisiblePages && startPage > 0) {
      frag.appendChild(createPaginationNumberItem(0, false))
      if (startPage > 1) frag.appendChild(createPaginationEllipsisItem())
    }

    for (let i = startPage; i <= endPage; i++) {
      frag.appendChild(createPaginationNumberItem(i, i === page))
    }

    if (nbPages > maxVisiblePages && endPage < nbPages - 1) {
      if (endPage < nbPages - 2) frag.appendChild(createPaginationEllipsisItem())
      frag.appendChild(createPaginationNumberItem(nbPages - 1, false))
    }

    frag.appendChild(createPaginationIconItem('ais-Pagination-item--nextPage', isLastPage, 'Next Page', page + 1, 'fas fa-angle-right'))

    $paginationList.replaceChildren(frag)
    $pagination.style.display = ''
  }

  // Clear search results and stats
  const clearSearchResults = () => {
    $results.replaceChildren()
    $statsItem.replaceChildren()
    toggleResultsVisibility(false)
    if (enablePagination) {
      currentResultItems = []
      currentPage = 0
    }
  }

  // Show no results message
  const showNoResults = searchText => {
    $results.replaceChildren()
    const statsDiv = document.createElement('div')
    statsDiv.className = 'search-result-stats'
    statsDiv.textContent = languages.hits_empty.replace(/\$\{query}/, searchText)
    $statsItem.replaceChildren(statsDiv)
    toggleResultsVisibility(false)
    if (enablePagination) {
      currentResultItems = []
      currentPage = 0
    }
  }

  const inputEventFunction = () => {
    if (!localSearch.isfetched) return
    const searchText = $input.value.trim().toLowerCase()

    if (searchText !== '') $loadingStatus.hidden = false

    const keywords = searchText.split(/[-\s]+/)
    let resultItems = []

    if (searchText.length > 0) {
      resultItems = localSearch.getResultItems(keywords)
    }

    if (keywords.length === 1 && keywords[0] === '') {
      clearSearchResults()
    } else if (resultItems.length === 0) {
      showNoResults(searchText)
    } else {
      resultItems.sort((left, right) => {
        if (left.includedCount !== right.includedCount) {
          return right.includedCount - left.includedCount
        } else if (left.hitCount !== right.hitCount) {
          return right.hitCount - left.hitCount
        }
        return right.id - left.id
      })

      if (enablePagination) {
        currentResultItems = resultItems
        currentPage = 0
      }
      renderResults(searchText, resultItems)
    }

    $loadingStatus.hidden = true
  }

  // Debounced input handler with IME guard
  let searchTimeout
  const debouncedInputEvent = () => {
    if (isComposing) return
    clearTimeout(searchTimeout)
    if (!$input.value.trim()) {
      inputEventFunction()
      return
    }
    searchTimeout = setTimeout(inputEventFunction, 200)
  }

  let loadFlag = false

  const restoreFocusAfterClose = () => {
    const fallbackBtn = document.querySelector('#search-button > .search')
    const target = lastFocusedElement && lastFocusedElement.isConnected ? lastFocusedElement : fallbackBtn
    lastFocusedElement = null
    target?.focus?.({ preventScroll: true })
  }

  const openSearch = () => {
    if (!$searchDialog || $searchDialog.open) return
    lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (typeof $searchDialog.showModal === 'function') {
      $searchDialog.showModal()
    } else {
      $searchDialog.setAttribute('open', '')
    }
    $input?.focus({ preventScroll: true })
    if (!loadFlag) {
      !localSearch.isfetched && localSearch.fetchData()
      $input.addEventListener('compositionstart', () => { isComposing = true })
      $input.addEventListener('compositionend', () => {
        isComposing = false
        debouncedInputEvent()
      })
      $input.addEventListener('input', debouncedInputEvent)
      loadFlag = true
    }
  }

  const closeSearch = () => {
    if (!$searchDialog || !$searchDialog.open) return
    if (typeof $searchDialog.close === 'function') {
      $searchDialog.close()
    } else {
      $searchDialog.removeAttribute('open')
      restoreFocusAfterClose()
    }
  }

  const searchClickFn = () => {
    btf.addEventListenerPjax(document.querySelector('#search-button > .search'), 'click', openSearch)
  }

  const searchFnOnce = () => {
    const closeBtn = document.querySelector('#local-search .search-close-button')
    closeBtn && closeBtn.addEventListener('click', closeSearch)

    if ($searchDialog) {
      $searchDialog.addEventListener('close', restoreFocusAfterClose)
      $searchDialog.addEventListener('click', e => {
        if (e.target !== $searchDialog || e.detail === 0) return
        const rect = $searchDialog.getBoundingClientRect()
        const outside = e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom
        if (outside) closeSearch()
      })
    }

    if (GLOBAL_CONFIG.localSearch.preload) {
      localSearch.fetchData()
    }
    localSearch.highlightSearchWords(document.getElementById('article-container'))

    if (enablePagination) {
      $pagination.addEventListener('click', e => {
        e.preventDefault()
        const link = e.target.closest('a[data-page]')
        if (link) {
          const page = parseInt(link.dataset.page, 10)
          if (!isNaN(page) && currentResultItems.length > 0) {
            currentPage = page
            $results.scrollTop = 0
            renderResults($input.value.trim().toLowerCase(), currentResultItems)
          }
        }
      })
    }

    toggleResultsVisibility(false)
  }

  window.addEventListener('search:loaded', () => {
    const $loadDataItem = document.getElementById('loading-database')
    if ($loadDataItem) {
      if ($loadDataItem.nextElementSibling) $loadDataItem.nextElementSibling.style.display = 'block'
      $loadDataItem.remove()
    }
    inputEventFunction()
  })

  searchClickFn()
  searchFnOnce()

  // pjax
  window.addEventListener('pjax:complete', () => {
    $searchDialog && $searchDialog.open && closeSearch()
    localSearch.highlightSearchWords(document.getElementById('article-container'))
    searchClickFn()
  })
})
