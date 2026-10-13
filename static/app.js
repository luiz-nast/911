const $ = s => document.querySelector(s)
const $$ = s => [...document.querySelectorAll(s)]
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
const enc = p => p.split("/").map(encodeURIComponent).join("/")
const base = p => p.split("/").pop()
const parent = p => p.split("/").slice(0, -1).join("/")
// minúsculo e sem acento: "certidao" acha "Certidão"
const fold = s => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

// ---------- ícones (traço, como no design) ----------
const svg = (d, size = 20, stroke = 2.2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const I = {
  dl: svg('<path d="M12 4v12M6 10l6 6 6-6M5 20h14"/>'),
  dlThin: svg('<path d="M12 5v10M8 11l4 4 4-4M6 19h12"/>', 18, 1.8),
  play: '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 18),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  next: svg('<path d="M9 5l7 7-7 7"/>'),
  pin: svg('<path d="M12 17v5M9 3h6l-1 6 3 4H7l3-4z"/>', 20, 2),
  shorts: svg('<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M10.5 9.5v5l4-2.5z"/>', 20, 2),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', 20, 2),
  upload: svg('<path d="M12 16V4M6 10l6-6 6 6M5 20h14"/>', 26),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>', 20, 2),
  trash: svg('<path d="M4 7h16M10 11v6m4-6v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>', 20, 2),
  restore: svg('<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v5h5"/>', 18, 2),
}
$("#vclose").innerHTML = I.back
$("#vdl").innerHTML = I.dl
$("#vren").innerHTML = I.pencil
$("#vdel").innerHTML = I.trash
$("#vprev").innerHTML = I.back
$("#vnext").innerHTML = I.next
$$("[data-close].x").forEach(b => b.innerHTML = I.close)
if (/Mac|iPhone|iPad/.test(navigator.platform)) $("#kbd").textContent = "⌘ F"

// ---------- tipos ----------
const KINDS = {
  image: "jpg jpeg png gif webp avif bmp svg heic",
  video: "mp4 webm mov m4v mkv ogv",
  audio: "mp3 wav ogg m4a flac aac opus",
  pdf: "pdf",
  text: "txt md csv json log xml yml yaml ini conf",
}
const KIND = {}
for (const k in KINDS) for (const x of KINDS[k].split(" ")) KIND[x] = k
const ext = n => n.includes(".") ? n.split(".").pop().toLowerCase() : ""
const kind = e => KIND[ext(e.name)] || "other"
const label = e => esc(ext(e.name).slice(0, 4).toUpperCase() || "FILE")
const title = e => e.name.includes(".") ? e.name.slice(0, e.name.lastIndexOf(".")) : e.name
const raw = e => "/raw/" + enc(e.path)
const thumbUrl = e => ext(e.name) == "svg" ? raw(e) : `/thumb/${enc(e.path)}?v=${e.mtime}-${e.size}`
const fmtSize = n => {
  let i = 0
  while (n >= 1024 && i < 4) { n /= 1024; i++ }
  return n.toLocaleString("pt-BR", { maximumFractionDigits: i ? 1 : 0 }) + " " + ["B", "KB", "MB", "GB", "TB"][i]
}
const fmtDate = t => new Date(t * 1000).toLocaleDateString("pt-BR")

// ---------- api ----------
async function api(url, opt) {
  const r = await fetch(url, opt)
  if (r.status == 401) { location = "/login"; throw new Error("login") }
  if (!r.ok) {
    let msg = await r.text()
    try { msg = JSON.parse(msg).detail } catch {}
    toast(msg || "Error " + r.status, { err: true })
    throw new Error(msg)
  }
  return r
}
const get = url => api(url).then(r => r.json())
const post = (url, body) => api(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json())

// ---------- estado ----------
const DIR = { energy: "Energy", docs: "Documents" }
let tab = location.hash == "#docs" ? "docs" : "energy"
const items = { energy: [], docs: [] }
let shown = []  // o que está na tela, já filtrado e ordenado

async function load(t = tab) {
  items[t] = (await get("/api/list?path=" + DIR[t])).filter(e => !e.dir)
  if (t == tab) render()
}

async function loadStats() {
  const s = await get("/api/stats")
  $("#stats").textContent = `${fmtSize(s.used)} · ${fmtSize(s.free)} free`
  $("#trashBtn").textContent = s.trash ? `Trash (${s.trash})` : "Trash"
}

function setTab(t) {
  tab = t
  history.replaceState(null, "", "#" + t)
  render()
  load()
}
addEventListener("hashchange", () => setTab(location.hash == "#docs" ? "docs" : "energy"))
$$(".seg button").forEach(b => b.onclick = () => setTab(b.dataset.tab))

// ---------- tela ----------
const io = new IntersectionObserver(list => {
  for (const x of list) if (x.isIntersecting) {
    const v = x.target
    io.unobserve(v)
    v.onerror = () => v.remove()
    v.preload = "metadata"
    v.src = v.dataset.src
  }
}, { rootMargin: "400px" })

function clip(e, i) {
  const k = kind(e)
  let media = `<span class="label">${label(e)}</span>`
  if (k == "video") media = `<video muted playsinline preload="none" data-src="${raw(e)}#t=0.5"></video><button class="playbtn" aria-label="Play ${esc(title(e))}">${I.play}</button>`
  if (k == "image") media += `<img loading="lazy" alt="" src="${thumbUrl(e)}" onerror="this.remove()">`
  return `<article class="clip" data-i="${i}">
    <div class="media" data-media>${media}</div>
    <div class="cinfo">
      <button class="ctext" data-open><span class="ctitle">${esc(title(e))}</span><span class="csrc">${esc(e.src || "Uploaded")}</span></button>
      <a class="dl" href="${raw(e)}?dl=1" download aria-label="Download ${esc(e.name)}">${I.dlThin}</a>
    </div>
  </article>`
}

function doc(e, i) {
  const img = kind(e) == "image" ? `<img loading="lazy" alt="" src="${thumbUrl(e)}" onerror="this.remove()">` : ""
  return `<div class="doc" data-i="${i}">
    <button class="dopen" data-open><span class="tile">${label(e)}${img}</span><span class="dname">${esc(e.name)}</span></button>
    <a class="dl" href="${raw(e)}?dl=1" download aria-label="Download ${esc(e.name)}">${I.dl}</a>
  </div>`
}

function render() {
  io.disconnect()
  $$(".seg button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab == tab))
  document.title = (tab == "docs" ? "Documents" : "Energy") + " · 911"
  const q = fold($("#q").value.trim())
  shown = items[tab].filter(e => !q || fold(e.name).includes(q))
  // Energy é um feed (o que chegou por último em cima); Documents fica em ordem alfabética
  shown.sort(tab == "energy" ? (a, b) => b.added - a.added : (a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }))
  drawJobs()
  if (!shown.length) {
    $("#list").innerHTML = q
      ? `<div class="empty"><b>Nothing found</b>No file name matches “${esc($("#q").value.trim())}”.</div>`
      : tab == "energy"
        ? `<div class="empty"><b>Nothing here yet</b>Use + to save a Pinterest pin, a YouTube Short or a photo/video from this device.</div>`
        : `<div class="empty"><b>No documents yet</b>Use + to upload a PDF or a photo of a document.</div>`
    return
  }
  $("#list").innerHTML = tab == "energy" ? `<div class="feed">${shown.map(clip).join("")}</div>` : `<div class="docs">${shown.map(doc).join("")}</div>`
  $$("video[data-src]").forEach(v => io.observe(v))
}

$("#q").oninput = render
$("#list").addEventListener("click", ev => {
  const card = ev.target.closest("[data-i]")
  if (!card || ev.target.closest(".dl")) return
  const e = shown[card.dataset.i]
  const media = ev.target.closest("[data-media]")
  if (media && kind(e) == "video") {
    // vídeo toca ali mesmo, no feed
    const v = media.querySelector("video")
    if (!v || media.classList.contains("playing")) return
    if (!v.src) v.src = v.dataset.src
    media.classList.add("playing")
    v.controls = true
    v.muted = false
    v.play()
    return
  }
  if (media || ev.target.closest("[data-open]")) openViewer(e)
})
// um vídeo de cada vez
document.addEventListener("play", ev => $$("video").forEach(v => v != ev.target && v.pause()), true)

// ---------- downloads por link ----------
let jobs = [], jobTimer
const seen = new Set()

async function loadJobs() {
  clearTimeout(jobTimer)
  jobs = await get("/api/jobs")
  let fresh = false
  for (const j of jobs.filter(j => j.state == "done")) {
    post("/api/jobs/dismiss", { id: j.id })
    if (!seen.has(j.id)) toast(j.files.length > 1 ? `${j.files.length} files saved from ${j.source}` : `Saved from ${j.source}`)
    seen.add(j.id)
    fresh = true
  }
  jobs = jobs.filter(j => j.state != "done")
  if (fresh) { load("energy"); loadStats() }
  drawJobs()
  if (jobs.some(j => j.state == "queued" || j.state == "running")) jobTimer = setTimeout(loadJobs, 1000)
}

function drawJobs() {
  $("#jobs").innerHTML = tab != "energy" ? "" : jobs.map(j => {
    const icon = j.source == "Pinterest" ? I.pin : I.shorts
    if (j.state == "error") return `<div class="job err"><span class="jicon">${icon}</span>
      <span class="jtext"><b>Couldn't save from ${esc(j.source)}</b><span>${esc(j.msg)}</span></span>
      <button class="jx" data-dismiss="${j.id}" aria-label="Dismiss">${I.close}</button></div>`
    const pct = Math.round(j.progress * 100)
    // o gallery-dl (Pinterest) não informa progresso: a barra fica correndo
    return `<div class="job"><span class="jicon">${icon}</span>
      <span class="jtext"><b>${j.state == "queued" ? "Waiting…" : `Saving from ${esc(j.source)}…`}</b><span>${esc(j.url)}</span></span>
      ${pct ? `<span class="jpct">${pct}%</span>` : ""}<i class="jbar ${pct ? "" : "spin"}" style="width:${pct}%"></i></div>`
  }).join("")
}
$("#jobs").addEventListener("click", async ev => {
  const b = ev.target.closest("[data-dismiss]")
  if (!b) return
  await post("/api/jobs/dismiss", { id: b.dataset.dismiss })
  jobs = jobs.filter(j => j.id != b.dataset.dismiss)
  drawJobs()
})

const sourceOf = url => {
  try {
    const h = new URL(url).hostname
    if (/(^|\.)pinterest\.|^pin\.it$/.test(h)) return "pin"
    if (/(^|\.)youtube\.com$|^youtu\.be$/.test(h)) return "shorts"
  } catch {}
}

// ---------- painel de upload ----------
function openSheet(heading, html) {
  $("#sheetTitle").textContent = heading
  $("#sheetBody").innerHTML = html
  $("#sheet").hidden = false
  document.body.classList.add("noscroll")
}
function closeSheet() {
  $("#sheet").hidden = true
  $("#sheetBody").innerHTML = ""
  if ($("#viewer").hidden) document.body.classList.remove("noscroll")
}
$("#sheet").addEventListener("click", ev => { if (ev.target.closest("[data-close]")) closeSheet() })

const OPTIONS = [
  { id: "pin", icon: I.pin, label: "Pinterest", sub: "Photo or video from a link", ph: "Paste Pinterest link" },
  { id: "shorts", icon: I.shorts, label: "YouTube Shorts", sub: "Video from a link", ph: "Paste Shorts link" },
  { id: "file", icon: I.folder, label: "File", sub: "Photo or video from this device" },
]

function uploadEnergy() {
  openSheet("Add to Energy", `
    <div class="opts">${OPTIONS.map(o => `<button class="opt" data-pick="${o.id}"><span class="oi">${o.icon}</span>
      <span class="ot"><b>${o.label}</b><small>${o.sub}</small></span></button>`).join("")}</div>
    <form class="linkrow" id="linkForm">
      <label class="field"><span class="sr">Link</span><input id="link" type="url" inputmode="url" autocomplete="off" required></label>
      <button class="go">Save</button>
    </form>
    <button class="pick" id="pickMedia"><b>Choose photo or video</b><small>JPG · PNG · MP4 · MOV</small></button>`)
  const pick = id => {
    $$(".opt").forEach(b => b.classList.toggle("on", b.dataset.pick == id))
    $("#linkForm").hidden = id == "file"
    $("#pickMedia").hidden = id != "file"
    if (id != "file") $("#link").placeholder = OPTIONS.find(o => o.id == id).ph
  }
  pick("pin")
  $$(".opt").forEach(b => b.onclick = () => { pick(b.dataset.pick); if (b.dataset.pick != "file") $("#link").focus() })
  // colou o link: escolhe a opção certa sozinho
  $("#link").oninput = () => { const s = sourceOf($("#link").value.trim()); if (s) pick(s) }
  $("#linkForm").onsubmit = async ev => {
    ev.preventDefault()
    const btn = ev.target.querySelector(".go")
    btn.disabled = true
    try {
      await post("/api/fetch", { url: $("#link").value.trim() })
    } catch { btn.disabled = false; return }
    closeSheet()
    if (tab != "energy") setTab("energy")
    loadJobs()
  }
  $("#pickMedia").onclick = () => choose("image/*,video/*", "Energy")
}

function uploadDocs() {
  openSheet("Upload document", `
    <button class="pick big" id="pickDoc"><span class="bigicon">${I.upload}</span><b>Choose a file</b><small>PDF · JPG · PNG</small></button>
    <div class="note">Saved with its own file name.</div>`)
  $("#pickDoc").onclick = () => choose("application/pdf,image/*", "Documents")
}

function choose(accept, dir) {
  const input = $("#pick")
  input.accept = accept
  input.onchange = () => {
    enqueue([...input.files].map(f => ({ file: f, rel: f.name })), dir)
    input.value = ""
    closeSheet()
  }
  input.click()
}

$("#up").onclick = () => tab == "energy" ? uploadEnergy() : uploadDocs()

// ---------- lixeira ----------
async function showTrash() {
  const t = await get("/api/trash")
  openSheet("Trash", !t.length ? `<div class="empty"><b>The trash is empty</b>Deleted files stay here until you empty it.</div>` : `
    <div>${t.map(x => `<div class="trow">
      <span class="tile">${x.dir ? I.folder : label({ name: base(x.path) })}</span>
      <span class="ttext"><div>${esc(base(x.path))}</div><small>${esc(parent(x.path) || "—")} · ${fmtSize(x.size)} · deleted ${fmtDate(x.when)}</small></span>
      <button class="ib" data-restore="${x.id}" title="Restore" aria-label="Restore ${esc(base(x.path))}">${I.restore}</button>
      <button class="ib" data-purge="${x.id}" title="Delete forever" aria-label="Delete ${esc(base(x.path))} forever">${I.close}</button>
    </div>`).join("")}</div>
    <button class="ghost" id="emptyTrash">Empty trash</button>`)
  const after = () => { showTrash(); loadStats(); load() }
  $("#sheetBody").onclick = async ev => {
    const r = ev.target.closest("[data-restore]"), p = ev.target.closest("[data-purge]")
    if (r) { const { path } = await post("/api/trash", { action: "restore", id: r.dataset.restore }); toast(`Restored to ${parent(path) || "the top"}`); after() }
    if (p && await confirmBox("Delete forever?", "This can't be undone.", "Delete")) { await post("/api/trash", { action: "purge", id: p.dataset.purge }); after() }
    if (ev.target.closest("#emptyTrash") && await confirmBox("Empty the trash?", `${t.length} ${t.length == 1 ? "item" : "items"} will be deleted forever.`, "Empty")) {
      await post("/api/trash", { action: "empty" }); after()
    }
  }
}
$("#trashBtn").onclick = showTrash

// ---------- visualizador (e editor de PDF) ----------
let vlist = [], vi = 0, editor = null
let viewing = 0  // muda a cada arquivo aberto/fechado; um PDF que termina de carregar atrasado se descarta

function openViewer(e) {
  vlist = shown
  vi = vlist.indexOf(e)
  showFile()
}

// sair de um PDF com alteração não salva pergunta antes
async function leaveEditor() {
  if (editor?.dirty() && !await confirmBox("Discard changes?", "Your edits to this PDF aren't saved.", "Discard")) return false
  editor?.destroy()
  editor = null
  return true
}

async function showFile() {
  if (!await leaveEditor()) return
  const token = ++viewing
  const e = vlist[vi], k = kind(e), src = raw(e), body = $("#vbody")
  $("#vname").textContent = e.name
  $("#vmeta").textContent = `${fmtSize(e.size)} · ${fmtDate(e.mtime)}` + (e.src ? ` · ${e.src}` : "")
  $("#vdl").href = src + "?dl=1"
  // no PDF as setas ficariam em cima da página que você está editando
  $("#vprev").disabled = vi == 0 || k == "pdf"
  $("#vnext").disabled = vi == vlist.length - 1 || k == "pdf"
  $("#tools").hidden = true
  body.className = ""
  body.innerHTML = ""
  $("#viewer").hidden = false
  document.body.classList.add("noscroll")
  const fallback = msg => body.innerHTML = `<div class="fallback"><div class="tile">${label(e)}</div><p>${msg}</p>
    <a class="go" href="${src}?dl=1" download>${I.dl}Download</a></div>`
  if (k == "image") body.innerHTML = `<img alt="" src="${src}">`
  else if (k == "video") body.innerHTML = `<video controls autoplay playsinline src="${src}"></video>`
  else if (k == "audio") body.innerHTML = `<audio controls autoplay src="${src}"></audio>`
  else if (k == "text") {
    body.innerHTML = "<pre></pre>"
    const limit = 512 * 1024  // texto gigante: mostra o começo
    if (!e.size) body.firstChild.textContent = "(empty file)"
    else fetch(src, { headers: { Range: `bytes=0-${limit - 1}` } }).then(r => r.text()).then(t => {
      if (vlist[vi] == e) body.firstChild.textContent = t + (e.size > limit ? "\n\n… (large file: download it to see everything)" : "")
    })
  }
  else if (k == "pdf") {
    body.className = "pdf"
    const { openPdf } = await import("/static/editor.js")
    const alive = () => token == viewing
    const ed = alive() && await openPdf(body, $("#tools"), { url: src, save: bytes => savePdf(e, bytes), toast, alive })
    if (ed && alive()) editor = ed
    else ed?.destroy()
  }
  else fallback("No preview for this kind of file.")
  body.querySelector(":scope > img, :scope > video, :scope > audio")?.addEventListener("error", () => fallback("The browser can't open this file."))
}

async function savePdf(e, bytes) {
  const r = await api(`/api/upload?path=${encodeURIComponent(e.path)}&replace=1`, {
    method: "PUT", body: new Blob([bytes], { type: "application/pdf" }), headers: { "X-Mtime": Date.now() / 1000 },
  })
  const fresh = await r.json()
  toast("Saved. The previous version is in the trash.")
  editor?.destroy()
  editor = null
  vlist[vi] = fresh
  await load()
  loadStats()
  showFile()
}

async function closeViewer() {
  if (!await leaveEditor()) return
  viewing++
  $("#viewer").hidden = true
  $("#vbody").innerHTML = ""  // para vídeo/áudio
  $("#tools").hidden = true
  document.body.classList.remove("noscroll")
}
const step = d => { if (vlist[vi + d]) { vi += d; showFile() } }
$("#vclose").onclick = closeViewer
$("#vprev").onclick = () => step(-1)
$("#vnext").onclick = () => step(1)

$("#vren").onclick = async () => {
  const e = vlist[vi]
  if (!await leaveEditor()) return showFile()
  const name = await ask("Rename", e.name)
  if (!name || name == e.name) return showFile()
  if (name.includes("/")) { toast("The name can't contain /", { err: true }); return showFile() }
  const to = parent(e.path) + "/" + name
  try { await post("/api/fs", { action: "mv", path: e.path, to }) } catch { return showFile() }
  vlist[vi] = { ...e, name, path: to }
  await load()
  showFile()
}

$("#vdel").onclick = async () => {
  const e = vlist[vi]
  if (!await confirmBox("Delete this file?", e.name, "Delete")) return
  if (editor) { editor.destroy(); editor = null }
  const { id } = await post("/api/fs", { action: "rm", path: e.path })
  toast(`“${e.name}” moved to the trash`, { action: "Undo", run: async () => {
    await post("/api/trash", { action: "restore", id })
    load(); loadStats()
  } })
  await closeViewer()
  load()
  loadStats()
}

// ---------- fila de envio (um por vez, pra não sufocar o servidor) ----------
const queue = []
let busy = false, uFrame = 0, refreshTimer

function enqueue(files, dir) {
  // o servidor recusa nomes começando com "." (.DS_Store e afins), então nem tenta
  files = files.filter(f => !f.rel.split("/").some(s => s.startsWith(".")))
  if (!files.length) return
  for (const f of files) queue.push({ ...f, dir, done: 0, state: "wait" })
  $("#uploads").classList.remove("min")
  drawUploads()
  pump()
}

async function pump() {
  if (busy) return
  busy = true
  let u
  while ((u = queue.find(x => x.state == "wait"))) await send(u)
  busy = false
  drawUploads()
  loadStats()
  if (!queue.some(x => x.state == "err")) setTimeout(() => { if (!busy) { queue.length = 0; drawUploads() } }, 3000)
}

function send(u) {
  return new Promise(done => {
    const x = u.xhr = new XMLHttpRequest()
    u.state = "up"
    x.open("PUT", "/api/upload?path=" + encodeURIComponent(u.dir + "/" + u.rel))
    x.setRequestHeader("X-Mtime", u.file.lastModified / 1000)
    x.upload.onprogress = ev => { u.done = ev.loaded / ev.total; drawUploads() }
    x.onload = () => {
      if (x.status == 401) location = "/login"
      u.state = x.status < 300 ? "ok" : "err"
      if (u.state == "err") try { u.msg = JSON.parse(x.responseText).detail } catch { u.msg = "error " + x.status }
      clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => load(u.dir == "Energy" ? "energy" : "docs"), 400)
      done()
    }
    x.onerror = () => { u.state = "err"; u.msg = "connection failed"; done() }
    x.onabort = () => { u.state = "cancel"; done() }
    x.send(u.file)
  })
}

