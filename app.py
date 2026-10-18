import asyncio
import hashlib
import hmac
import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps

DATA = Path("data").resolve()
TRASH = DATA / ".lixeira"
THUMBS = DATA / ".thumbs"
ENERGY = DATA / "Energy"
DOCS = DATA / "Documents"
# cookies.txt de uma conta do Google: sem ele o YouTube barra o IP do servidor ("not a bot")
COOKIES = DATA / ".youtube-cookies.txt"
for d in (TRASH, THUMBS, ENERGY, DOCS):
    d.mkdir(parents=True, exist_ok=True)
# sobras de download/envio interrompido por um restart
for junk in [*ENERGY.glob(".job-*"), *DATA.rglob(".*.part")]:
    shutil.rmtree(junk) if junk.is_dir() else junk.unlink()

PASSWORD = os.environ["PASSWORD"]
# o cookie é só um hash da senha: trocou a senha, todo mundo é deslogado
TOKEN = hmac.new(os.environ["SECRET"].encode(), PASSWORD.encode(), hashlib.sha256).hexdigest()

# tentativas erradas de login por IP: 5 erros em 15 min bloqueiam aquele IP por 15 min
MAX_FAILS, WINDOW = 5, 15 * 60
fails: dict[str, list[float]] = {}

# tipos que o mimetypes do python não conhece (ou erra) e o navegador sabe tocar/mostrar
for ext, kind in {
    ".mkv": "video/x-matroska", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".m4a": "audio/mp4", ".flac": "audio/flac", ".opus": "audio/ogg", ".ogg": "audio/ogg",
    ".webp": "image/webp", ".avif": "image/avif", ".heic": "image/heic", ".md": "text/markdown",
    ".mjs": "text/javascript", ".wasm": "application/wasm",
}.items():
    mimetypes.add_type(kind, ext)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
# js, css, fontes e o pdf.js: nada pessoal, abre sem login (a tela de login usa as fontes)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.middleware("http")
async def auth(request: Request, call_next):
    path = request.url.path
    if path == "/login" or path.startswith("/static/") or hmac.compare_digest(request.cookies.get("s", ""), TOKEN):
        return await call_next(request)
    if path.startswith(("/api/", "/raw/", "/thumb/")):
        return PlainTextResponse("log in first", 401)
    return RedirectResponse("/login")


def safe(path: str, root_ok=False) -> Path:
    # nada que comece com "." (pega "..", a lixeira, os .part e os .json de origem)
    parts = [s for s in path.split("/") if s]
    if any(s.startswith(".") for s in parts):
        raise HTTPException(400, "invalid path")
    p = DATA.joinpath(*parts).resolve()
    if not p.is_relative_to(DATA) or (p == DATA and not root_ok):
        raise HTTPException(400, "invalid path")
    return p


def existing(path: str) -> Path:
    p = safe(path)
    if not p.exists():
        raise HTTPException(404, "not found")
    return p


def rel(p: Path) -> str:
    return str(p.relative_to(DATA))


def unique(p: Path) -> Path:
    # "foto.jpg" ocupado vira "foto (2).jpg", "foto (3).jpg"...
    n = 2
    stem, suffix = (p.name, "") if p.is_dir() else (p.stem, p.suffix)
    while p.exists():
        p = p.with_name(f"{stem} ({n}){suffix}")
        n += 1
    return p


def walk(top: Path):
    # todos os arquivos visíveis embaixo de top (pula pastas/arquivos que começam com ".")
    for root, dirs, files in os.walk(top):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        yield Path(root), dirs, [f for f in files if not f.startswith(".")]


def size(p: Path) -> int:
    if p.is_file():
        return p.stat().st_size
    return sum((r / f).stat().st_size for r, _, fs in walk(p) for f in fs)


# o que não cabe no nome do arquivo (de onde veio, o rótulo) fica num ".<nome>.json" escondido do lado dele
def side(p: Path) -> Path:
    return p.with_name(f".{p.name}.json")


def read_side(p: Path) -> dict:
    try:
        return json.loads(side(p).read_text())
    except (OSError, ValueError):
        return {}


