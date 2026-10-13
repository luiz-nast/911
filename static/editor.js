// editor de PDF: o PDF.js desenha as páginas; por cima ficam os campos do formulário (inputs de verdade)
// e o que você acrescenta (texto, assinatura, corretivo). Ao salvar, o pdf-lib grava tudo no arquivo.
import * as pdfjs from "/static/vendor/pdfjs/pdf.min.mjs"

const V = "/static/vendor/pdfjs/"
pdfjs.GlobalWorkerOptions.workerSrc = V + "pdf.worker.min.mjs"

const svg = (d, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const I = {
  select: svg('<path d="M5 3l6 16 2.5-6.5L20 10z"/>'),
  text: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  sign: svg('<path d="M3 17c3 0 4-8 7-8s1 7 4 7 3-4 5-4M3 21h18"/>'),
  cover: svg('<rect x="4" y="6" width="16" height="12" rx="1"/><path d="M8 10h8M8 14h5"/>'),
  move: svg('<path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3m-3 15-3-3m3 3 3-3M3 12l3-3m-3 3 3 3m15-3-3-3m3 3-3 3"/>', 14),
  del: svg('<path d="M6 6l12 12M18 6L6 18"/>', 14),
  size: svg('<path d="M20 14v6h-6M20 20l-8-8"/>', 14),
}
// Helvetica com linha de 1.2: o topo da caixa fica a 0.947 × tamanho acima da linha de base
const BASELINE = 0.947

let pdfLib
function loadPdfLib() {
  return pdfLib ??= new Promise((ok, no) => {
    const s = Object.assign(document.createElement("script"), { src: "/static/vendor/pdf-lib.min.js", onload: () => ok(window.PDFLib), onerror: no })
    document.head.append(s)
  })
}

// alive(): o visualizador ainda está neste arquivo? (a pessoa pode ter trocado enquanto carregava)
export async function openPdf(body, tools, { url, save, toast, alive }) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
  const task = pdfjs.getDocument({ data: bytes.slice(), standardFontDataUrl: V + "standard_fonts/", wasmUrl: V + "wasm/", isEvalSupported: false })
  let doc
  try {
    doc = await task.promise
  } catch (err) {
    if (!alive()) return null
    const locked = err?.name == "PasswordException"
    body.className = ""
    body.innerHTML = `<div class="fallback"><p>${locked ? "This PDF is password-protected." : "Couldn't open this PDF."}</p>
      <a class="go" href="${url}?dl=1" download>Download</a></div>`
    return { dirty: () => false, destroy() {} }
  }
  if (!alive()) { task.destroy(); return null }

  const pages = []
  const changed = new Map()  // campo do formulário -> valor novo
  const items = []           // texto, assinatura e corretivo acrescentados
  let tool = "select", selected = null, textSize = 12

  // ---------- barra de ferramentas ----------
  tools.innerHTML = `<div class="tbar">
    <button data-tool="select" class="on" title="Select and move" aria-label="Select">${I.select}<span>Select</span></button>
    <button data-tool="text" title="Click on the page to type" aria-label="Text">${I.text}<span>Text</span></button>
    <button data-tool="sign" title="Draw your signature" aria-label="Sign">${I.sign}<span>Sign</span></button>
    <button data-tool="cover" title="Drag to cover something with white" aria-label="White-out">${I.cover}<span>White-out</span></button>
    <label class="tsize"><span class="sr">Text size</span><select id="tsize">${[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 32].map(n => `<option value="${n}" ${n == 12 ? "selected" : ""}>${n} pt</option>`).join("")}</select></label>
    <span class="tsp"></span>
    <button class="go" id="tsave" disabled>Save</button>
  </div>`
  tools.hidden = false
  const bar = tools.firstElementChild
  // só limpa a barra se ela ainda for deste editor (outro PDF pode já ter montado a dele)
  const dropBar = () => { if (bar.isConnected) { tools.innerHTML = ""; tools.hidden = true } }
  const saveBtn = tools.querySelector("#tsave"), sizeSel = tools.querySelector("#tsize")
  const isDirty = () => changed.size > 0 || items.some(it => it.type != "text" || it.text.trim())
  const touch = () => { saveBtn.disabled = !isDirty() }

  function setTool(t) {
    tool = t
    tools.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool == t))
    for (const P of pages) {
      P.ov.classList.toggle("cross", t == "cover")
      P.ov.classList.toggle("textmode", t == "text")
    }
    if (t == "sign") signaturePad()
  }
  bar.addEventListener("click", ev => {
    const b = ev.target.closest("[data-tool]")
    if (b) setTool(b.dataset.tool)
  })
  sizeSel.onchange = () => {
    textSize = +sizeSel.value
    if (selected?.type == "text") { selected.size = textSize; place(selected) }
  }
  saveBtn.onclick = async () => {
    saveBtn.disabled = true
    saveBtn.textContent = "Saving…"
    try {
      await save(await build())
    } catch (err) {
      console.error(err)
      const msg = /encrypted/i.test(err?.message) ? "This PDF is encrypted and can't be edited." : "Couldn't save: " + (err?.message || err)
      toast(msg, { err: true })
      saveBtn.textContent = "Save"
      touch()
    }
  }

  // ---------- páginas ----------
  const wrap = document.createElement("div")
  wrap.className = "pages"
  body.append(wrap)
  const width = Math.min(body.clientWidth - 32, 960)
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    if (!alive()) { dropBar(); task.destroy(); return null }
    const unit = page.getViewport({ scale: 1 })
    const scale = width / unit.width
    const vp = page.getViewport({ scale })
    const el = document.createElement("div")
    el.className = "pg"
    el.style.width = vp.width + "px"
    el.style.height = vp.height + "px"
    el.innerHTML = `<canvas></canvas><div class="ov"></div>`
    wrap.append(el)
    const P = { n, page, unit, vp, scale, el, ov: el.querySelector(".ov"), canvas: el.querySelector("canvas") }
    pages.push(P)
    P.ov.addEventListener("pointerdown", ev => pageDown(P, ev))
  }

  // desenha só as páginas perto da tela e solta as que ficaram longe (PDF grande no celular)
  const io = new IntersectionObserver(list => {
    for (const x of list) {
      const P = pages.find(p => p.el == x.target)
      if (x.isIntersecting) draw(P)
      else if (P.drawn) { P.task?.cancel(); P.canvas.width = P.canvas.height = 0; P.drawn = false }
    }
  }, { root: body, rootMargin: "1200px 0px" })
  pages.forEach(P => io.observe(P.el))

  async function draw(P) {
    if (P.drawn) return
    P.drawn = true
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const v = P.page.getViewport({ scale: P.scale * dpr })
    P.canvas.width = v.width
    P.canvas.height = v.height
    P.canvas.style.width = P.vp.width + "px"
    P.canvas.style.height = P.vp.height + "px"
    // ENABLE_FORMS: os campos não vão pro canvas, porque viram inputs por cima
    P.task = P.page.render({ canvas: P.canvas, viewport: v, annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS })
    try { await P.task.promise } catch {}
    fields(P)
  }

  // ---------- campos do formulário ----------
  async function fields(P) {
    if (P.fields) return
    P.fields = true
    for (const a of await P.page.getAnnotations({ intent: "display" })) {
      if (a.subtype != "Widget" || !a.fieldName || a.hidden) continue
      const [x1, y1] = P.vp.convertToViewportPoint(a.rect[0], a.rect[1])
      const [x2, y2] = P.vp.convertToViewportPoint(a.rect[2], a.rect[3])
      const box = { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) }
      let el
      if (a.fieldType == "Tx") {
        el = document.createElement(a.multiLine ? "textarea" : "input")
        el.value = changed.get(a.fieldName) ?? a.fieldValue ?? ""
        if (a.maxLen) el.maxLength = a.maxLen
        const fs = a.defaultAppearanceData?.fontSize
        el.style.fontSize = (fs ? fs * P.scale : Math.min(box.height * 0.7, 12 * P.scale)) + "px"
        el.addEventListener("input", () => {
          changed.set(a.fieldName, el.value)
          // o mesmo campo pode aparecer em mais de um lugar
          body.querySelectorAll(`.fld[data-f="${CSS.escape(a.fieldName)}"]`).forEach(o => o != el && (o.value = el.value))
          touch()
        })
      } else if (a.fieldType == "Btn" && a.checkBox) {
        el = Object.assign(document.createElement("input"), { type: "checkbox" })
        el.checked = changed.has(a.fieldName) ? changed.get(a.fieldName) : !!a.fieldValue && a.fieldValue != "Off"
        el.addEventListener("change", () => { changed.set(a.fieldName, el.checked); touch() })
      } else if (a.fieldType == "Btn" && a.radioButton) {
        el = Object.assign(document.createElement("input"), { type: "radio", name: "r:" + a.fieldName, value: a.buttonValue })
        el.checked = (changed.get(a.fieldName) ?? a.fieldValue) == a.buttonValue
        el.addEventListener("change", () => { if (el.checked) { changed.set(a.fieldName, el.value); touch() } })
      } else if (a.fieldType == "Ch" && a.options?.length) {
        el = document.createElement("select")
        el.innerHTML = a.options.map(o => `<option></option>`).join("")
        a.options.forEach((o, i) => { el.options[i].value = o.displayValue ?? o.exportValue; el.options[i].text = o.displayValue ?? o.exportValue })
        const cur = [].concat(a.fieldValue ?? [])[0]
        const match = a.options.find(o => o.exportValue == cur || o.displayValue == cur)
        el.value = changed.get(a.fieldName) ?? (match ? match.displayValue ?? match.exportValue : "")
        el.style.fontSize = Math.min(box.height * 0.7, 12 * P.scale) + "px"
        el.addEventListener("change", () => { changed.set(a.fieldName, el.value); touch() })
      } else continue
      el.className = "fld"
      el.dataset.f = a.fieldName
      el.disabled = !!a.readOnly
      el.title = a.alternativeText || a.fieldName
      el.setAttribute("aria-label", a.alternativeText || a.fieldName)
      for (const k in box) el.style[k] = box[k] + "px"
      P.ov.append(el)
    }
  }

  // ---------- o que você acrescenta ----------
  // posições em pontos do PDF (escala 1, origem no canto de cima), pra não depender do zoom
  function place(it) {
    const s = pages[it.n - 1].scale
    it.el.style.left = it.x * s + "px"
    it.el.style.top = it.y * s + "px"
    if (it.type == "text") it.tx.style.fontSize = it.size * s + "px"
    else { it.el.style.width = it.w * s + "px"; it.el.style.height = it.h * s + "px" }
  }

  function add(it) {
    const P = pages[it.n - 1]
    it.el = document.createElement("div")
    it.el.className = "it " + it.type
    it.el.innerHTML = (it.type == "text" ? `<div class="tx" spellcheck="false"></div>` : it.type == "sign" ? `<img alt="Signature" src="${it.png}">` : "")
      + `<button class="h h-move" aria-label="Move">${I.move}</button><button class="h h-del" aria-label="Remove">${I.del}</button>`
      + (it.type == "text" ? "" : `<span class="h h-size" aria-hidden="true">${I.size}</span>`)
    if (it.type == "text") {
      it.tx = it.el.querySelector(".tx")
      try { it.tx.contentEditable = "plaintext-only" } catch { it.tx.contentEditable = "true" }
      it.tx.textContent = it.text
      it.tx.addEventListener("input", () => { it.text = it.tx.innerText; touch() })
      it.tx.addEventListener("focus", () => select(it))
      it.tx.addEventListener("blur", () => { if (!it.text.trim()) setTimeout(() => !it.tx.matches(":focus") && remove(it), 150) })
    }
    it.el.addEventListener("pointerdown", ev => itemDown(it, ev))
    P.ov.append(it.el)
    items.push(it)
    place(it)
    select(it)
    touch()
    return it
  }

  function remove(it) {
    it.el.remove()
    items.splice(items.indexOf(it), 1)
    if (selected == it) selected = null
    touch()
  }

  function select(it) {
    if (selected && selected != it) selected.el.classList.remove("sel")
    selected = it
    if (!it) return
    it.el.classList.add("sel")
    if (it.type == "text") { textSize = it.size; sizeSel.value = it.size }
  }

  // arrastar pela alça (texto) ou pelo corpo (assinatura/corretivo); a alça do canto muda o tamanho
  function itemDown(it, ev) {
    const h = ev.target.closest(".h")
    if (it.type == "cover" && tool != "select" && !h) return  // escrever (ou cobrir) por cima do corretivo: o clique vai pra página
    if (h?.classList.contains("h-del")) { ev.preventDefault(); remove(it); return }
    select(it)
    const resize = h?.classList.contains("h-size")
    if (it.type == "text" && !h) return  // clique no texto: só edita
    ev.preventDefault()
    ev.stopPropagation()
    const s = pages[it.n - 1].scale, x0 = ev.clientX, y0 = ev.clientY, start = { ...it }
    const ratio = it.type == "sign" ? it.h / it.w : 0
    const move = e => {
      const dx = (e.clientX - x0) / s, dy = (e.clientY - y0) / s
      if (resize) {
        it.w = Math.max(8, start.w + dx)
        it.h = ratio ? it.w * ratio : Math.max(4, start.h + dy)
      } else { it.x = start.x + dx; it.y = start.y + dy }
      place(it)
    }
    const up = () => { removeEventListener("pointermove", move); removeEventListener("pointerup", up); touch() }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up)
  }

  function pageDown(P, ev) {
    const onCover = tool != "select" && ev.target.closest(".it.cover") && !ev.target.closest(".h")
    if (ev.target != P.ov && !onCover) return  // clique num campo ou num item
    if (document.activeElement?.matches(".fld, .tx")) document.activeElement.blur()
    const r = P.ov.getBoundingClientRect()
    const x = (ev.clientX - r.left) / P.scale, y = (ev.clientY - r.top) / P.scale
    if (tool == "text") {
      ev.preventDefault()
      const it = add({ type: "text", n: P.n, x, y: y - textSize * 0.6, size: textSize, text: "" })
      setTool("select")
      setTimeout(() => it.tx.focus())
    } else if (tool == "cover") {
      ev.preventDefault()
      const it = add({ type: "cover", n: P.n, x, y, w: 1, h: 1 })
      const move = e => {
        const cx = (e.clientX - r.left) / P.scale, cy = (e.clientY - r.top) / P.scale
        it.x = Math.min(x, cx); it.y = Math.min(y, cy); it.w = Math.abs(cx - x); it.h = Math.abs(cy - y)
        place(it)
      }
      const up = () => {
        removeEventListener("pointermove", move)
        removeEventListener("pointerup", up)
        if (it.w < 3 || it.h < 3) remove(it)
        setTool("select")
      }
      addEventListener("pointermove", move)
      addEventListener("pointerup", up)
    } else {
      select(null)
      document.activeElement?.blur()
    }
  }

  function keydown(ev) {
    if (!selected || ev.target.closest?.("[contenteditable], input, textarea, select")) return
    if (ev.key == "Delete" || ev.key == "Backspace") { ev.preventDefault(); remove(selected) }
  }
  addEventListener("keydown", keydown)

  // ---------- assinatura ----------
  function signaturePad() {
    const saved = (() => { try { return localStorage.getItem("911.sign") } catch {} })()
    const wrapEl = document.createElement("div")
    wrapEl.className = "padwrap"
    wrapEl.innerHTML = `<div class="pad" role="dialog" aria-modal="true" aria-label="Signature">
      <div class="phead"><h2>Signature</h2><button class="x" data-a="close" aria-label="Close">${I.del}</button></div>
      <canvas></canvas>
      <div class="prow"><button class="ghost" data-a="clear">Clear</button>${saved ? `<button class="ghost" data-a="saved">Use saved</button>` : ""}<span class="tsp"></span><button class="go" data-a="use">Use</button></div>
    </div>`
    document.body.append(wrapEl)
    const c = wrapEl.querySelector("canvas"), ctx = c.getContext("2d")
    const dpr = devicePixelRatio || 1
    c.width = c.clientWidth * dpr
    c.height = c.clientHeight * dpr
    ctx.scale(dpr, dpr)
    ctx.lineWidth = 2.6
    ctx.lineCap = ctx.lineJoin = "round"
    ctx.strokeStyle = "#111"
    let drawing = false, last, inked = false
    const pt = e => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
    c.onpointerdown = e => { drawing = true; last = pt(e); c.setPointerCapture(e.pointerId) }
    c.onpointermove = e => {
      if (!drawing) return
      const p = pt(e), mid = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2]
      ctx.beginPath(); ctx.moveTo(...last); ctx.quadraticCurveTo(last[0], last[1], ...mid); ctx.lineTo(...p); ctx.stroke()
      last = p
      inked = true
    }
    c.onpointerup = () => { drawing = false }
    const close = () => { wrapEl.remove(); removeEventListener("keydown", esc, true); setTool("select") }
    const esc = e => { if (e.key == "Escape") { e.stopPropagation(); close() } }
    addEventListener("keydown", esc, true)
    const use = png => {
      const img = new Image()
      img.onload = () => {
        // centraliza na página que está mais à vista
        const view = body.getBoundingClientRect()
        const P = pages.reduce((best, p) => {
          const r = p.el.getBoundingClientRect(), vis = Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top)
          return vis > best.vis ? { p, vis, r } : best
        }, { vis: -1 }).p
        const r = P.el.getBoundingClientRect()
        const w = Math.min(180, P.unit.width * 0.4), h = w * img.height / img.width
        const cy = ((Math.max(r.top, view.top) + Math.min(r.bottom, view.bottom)) / 2 - r.top) / P.scale
        add({ type: "sign", n: P.n, png, x: (P.unit.width - w) / 2, y: Math.max(0, cy - h / 2), w, h })
        close()
      }
      img.src = png
    }
    wrapEl.addEventListener("click", ev => {
      const a = ev.target.closest("[data-a]")?.dataset.a
      if (a == "close") close()
      if (a == "clear") { ctx.clearRect(0, 0, c.width, c.height); inked = false }
      if (a == "saved") use(saved)
      if (a == "use" && inked) {
        const png = trim(c)
        try { localStorage.setItem("911.sign", png) } catch {}
        use(png)
      }
    })
  }

  // ---------- salvar ----------
  async function build() {
    const { PDFDocument, StandardFonts, rgb, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = await loadPdfLib()
    const pdf = await PDFDocument.load(bytes)
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    // a Helvetica padrão não tem todo caractere (emoji, setas...): o que faltar vira "?"
    const ok = new Set(font.getCharacterSet())
    const clean = s => [...s].map(ch => ch == "\n" || ok.has(ch.codePointAt(0)) ? ch : "?").join("")
    if (changed.size) {
      const form = pdf.getForm()
      for (const [name, v] of changed) {
        const f = form.getFieldMaybe(name)
        if (f instanceof PDFTextField) f.setText(clean(v) || undefined)
        else if (f instanceof PDFCheckBox) v ? f.check() : f.uncheck()
        else if (f instanceof PDFRadioGroup) f.select(v)
        else if (f instanceof PDFDropdown || f instanceof PDFOptionList) f.select(v)
      }
      form.updateFieldAppearances(font)
    }
    const out = pdf.getPages()
    // corretivo primeiro, pra texto e assinatura poderem ficar por cima dele
    for (const it of [...items].sort((a, b) => (a.type != "cover") - (b.type != "cover"))) {
      const P = pages[it.n - 1], pg = out[it.n - 1]
      const [ax, ay] = P.unit.convertToPdfPoint(it.x, it.y)
      if (it.type == "text") {
        if (it.text.trim()) pg.drawText(clean(it.text.replace(/\n$/, "")), { x: ax, y: ay - it.size * BASELINE, size: it.size, font, lineHeight: it.size * 1.2, color: rgb(0, 0, 0) })
        continue
      }
      const [bx, by] = P.unit.convertToPdfPoint(it.x + it.w, it.y + it.h)
      const box = { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }
      if (it.type == "cover") pg.drawRectangle({ ...box, color: rgb(1, 1, 1) })
      else pg.drawImage(await pdf.embedPng(it.png), box)
    }
    return pdf.save()
  }

  return {
    dirty: isDirty,
    destroy() {
      io.disconnect()
      removeEventListener("keydown", keydown)
      document.querySelector(".padwrap")?.remove()
      dropBar()
      task.destroy()
    },
  }
}

// recorta a assinatura no tamanho do traço, com fundo transparente
function trim(c) {
  const ctx = c.getContext("2d"), { width, height } = c
  const data = ctx.getImageData(0, 0, width, height).data
  let x0 = width, y0 = height, x1 = 0, y1 = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  }
  const pad = 8, out = document.createElement("canvas")
  out.width = x1 - x0 + pad * 2
  out.height = y1 - y0 + pad * 2
  out.getContext("2d").drawImage(c, x0 - pad, y0 - pad, out.width, out.height, 0, 0, out.width, out.height)
  return out.toDataURL("image/png")
}