function drawUploads() {
  if (uFrame) return
  uFrame = requestAnimationFrame(() => {
    uFrame = 0
    const box = $("#uploads")
    box.hidden = !queue.length
    if (!queue.length) return
    const total = queue.reduce((s, u) => s + u.file.size, 0) || 1
    const sent = queue.reduce((s, u) => s + u.file.size * (u.state == "ok" ? 1 : u.state == "up" ? u.done : 0), 0)
    const ok = queue.filter(u => u.state == "ok").length
    const left = queue.filter(u => u.state == "wait" || u.state == "up").length
    const errs = queue.filter(u => u.state == "err").length
    const head = left ? `Uploading ${ok + 1} of ${ok + left}` : errs ? `${errs} failed` : `${ok} uploaded`
    const order = { up: 0, err: 1, wait: 2, ok: 3, cancel: 4 }
    const list = [...queue].sort((a, b) => order[a.state] - order[b.state]).slice(0, 40)
    box.innerHTML = `<div class="uhead"><span>${head}</span>
        <button id="uMin" aria-label="Minimize">${box.classList.contains("min") ? svg('<path d="m5 15 7-7 7 7"/>', 18) : svg('<path d="m5 9 7 7 7-7"/>', 18)}</button>
        <button id="uX" aria-label="${left ? "Cancel all" : "Close"}">${I.close}</button></div>
      <div class="ubar"><i style="width:${(sent / total * 100).toFixed(1)}%"></i></div>
      <div class="ulist">${list.map(u => `<div class="uitem ${u.state}" data-q="${queue.indexOf(u)}">
        <span class="n" title="${esc(u.rel)}">${esc(u.rel)}</span>
        <span class="s">${u.state == "up" ? Math.round(u.done * 100) + "%" : u.state == "ok" ? "✓" : u.state == "err" ? esc(u.msg) : u.state == "cancel" ? "canceled" : fmtSize(u.file.size)}</span>
        ${u.state == "up" || u.state == "wait" ? `<button aria-label="Cancel">${I.close}</button>` : ""}
      </div>`).join("")}</div>
      ${queue.length > list.length ? `<div class="umore">and ${queue.length - list.length} more</div>` : ""}`
  })
}
$("#uploads").addEventListener("click", ev => {
  if (ev.target.closest("#uMin")) { $("#uploads").classList.toggle("min"); return drawUploads() }
  if (ev.target.closest("#uX")) {
    for (const u of queue) if (u.state == "wait") u.state = "cancel"
    queue.find(u => u.state == "up")?.xhr.abort()
    if (!busy) { queue.length = 0; drawUploads() }
    return
  }
  const row = ev.target.closest("button") && ev.target.closest("[data-q]")
  if (!row) return
  const u = queue[row.dataset.q]
  if (u.state == "up") u.xhr.abort()
  else u.state = "cancel"
  drawUploads()
})
addEventListener("beforeunload", ev => { if (busy || editor?.dirty()) ev.preventDefault() })