def write_side(p: Path, **changes):
    # None apaga a chave; sem chave nenhuma, o .json some
    meta = read_side(p)
    for k, v in changes.items():
        if v is None:
            meta.pop(k, None)
        else:
            meta[k] = v
    if meta:
        side(p).write_text(json.dumps(meta))
    else:
        side(p).unlink(missing_ok=True)


def move(p: Path, to: Path):
    p.rename(to)
    if side(p).exists():
        side(p).rename(side(to))


def entry(p: Path) -> dict:
    st = p.stat()
    # "added" é o ctime: muda quando o arquivo chega aqui, mesmo com a data original preservada no mtime
    e = {"name": p.name, "path": rel(p), "dir": p.is_dir(), "mtime": st.st_mtime, "added": st.st_ctime}
    if e["dir"]:
        e["n"] = sum(1 for c in p.iterdir() if not c.name.startswith("."))
    else:
        e["size"] = st.st_size
        meta = read_side(p)
        for k in ("src", "label"):
            if meta.get(k):
                e[k] = meta[k]
    return e


def to_trash(p: Path) -> str:
    tid = str(time.time_ns())
    meta = {"path": rel(p), "dir": p.is_dir(), "size": size(p), "when": time.time()}
    if p.is_file() and side(p).exists():
        meta["side"] = read_side(p)
        side(p).unlink()
    p.rename(TRASH / tid)
    (TRASH / f"{tid}.json").write_text(json.dumps(meta))
    return tid


# ---------- sessão ----------


@app.get("/login")
def login_page():
    return FileResponse("static/login.html")


@app.post("/login")
async def login(request: Request, password: str = Form()):
    ip = request.client.host if request.client else "?"
    now = time.time()
    recent = fails[ip] = [t for t in fails.get(ip, []) if t > now - WINDOW]
    if len(recent) >= MAX_FAILS:
        return RedirectResponse(f"/login?blocked={int((recent[0] + WINDOW - now) / 60) + 1}", 303)
    if not hmac.compare_digest(password.encode(), PASSWORD.encode()):
        recent.append(now)
        await asyncio.sleep(1)
        return RedirectResponse("/login?wrong", 303)
    fails.pop(ip, None)
    r = RedirectResponse("/", 303)
    r.set_cookie("s", TOKEN, max_age=60 * 60 * 24 * 30, httponly=True, secure=True, samesite="lax")
    return r


@app.post("/logout")
def logout():
    r = RedirectResponse("/login", 303)
    r.delete_cookie("s")
    return r


# ---------- arquivos ----------


@app.get("/api/list")
def list_dir(path: str = "", deep: bool = False):
    # deep=1: cada pasta já vem com os arquivos dela (as estantes de Documents numa chamada só)
    p = safe(path, root_ok=True)
    if not p.is_dir():
        raise HTTPException(404, "folder not found")
    out = []
    for c in p.iterdir():
        if c.name.startswith("."):
            continue
        e = entry(c)
        if deep and e["dir"]:
            e["items"] = [entry(x) for x in c.iterdir() if x.is_file() and not x.name.startswith(".")]
        out.append(e)
    return out


@app.get("/api/stats")
def stats():
    count, used = 0, 0
    for root, _, files in walk(DATA):
        count += len(files)
        used += sum((root / f).stat().st_size for f in files)
    return {"files": count, "used": used, "trash": len(list(TRASH.glob("*.json"))),
            "free": shutil.disk_usage(DATA).free}


