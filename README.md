<div align="center">

# 🏎️ 911

**Vídeos e documentos importantes, todos num lugar só.**

Duas abas: **Energy** (um feed de vídeos e fotos, que dá pra salvar por link do Pinterest ou do YouTube Shorts) e **Documents** (seus PDFs e fotos de documentos, com editor de PDF).

![Python](https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![yt-dlp](https://img.shields.io/badge/yt--dlp-+_gallery--dl-red)
![PDF.js](https://img.shields.io/badge/PDF.js_+_pdf--lib-editor-FF4D2E)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)

</div>

---

## ✨ O que é

App web de **um usuário só**, protegido por senha, seguindo o design do canvas *"911 — Energy & Documents"* (no celular e no computador).

| Aba | O que faz |
|---|---|
| **Energy** | feed com o mais recente em cima. O vídeo toca ali mesmo no feed. O **+** salva por **link do Pinterest** (foto ou vídeo), **link do YouTube Shorts** ou **arquivo do aparelho**. Colou o link, ele escolhe a opção sozinho |
| **Documents** | lista em ordem alfabética (no computador, cartões). O **+** envia o arquivo direto, com o nome original. PDF abre no **editor** |

Em qualquer arquivo dá pra baixar, renomear e apagar. O que você apaga vai pra **lixeira** (link no rodapé), com *Undo* na hora e *Restore* depois.

`Ctrl + F` (ou `⌘ F` no Mac) e `/` focam a busca do 911 em vez da busca do navegador. No computador, dá pra arrastar arquivos pra janela.

### 📄 Editor de PDF

Abrir um PDF em Documents já abre o editor:

| Ferramenta | O que faz |
|---|---|
| **campos** | se o PDF tem formulário (texto, caixa de marcar, opção, lista), os campos viram caixas editáveis por cima da página |
| **Text** | clica na página e digita. Arrasta pela alça, muda o tamanho no seletor de pt |
| **Sign** | desenha a assinatura com o dedo ou o mouse. Ela fica guardada no navegador pra usar de novo |
| **White-out** | arrasta pra cobrir uma área de branco. Dá pra escrever por cima |
| **Save** | grava no próprio arquivo. A versão anterior vai pra lixeira |

Limites:
- **O White-out só cobre visualmente.** O texto que estava embaixo continua no arquivo e pode ser selecionado ou copiado. **Não use pra esconder dado sigiloso.**
- Não edita o texto que já existe no PDF (isso pediria um SDK pago). Pra trocar um trecho, use White-out e escreva por cima.
- O texto novo usa Helvetica. Caractere que ela não tem (emoji, setas) vira `?`. Acentos do português funcionam.
- PDF com senha não abre, e formulário XFA (comum em PDF do governo antigo) não é editável.
- Em página girada (`/Rotate`), o texto e a assinatura podem sair na orientação errada.

### 🔗 Salvar por link

| Site | Funciona? | Como |
|---|---|---|
| **Pinterest** | ✅ foto e vídeo | `gallery-dl` |
| **YouTube / Shorts** | ⚠️ **precisa de cookies** | `yt-dlp` + ffmpeg + Deno |

O YouTube barra o IP do servidor ("Sign in to confirm you're not a bot"). Testado em 13/10/2026 com 7 clientes diferentes do yt-dlp: todos bloqueados. Pra liberar, o yt-dlp precisa dos cookies de uma conta do Google:

1. Use uma **conta secundária**. O YouTube pode marcar como robô a conta usada assim.
2. Numa **janela anônima**, entre no YouTube com essa conta e exporte os cookies em formato `cookies.txt` (Netscape), com uma extensão tipo *Get cookies.txt LOCALLY*.
3. **Feche a janela anônima** sem sair da conta, senão o YouTube invalida os cookies.
4. Salve o arquivo no servidor como `data/.youtube-cookies.txt` (pelo code-server mesmo). Não precisa reiniciar.

Os downloads rodam um de cada vez (o servidor tem 1 vCPU), com limite de 2 GB e 15 min cada. Só links do Pinterest e do YouTube são aceitos: o yt-dlp abriria qualquer URL, e daqui de dentro ele enxergaria o code-server e o Docker.

## 🧱 Como é feito

```
911/
├── app.py              # back inteiro: login, arquivos, salvar por link, lixeira, miniaturas
├── static/
│   ├── index.html      # a página (sem build)
│   ├── app.css         # cores e medidas do design
│   ├── app.js          # abas, feed, upload, visualizador, lixeira
│   ├── editor.js       # editor de PDF (carregado só quando abre um PDF)
│   ├── login.html
│   ├── fonts/          # Archivo e JetBrains Mono (as do design), servidas daqui
│   └── vendor/         # PDF.js 6.4 (build "legacy", roda em iPhone mais antigo) e pdf-lib 1.17
├── data/               # os arquivos (volume, FORA do git)
│   ├── Energy/         # cada item baixado por link tem um ".<nome>.json" escondido com a origem
│   ├── Documents/
│   ├── .lixeira/       # o que foi apagado + um .json com a origem de cada item
│   ├── .thumbs/        # miniaturas de imagem geradas sob demanda
│   └── .youtube-cookies.txt   # (opcional) ver acima
├── Dockerfile          # uv + python 3.13 alpine + ffmpeg + deno
├── compose.yaml        # publica só em 127.0.0.1:8084
└── .env                # senha e segredo (fora do git; ver .env.example)
```

- **Sem banco:** o sistema de arquivos é o banco. Dá pra mexer em `data/` direto pelo terminal que o app enxerga.
- **Nada carregado de fora:** fontes, PDF.js e pdf-lib são servidos pelo próprio 911.
- **Envio em streaming:** o corpo do `PUT` vai direto pro disco (num `.part` escondido, renomeado no fim). Os arquivos sobem um de cada vez, com barra de progresso.
- **Vídeo com seek:** o `/raw/` responde `Range`, então dá pra pular pra qualquer ponto.
- O feed ordena pelo `ctime` (quando o arquivo chegou), porque o envio preserva a data original no `mtime`.

### 🔒 Autenticação

- Uma senha (`PASSWORD`). O cookie `s` é um HMAC da senha com `SECRET`: trocar a senha desloga todo mundo. Cookie `HttpOnly`, `Secure`, `SameSite=Lax`, vale 30 dias.
- **5 senhas erradas em 15 min bloqueiam aquele IP por 15 min**, e cada erro demora 1 s pra responder. O IP vem do `X-Forwarded-For` do Caddy (o container só escuta em `127.0.0.1`, então ninguém de fora forja esse cabeçalho). O bloqueio fica em memória e zera quando o container reinicia.
- Tudo exige o cookie, menos `/login` e `/static/` (só JS, CSS, fontes e o PDF.js, nada pessoal).
- Nenhum caminho sai de `data/`, e nada que comece com `.` é acessível pela API (protege a lixeira, as miniaturas, os `.part`, os `.json` de origem e os cookies do YouTube).
- Arquivo enviado abre com `Content-Security-Policy: sandbox` e `nosniff`: um `.html` ou `.svg` malicioso não roda script com a sua sessão. O PDF fica de fora do sandbox porque o leitor de PDF do Chrome não abre nele.

### API

| Rota | Faz |
|---|---|
| `GET/POST /login`, `POST /logout` | sessão |
| `GET /api/list?path=Energy` | conteúdo de uma pasta (`src` = de onde veio, se foi por link) |
| `GET /api/stats` | espaço usado, livre e itens na lixeira |
| `PUT /api/upload?path=` | corpo cru = arquivo; `X-Mtime` opcional; `replace=1` manda a versão anterior pra lixeira |
| `POST /api/fs` | `{"action": "mv" \| "rm", "path": "...", "to": "..."}` (`rm` manda pra lixeira e devolve o `id`) |
| `POST /api/fetch` | `{"url": "..."}`: salva por link em Energy, em segundo plano |
| `GET /api/jobs`, `POST /api/jobs/dismiss` | downloads por link (estado, progresso, erro) |
| `GET /api/trash` / `POST /api/trash` | lista; `{"action": "restore" \| "purge" \| "empty", "id": "..."}` |
| `GET /raw/<caminho>` | o arquivo (`?dl=1` força download) |
| `GET /thumb/<caminho>` | miniatura WebP de imagem (até 960 px) |

## 🚀 Subir do zero

Pré-requisitos no servidor: Docker com o plugin compose e o Caddy rodando no host como reverse proxy.

```bash
git clone https://github.com/luiz-nast/911.git /root/opala/project/911
cd /root/opala/project/911
cp .env.example .env        # defina PASSWORD e um SECRET aleatório
docker compose up -d --build
```

Para gerar um segredo aleatório:

```bash
head -c 32 /dev/urandom | base64
```

Bloco no `/etc/caddy/Caddyfile`:

```caddy
911.premiumlts.com.br {
reverse_proxy 127.0.0.1:8084
}
```

```bash
caddy reload --config /etc/caddy/Caddyfile
```

DNS: registro **A** `911` apontando para o IP do servidor. O Caddy não limita o tamanho do envio, então vídeo grande passa sem configurar nada.

### Checklist pós-deploy

- [ ] `curl -I http://127.0.0.1:8084/` responde `307` para `/login`
- [ ] `https://911.premiumlts.com.br` abre com HTTPS válido e o login funciona
- [ ] colar um link de pin do Pinterest em Energy salva o vídeo/foto
- [ ] abrir um PDF em Documents, escrever algo, salvar e reabrir

## 🔧 Manutenção

| Situação | Comando (em `/root/opala/project/911`) |
|---|---|
| mudou código ou `static/` | `docker compose up -d --build` |
| mudou o `.env` | `docker compose up -d` (**não** use `restart`: ele não relê o `.env`) |
| logs | `docker compose logs -f` |
| Pinterest/YouTube pararam de baixar | atualizar o yt-dlp e o gallery-dl (abaixo) |
| esvaziar miniaturas (são recriadas) | `rm -rf data/.thumbs/*` |
| backup | copiar a pasta `data/` inteira (ela não vai pro git) |

Os sites mudam e o yt-dlp/gallery-dl soltam versão nova com frequência. Pra atualizar:

```bash
docker run --rm -v "$PWD":/app -w /app ghcr.io/astral-sh/uv:python3.13-alpine uv lock --upgrade-package yt-dlp --upgrade-package yt-dlp-ejs --upgrade-package gallery-dl
```

```bash
docker compose up -d --build
```

> ⚠️ `data/` **não** está no git (vídeo não cabe lá). O backup é por sua conta: `rsync`, `rclone` pra um storage, ou um disco externo.

## 🎨 Design

Cores em variáveis CSS no `:root` de `static/app.css`, tiradas do canvas:

| | |
|---|---|
| fundo | `#0E0E10` |
| superfície | `#18181B` |
| texto | `#F4F1EA` |
| destaque | `#FF4D2E` |
| fontes | Archivo (texto) e JetBrains Mono (o "911" e os nomes de arquivo) |