// ---------- arrastar arquivos pra janela (computador) ----------
let dropTimer
document.addEventListener("dragover", ev => {
  if (!ev.dataTransfer.types.includes("Files")) return
  ev.preventDefault()  // sem isso o navegador abre o arquivo e sai do 911
  $("#dropTo").textContent = DIR[tab]
  $("#drop").classList.add("on")
  clearTimeout(dropTimer)
  dropTimer = setTimeout(() => $("#drop").classList.remove("on"), 150)
})
document.addEventListener("drop", ev => {
  if (!ev.dataTransfer.types.includes("Files")) return
  ev.preventDefault()
  $("#drop").classList.remove("on")
  if (!$("#viewer").hidden) return
  enqueue([...ev.dataTransfer.files].map(f => ({ file: f, rel: f.name })), DIR[tab])
})

// ---------- diálogo e aviso ----------
function dialog(heading, text, value, ok) {
  const d = $("#dlg"), input = $("#dInput")
  $("#dTitle").textContent = heading
  $("#dText").textContent = text ?? ""
  $("#dText").hidden = !text
  $("#dOk").textContent = ok
  $("#dField").hidden = value == null
  input.value = value ?? ""
  d.returnValue = ""
  d.showModal()
  if (value != null) {
    input.focus()
    const dot = value.lastIndexOf(".")
    input.setSelectionRange(0, dot > 0 ? dot : value.length)  // renomear: seleciona sem a extensão
  } else $("#dOk").focus()
  return new Promise(res => d.addEventListener("close", () => res(d.returnValue == "ok" ? input.value.trim() : null), { once: true }))
}
const ask = (heading, value) => dialog(heading, "", value, "Rename")
const confirmBox = (heading, text, ok) => dialog(heading, text, null, ok).then(v => v != null)
$("#dInput").addEventListener("keydown", ev => { if (ev.key == "Enter") { ev.preventDefault(); $("#dlg").close("ok") } })