@app.put("/api/upload")
async def upload(path: str, request: Request, replace: bool = False):
    # o corpo da requisição é o arquivo cru, gravado direto no disco (nada de multipart em /tmp)
    # replace=1 (o editor de PDF salvando): a versão anterior vai pra lixeira
    dest = safe(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{uuid.uuid4().hex}.part")
    try:
        with tmp.open("wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        if mtime := request.headers.get("x-mtime"):  # mantém a data original do arquivo
            os.utime(tmp, (float(mtime), float(mtime)))
        keep = {}
        if replace and dest.is_file():
            keep = read_side(dest)  # rótulo e origem continuam valendo pra versão nova
            to_trash(dest)
        dest = unique(dest)
        tmp.rename(dest)
        if keep:
            write_side(dest, **keep)
    finally:
        tmp.unlink(missing_ok=True)
    return entry(dest)


def shelf_name(name) -> str:
    name = str(name or "").strip()
    if not name or "/" in name or "\\" in name or name.startswith(".") or len(name) > 60:
        raise HTTPException(400, "Shelf names can't be empty, start with a dot or contain /.")
    return name


@app.post("/api/fs")
def fs(body: dict):
    match body["action"]:
        case "mkdir":  # estante nova: só um nível, direto dentro de Documents
            p = safe(body["path"])
            shelf_name(p.name)
            if p.parent != DOCS:
                raise HTTPException(400, "shelves only live inside Documents")
            if p.exists():
                raise HTTPException(409, "there's already a shelf with that name")
            p.mkdir(parents=True)
        case "mv":
            # unique=1 (arrastar vários pra uma estante): nome repetido vira "nome (2)" em vez de erro
            p, to = existing(body["path"]), safe(body["to"])
            if p.is_dir():
                shelf_name(to.name)
            if body.get("unique"):
                to = unique(to)
            if to.exists():
                raise HTTPException(409, "a file with that name already exists")
            if to.is_relative_to(p):
                raise HTTPException(400, "can't move a folder into itself")
            to.parent.mkdir(parents=True, exist_ok=True)
            move(p, to)
            return {"path": rel(to)}
        case "cp":
            p = existing(body["path"])
            if not p.is_file():
                raise HTTPException(400, "only files can be copied")
            to = unique(safe(body["to"]))
            to.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, to)
            if side(p).exists():
                shutil.copy2(side(p), side(to))
            return {"path": rel(to)}
        case "label":  # o nome que aparece no lugar do nome do arquivo; vazio tira o rótulo
            p = existing(body["path"])
            write_side(p, label=str(body.get("label") or "").strip()[:120] or None)
        case "unshelve":
            # apaga a estante mas não os arquivos: eles voltam pra fora dela (Unsorted)
            p = existing(body["path"])
            if not p.is_dir():
                raise HTTPException(400, "not a shelf")
            for c in list(p.iterdir()):
                if not c.name.startswith("."):
                    move(c, unique(p.parent / c.name))
            shutil.rmtree(p)  # só sobrou coisa escondida (.part de envio interrompido, .json órfão)
        case "rm":  # vai pra lixeira
            return {"id": to_trash(existing(body["path"]))}  # o id serve pro "desfazer"
        case _:
            raise HTTPException(400, "unknown action")


@app.get("/raw/{path:path}")
def raw(path: str, dl: bool = False):
    p = existing(path)
    if not p.is_file():
        raise HTTPException(404, "not a file")
    r = FileResponse(p, filename=p.name, content_disposition_type="attachment" if dl else "inline")
    r.headers["X-Content-Type-Options"] = "nosniff"
    # o mesmo caminho pode ganhar conteúdo novo (PDF salvo, arquivo apagado e enviado de novo):
    # o navegador sempre confere com o servidor (ETag) em vez de reaproveitar uma cópia velha
    r.headers["Cache-Control"] = "private, no-cache"
    # um .html/.svg enviado abre isolado, sem rodar script com a sua sessão
    # (o PDF fica de fora porque o leitor de PDF do Chrome não abre em sandbox)
    if r.media_type != "application/pdf":
        r.headers["Content-Security-Policy"] = "sandbox"
    return r


@app.get("/thumb/{path:path}")
def thumb(path: str):
    # miniatura de imagem, gerada uma vez e guardada em data/.thumbs
    p = existing(path)
    st = p.stat()
    key = hashlib.sha1(f"{rel(p)}:{st.st_mtime_ns}:{st.st_size}:960".encode()).hexdigest()
    out = THUMBS / f"{key}.webp"
    if not out.exists():
        try:
            with Image.open(p) as im:
                im.draft("RGB", (960, 960))  # JPEG grande decodifica já reduzido
                im = ImageOps.exif_transpose(im)
                im.thumbnail((960, 960))
                im = im.convert("RGBA" if im.has_transparency_data else "RGB")
                tmp = out.with_suffix(f".{uuid.uuid4().hex}")
                im.save(tmp, "WEBP", quality=80)
                tmp.rename(out)
        except Exception:
            raise HTTPException(415, "no thumbnail")
    return FileResponse(out, headers={"Cache-Control": "private, max-age=31536000, immutable"})


# ---------- salvar por link (Pinterest e YouTube) ----------

MEDIA = {".mp4", ".webm", ".mkv", ".mov", ".m4v", ".jpg", ".jpeg", ".png", ".gif", ".webp"}
PINTEREST = re.compile(r"((www|[a-z]{2})\.)?pinterest\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})|pin\.it")
YOUTUBE = re.compile(r"((www|m)\.)?youtube\.com|youtu\.be")
jobs: dict[str, dict] = {}
todo: queue.Queue = queue.Queue()


def source_of(url: str) -> str | None:
    # só esses sites: o yt-dlp aceita qualquer URL, e o servidor enxerga coisas internas (code-server, Docker)
    u = urlparse(url)
    host = (u.hostname or "").lower()
    if u.scheme not in ("http", "https"):
        return None
    if PINTEREST.fullmatch(host):
        return "Pinterest"
    if YOUTUBE.fullmatch(host):
        return "YouTube Shorts" if u.path.startswith("/shorts/") else "YouTube"
    return None


def title_for(f: Path, fallback: str) -> str:
    # o título vira o nome do arquivo; vem do .json que o yt-dlp/gallery-dl escrevem do lado
    meta = {}
    for j in (f.with_suffix(".info.json"), f.with_name(f.name + ".json")):
        if j.exists():
            meta = json.loads(j.read_text())
            break
    for key in ("title", "grid_title", "seo_title", "description"):
        if isinstance(meta.get(key), str) and meta[key].strip():
            text = re.sub(r"[\x00-\x1f/\\]+", " ", meta[key])
            text = re.sub(r"\s+", " ", text).strip(" .")[:80].strip()
            if text:
                return text
    return fallback


def friendly(out: list[str]) -> str:
    text = "\n".join(out)
    if "not a bot" in text or "Sign in to confirm" in text:
        return "YouTube blocked the server. It needs cookies from a Google account (see the README)."
    if "No video formats" in text or not out:
        return "Nothing to download at this link."
    errors = [line.removeprefix("ERROR:").strip() for line in out if line.startswith("ERROR")]
    return (errors or out)[-1][:300]


def run(job: dict):
    tmp = ENERGY / f".job-{job['id']}"
    tmp.mkdir()
    try:
        if job["source"] == "Pinterest":
            # gallery-dl pega foto e vídeo; o yt-dlp só sabe vídeo de pin
            cmd = [sys.executable, "-m", "gallery_dl", "--write-metadata", "-D", str(tmp), "--", job["url"]]
        else:
            cmd = [sys.executable, "-m", "yt_dlp", "--ignore-config", "--use-extractors", "youtube", "--no-playlist",
                   # H.264 + AAC num .mp4: toca em qualquer lugar, inclusive no iPhone
                   "-f", "bv*[vcodec^=avc1]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b", "--merge-output-format", "mp4",
                   "--max-filesize", "2G", "--write-info-json", "-o", "%(id)s.%(ext)s", "-P", str(tmp),
                   "--newline", "--progress-template", "download:%(progress._percent_str)s"]
            if COOKIES.exists():
                cmd += ["--cookies", str(COOKIES)]
            cmd += ["--", job["url"]]
        job["state"] = "running"
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        timer = threading.Timer(15 * 60, proc.kill)
        timer.start()
        out = []
        for line in proc.stdout:
            if m := re.match(r"download:\s*([\d.]+)%", line.strip()):
                job["progress"] = float(m[1]) / 100
            elif line.strip():
                out.append(line.strip())
        proc.wait()
        timer.cancel()
        files = [f for f in sorted(tmp.rglob("*")) if f.suffix.lower() in MEDIA]
        if proc.returncode != 0 or not files:
            job.update(state="error", msg=friendly(out))
            return
        for f in files:
            dest = unique(ENERGY / f"{title_for(f, f.stem)}{f.suffix.lower()}")
            f.rename(dest)
            write_side(dest, src=job["source"], url=job["url"])
            job["files"].append(rel(dest))
        job.update(state="done", progress=1)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def worker():
    # um download por vez: o servidor tem 1 vCPU
    while True:
        job = todo.get()
        try:
            run(job)
        except Exception as e:
            job.update(state="error", msg=str(e)[:300])


threading.Thread(target=worker, daemon=True).start()


@app.post("/api/fetch")
def fetch(body: dict):
    url = str(body.get("url", "")).strip()
    src = source_of(url)
    if not src:
        raise HTTPException(400, "Only Pinterest and YouTube links.")
    jid = uuid.uuid4().hex[:10]
    jobs[jid] = {"id": jid, "url": url, "source": src, "state": "queued", "progress": 0, "msg": "", "files": [],
                 "at": time.time()}
    for old in sorted(jobs.values(), key=lambda j: j["at"])[:-30]:  # guarda só os 30 mais recentes
        if old["state"] in ("done", "error"):
            jobs.pop(old["id"])
    todo.put(jobs[jid])
    return jobs[jid]


@app.get("/api/jobs")
def job_list():
    return sorted(jobs.values(), key=lambda j: -j["at"])


@app.post("/api/jobs/dismiss")
def job_dismiss(body: dict):
    if jobs.get(body["id"], {}).get("state") in ("done", "error"):
        jobs.pop(body["id"])


# ---------- lixeira ----------


def trashed(tid: str) -> tuple[Path, dict]:
    if not tid.isdigit() or not (TRASH / f"{tid}.json").exists():
        raise HTTPException(404, "not in the trash")
    return TRASH / tid, json.loads((TRASH / f"{tid}.json").read_text())


def purge(tid: str):
    item, _ = trashed(tid)
    if item.is_dir():
        shutil.rmtree(item)
    else:
        item.unlink(missing_ok=True)
    (TRASH / f"{tid}.json").unlink()


@app.get("/api/trash")
def trash_list():
    items = [{"id": j.stem, **json.loads(j.read_text())} for j in TRASH.glob("*.json")]
    for i in items:
        i["expires"] = i["when"] + TRASH_DAYS * 86400
    return sorted(items, key=lambda i: -i["when"])


@app.post("/api/trash")
def trash_action(body: dict):
    match body["action"]:
        case "restore":
            item, meta = trashed(body["id"])
            dest = safe(meta["path"])
            if not dest.parent.exists():  # a estante dele foi apagada: volta pra fora das estantes
                dest = DATA / Path(meta["path"]).parts[0] / dest.name
            dest = unique(dest)
            dest.parent.mkdir(parents=True, exist_ok=True)
            item.rename(dest)
            if "side" in meta:
                side(dest).write_text(json.dumps(meta["side"]))
            (TRASH / f"{body['id']}.json").unlink()
            return {"path": rel(dest)}
        case "purge":
            purge(body["id"])
        case "empty":
            for j in TRASH.glob("*.json"):
                purge(j.stem)
        case _:
            raise HTTPException(400, "unknown action")


# o que está na lixeira há mais de 15 dias some sozinho (confere ao subir e depois de hora em hora)
TRASH_DAYS = 15


def janitor():
    while True:
        limit = time.time() - TRASH_DAYS * 86400
        for j in TRASH.glob("*.json"):
            try:
                if json.loads(j.read_text())["when"] < limit:
                    purge(j.stem)
            except (OSError, ValueError, KeyError, HTTPException):
                pass  # sumiu no meio do caminho (a pessoa esvaziou a lixeira ao mesmo tempo)
        time.sleep(3600)


threading.Thread(target=janitor, daemon=True).start()


# qualquer outro caminho é a mesma página; a aba aberta fica no #hash
@app.get("/{path:path}")
def page(path: str):
    return FileResponse("static/index.html")
