// The Gnosis window. It shows what the core reports and never trusts model text as HTML: everything is
// put on the page with textContent.
(() => {
  const $ = (id) => document.getElementById(id)
  const log = $('log'), input = $('input'), send = $('send'), orb = $('orb'), statusEl = $('status')
  let api = null
  let current = null            // the ask id being answered
  const bubbles = new Map()     // ask id → the answer's bubble
  let ready = null              // the model check result
  let diagTimer = null

  const setState = (s) => { orb.dataset.state = s }
  const scroll = () => { log.scrollTop = log.scrollHeight }

  function setStatus(text, bad = false) {
    statusEl.textContent = text
    statusEl.classList.toggle('bad', bad)
  }

  function idle() {
    current = null
    send.textContent = 'Send'
    send.classList.remove('stop')
    setState(ready && !ready.ok ? 'error' : 'idle')
  }

  function bubble(role, text, meta) {
    log.querySelector('.empty')?.remove()
    const el = document.createElement('div')
    el.className = `msg ${role}`
    el.textContent = text
    if (meta) addMeta(el, meta)
    log.appendChild(el)
    scroll()
    return el
  }

  function addMeta(el, text) {
    const m = document.createElement('span')
    m.className = 'meta'
    m.textContent = text
    el.appendChild(m)
  }

  function note(text, bad = false) {
    const el = document.createElement('div')
    el.className = 'note' + (bad ? ' bad' : '')
    el.textContent = text
    log.appendChild(el)
    scroll()
  }

  function showEmpty() {
    log.innerHTML = ''
    const el = document.createElement('div')
    el.className = 'empty'
    el.textContent = 'Ask me anything.'
    log.appendChild(el)
  }

  async function loadHistory() {
    const items = await api.history()
    bubbles.clear()
    if (!items.length) return showEmpty()
    log.innerHTML = ''
    for (const m of items) bubble(m.role, m.content, m.interrupted ? 'stopped' : '')
  }

  const secs = (ms) => (ms / 1000).toFixed(1) + ' s'

  // Events from the core (see gnosis/core.py for the list)
  window.gnosisReceive = (ev) => {
    switch (ev.type) {
      case 'ready':
        ready = ev
        setStatus(ev.ok ? `${ev.model.split('/').pop()} · ready` : ev.message, !ev.ok)
        if (!current) setState(ev.ok ? 'idle' : 'error')
        break
      case 'started': {
        current = ev.ask
        const b = bubble('assistant', '')
        b.classList.add('pending')
        bubbles.set(ev.ask, b)
        setState('thinking')
        break
      }
      case 'text': {
        const b = bubbles.get(ev.ask)
        if (!b || ev.ask !== current) return   // a stopped answer's late text is dropped
        b.textContent += ev.delta
        setState('answering')
        scroll()
        break
      }
      case 'done': {
        const b = bubbles.get(ev.ask)
        if (b) {
          b.classList.remove('pending')
          b.textContent = ev.text
          const t = ev.timings
          addMeta(b, `first words ${secs(t.first_text_ms)} · done ${secs(t.total_ms)}`)
        }
        if (ev.ask === current) idle()
        break
      }
      case 'interrupted': {
        const b = bubbles.get(ev.ask)
        if (b) {
          b.classList.remove('pending')
          if (!ev.text) b.remove(); else addMeta(b, 'stopped')
        }
        if (ev.ask === current) idle()
        break
      }
      case 'error': {
        bubbles.get(ev.ask)?.remove()
        note(ev.message, true)
        if (ev.ask === current) { idle(); setState('error') }
        break
      }
    }
  }
  window.gnosisReload = () => loadHistory()

  async function ask() {
    const text = input.value.trim()
    if (!text) return
    input.value = ''
    autosize()
    bubble('user', text)
    send.textContent = 'Stop'
    send.classList.add('stop')
    const r = await api.ask(text)
    if (r.error) { note(r.error, true); idle() }
  }

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault()
    if (current && !input.value.trim()) api.interrupt()
    else ask()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit() }
  })
  function autosize() { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px' }
  input.addEventListener('input', autosize)

  $('newChat').addEventListener('click', async () => {
    await api.new_chat()
    idle()
    showEmpty()
  })

  // Diagnostics: press D (outside the text box) or the D button; Esc closes
  const diag = $('diag')
  async function renderDiag() {
    const s = await api.status()
    const rows = await api.diagnostics()
    const dl = $('diagStatus')
    dl.innerHTML = ''
    const add = (k, v) => {
      const dt = document.createElement('dt'); dt.textContent = k
      const dd = document.createElement('dd'); dd.textContent = v
      dl.append(dt, dd)
    }
    add('Model', s.model)
    add('Endpoint', s.endpoint)
    add('API key', s.key_set ? `${s.key_env} is set` : `${s.key_env} is NOT set`)
    add('Model check', s.check ? `${s.check.ok ? 'OK' : 'PROBLEM'}: ${s.check.message} (${s.check.ms} ms)` : 'running…')
    const t = s.last_timings
    add('Last answer', t.total_ms ? `first words ${t.first_text_ms} ms · first sentence ${t.first_sentence_ms} ms · done ${t.total_ms} ms` : '—')
    add('Data folder', s.data_dir)
    const body = $('diagRows')
    body.innerHTML = ''
    for (const r of rows.slice().reverse()) {
      const tr = document.createElement('tr')
      if (r.kind === 'error' || r.kind === 'dropped' || (r.kind === 'model_check' && !r.ok)) tr.className = 'bad'
      const { t: time, kind, ...rest } = r
      for (const v of [time.slice(11, 23), kind, JSON.stringify(rest)]) {
        const td = document.createElement('td'); td.textContent = v; tr.appendChild(td)
      }
      body.appendChild(tr)
    }
  }
  function openDiag() { diag.hidden = false; renderDiag(); diagTimer = setInterval(renderDiag, 1000) }
  function closeDiag() { diag.hidden = true; clearInterval(diagTimer) }
  $('diagBtn').addEventListener('click', openDiag)
  $('diagClose').addEventListener('click', closeDiag)
  $('recheck').addEventListener('click', async () => { setStatus('Checking the model…'); await api.recheck() })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !diag.hidden) closeDiag()
    else if ((e.key === 'd' || e.key === 'D') && document.activeElement !== input && diag.hidden) openDiag()
  })

  window.addEventListener('pywebviewready', async () => {
    api = window.pywebview.api
    const s = await api.status()
    $('name').textContent = s.name
    document.title = s.name
    input.placeholder = `Ask ${s.name}…`
    if (s.check) window.gnosisReceive({ type: 'ready', ...s.check, model: s.model })
    await loadHistory()
    input.focus()
  })
})()
