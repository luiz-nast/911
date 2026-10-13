import asyncio
import hashlib
import hmac
import json
import mimetypes
import os
import shutil
import time
import unicodedata
import uuid
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, PlainTextResponse, RedirectResponse
from PIL import Image, ImageOps

DATA = Path("data").resolve()
TRASH = DATA / ".lixeira"
THUMBS = DATA / ".thumbs"
TRASH.mkdir(parents=True, exist_ok=True)
THUMBS.mkdir(exist_ok=True)

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
}.items():
    mimetypes.add_type(kind, ext)

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def auth(request: Request, call_next):
    if request.url.path == "/login" or hmac.compare_digest(request.cookies.get("s", ""), TOKEN):
        return await call_next(request)
    if request.url.path.startswith(("/api/", "/raw/", "/thumb/")):
        return PlainTextResponse("faça login", 401)
    return RedirectResponse("/login")


def safe(path: str, root_ok=False) -> Path:
    # nada que comece com "." (pega "..", a lixeira e os .part de upload)
    parts = [s for s in path.split("/") if s]
    if any(s.startswith(".") for s in parts):
        raise HTTPException(400, "caminho inválido")
    p = DATA.joinpath(*parts).resolve()
    if not p.is_relative_to(DATA) or (p == DATA and not root_ok):
        raise HTTPException(400, "caminho inválido")
    return p


def existing(path: str) -> Path:
    p = safe(path)
    if not p.exists():
        raise HTTPException(404, "não existe")
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


def entry(p: Path) -> dict:
    st = p.stat()
    e = {"name": p.name, "path": rel(p), "dir": p.is_dir(), "mtime": st.st_mtime}
    if e["dir"]:
        e["n"] = sum(1 for c in p.iterdir() if not c.name.startswith("."))
    else:
        e["size"] = st.st_size
    return e


def fold(s: str) -> str:
    # minúsculo e sem acento, pra busca achar "certidao" em "Certidão"
    return "".join(c for c in unicodedata.normalize("NFD", s.casefold()) if not unicodedata.combining(c))


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
        return RedirectResponse(f"/login?bloqueado={int((recent[0] + WINDOW - now) / 60) + 1}", 303)
    if not hmac.compare_digest(password.encode(), PASSWORD.encode()):
        recent.append(now)
        await asyncio.sleep(1)
        return RedirectResponse("/login?erro", 303)
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
def list_dir(path: str = ""):
    p = safe(path, root_ok=True)
    if not p.is_dir():
        raise HTTPException(404, "pasta não existe")
    return [entry(c) for c in p.iterdir() if not c.name.startswith(".")]


@app.get("/api/search")
def search(q: str):
    words = fold(q).split()
    out = []
    for root, dirs, files in walk(DATA):
        for name in dirs + files:
            if all(w in fold(name) for w in words):
                out.append(entry(root / name))
                if len(out) == 300:
                    return out
    return out


@app.get("/api/stats")
def stats():
    count, used = 0, 0
    for root, _, files in walk(DATA):
        count += len(files)
        used += sum((root / f).stat().st_size for f in files)
    return {"files": count, "used": used, "trash": size(TRASH),
            "free": shutil.disk_usage(DATA).free}


@app.put("/api/upload")
async def upload(path: str, request: Request):
    # o corpo da requisição é o arquivo cru, gravado direto no disco (nada de multipart em /tmp)
    dest = safe(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{uuid.uuid4().hex}.part")
    try:
        with tmp.open("wb") as f:
            async for chunk in request.stream():
                f.write(chunk)
        if mtime := request.headers.get("x-mtime"):  # mantém a data original do arquivo
            os.utime(tmp, (float(mtime), float(mtime)))
        dest = unique(dest)
        tmp.rename(dest)
    finally:
        tmp.unlink(missing_ok=True)
    return entry(dest)


@app.post("/api/fs")
def fs(body: dict):
    match body["action"]:
        case "mkdir":
            p = safe(body["path"])
            if p.exists():
                raise HTTPException(409, "já existe")
            p.mkdir(parents=True)
        case "mv":
            p, to = existing(body["path"]), safe(body["to"])
            if to.exists():
                raise HTTPException(409, "já existe algo com esse nome")
            if to.is_relative_to(p):
                raise HTTPException(400, "não dá pra mover uma pasta pra dentro dela mesma")
            to.parent.mkdir(parents=True, exist_ok=True)
            p.rename(to)
        case "rm":  # vai pra lixeira
            p = existing(body["path"])
            tid = str(time.time_ns())
            meta = {"path": rel(p), "dir": p.is_dir(), "size": size(p), "when": time.time()}
            p.rename(TRASH / tid)
            (TRASH / f"{tid}.json").write_text(json.dumps(meta))
            return {"id": tid}  # pro "desfazer"
        case _:
            raise HTTPException(400, "ação desconhecida")


@app.get("/raw/{path:path}")
def raw(path: str, dl: bool = False):
    p = existing(path)
    if not p.is_file():
        raise HTTPException(404, "não é arquivo")
    r = FileResponse(p, filename=p.name, content_disposition_type="attachment" if dl else "inline")
    r.headers["X-Content-Type-Options"] = "nosniff"
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
    key = hashlib.sha1(f"{rel(p)}:{st.st_mtime_ns}:{st.st_size}".encode()).hexdigest()
    out = THUMBS / f"{key}.webp"
    if not out.exists():
        try:
            with Image.open(p) as im:
                im.draft("RGB", (480, 480))  # JPEG grande decodifica já reduzido
                im = ImageOps.exif_transpose(im)
                im.thumbnail((480, 480))
                im = im.convert("RGBA" if im.has_transparency_data else "RGB")
                tmp = out.with_suffix(f".{uuid.uuid4().hex}")
                im.save(tmp, "WEBP", quality=80)
                tmp.rename(out)
        except Exception:
            raise HTTPException(415, "sem miniatura")
    return FileResponse(out, headers={"Cache-Control": "private, max-age=31536000, immutable"})


# ---------- lixeira ----------


def trashed(tid: str) -> tuple[Path, dict]:
    if not tid.isdigit() or not (TRASH / f"{tid}.json").exists():
        raise HTTPException(404, "não está na lixeira")
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
    return sorted(items, key=lambda i: -i["when"])


@app.post("/api/trash")
def trash_action(body: dict):
    match body["action"]:
        case "restore":
            item, meta = trashed(body["id"])
            dest = unique(safe(meta["path"]))
            dest.parent.mkdir(parents=True, exist_ok=True)
            item.rename(dest)
            (TRASH / f"{body['id']}.json").unlink()
            return {"path": rel(dest)}
        case "purge":
            purge(body["id"])
        case "empty":
            for j in TRASH.glob("*.json"):
                purge(j.stem)
        case _:
            raise HTTPException(400, "ação desconhecida")


# qualquer outro caminho é a mesma página; a pasta aberta fica no #hash
@app.get("/{path:path}")
def page(path: str):
    return FileResponse("static/index.html")