let toastTimer
function toast(msg, { err, action, run } = {}) {
  const t = $("#toast")
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button>${esc(action)}</button>` : "")
  t.className = "show" + (err ? " err" : "")
  if (action) t.querySelector("button").onclick = () => { t.className = ""; run() }
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.className = "", action ? 6000 : err ? 6000 : 3500)
}

// ---------- teclado ----------
addEventListener("keydown", ev => {
  if ($("#dlg").open) return
  const typing = ev.target.matches("input, textarea, select, [contenteditable]")
  if (!$("#viewer").hidden) {
    if (ev.key == "Escape" && !$(".padwrap")) closeViewer()
    else if (typing || editor || ev.target.matches("video, audio")) return
    else if (ev.key == "ArrowLeft") step(-1)
    else if (ev.key == "ArrowRight") step(1)
    return
  }
  if (!$("#sheet").hidden) { if (ev.key == "Escape") closeSheet(); return }
  // Ctrl+F / Cmd+F abre a busca do 911, não a do navegador
  if ((ev.key == "f" && (ev.ctrlKey || ev.metaKey)) || (ev.key == "/" && !typing)) {
    ev.preventDefault()
    $("#q").focus()
    $("#q").select()
  } else if (ev.key == "Escape" && $("#q").value) {
    $("#q").value = ""
    $("#q").blur()
    render()
  }
})

render()
load()
loadStats()
loadJobs()
