<div align="center">

# 🏎️ 911

**Vídeos e documentos importantes, todos num lugar só.**

Um cofre pessoal: pastas, envio arrastando, pré-visualização e lixeira.

![Python](https://img.shields.io/badge/Python-3.13-3776AB?logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)
![Sem build](https://img.shields.io/badge/front-sem_build-d5001c)

</div>

---

## ✨ O que é

App web de **um usuário só**, protegido por senha. Os arquivos ficam em pastas, do jeito que estão no disco.

| Faz | Como |
|---|---|
| **enviar** | botão *Enviar* (arquivos ou pasta inteira) ou arrastar pra janela. Soltar em cima de uma pasta envia pra dentro dela. Pastas arrastadas mantêm a estrutura |
| **ver** | foto, vídeo, áudio, PDF e texto abrem direto no navegador; `←` `→` passam pro próximo |
| **organizar** | nova pasta, renomear (`F2`), mover (arrastando o cartão pra uma pasta ou pro caminho no topo) |
| **buscar** | `/` foca a busca; procura em todas as pastas, sem diferenciar acento ou maiúscula |
| **apagar** | `Delete` ou menu `⋯`: vai pra **lixeira**, com *Desfazer* na hora e *Restaurar* depois |

Nome repetido não sobrescreve: `foto.jpg` vira `foto (2).jpg`. A data original do arquivo é mantida no envio.

## 🧱 Como é feito

```
911/
├── app.py              # back inteiro: login, listar, enviar, mover, lixeira, miniaturas
├── static/
│   ├── index.html      # a interface toda (HTML/CSS/JS puro)
│   └── login.html
├── data/               # os arquivos (volume, FORA do git)
│   ├── .lixeira/       # o que foi apagado + um .json com a origem de cada item
│   └── .thumbs/        # miniaturas de imagem geradas sob demanda
├── Dockerfile          # imagem uv + python 3.13 alpine
├── compose.yaml        # publica só em 127.0.0.1:8084
├── pyproject.toml / uv.lock
└── .env                # senha e segredo (fora do git; ver .env.example)
```

- **Sem banco:** o sistema de arquivos é o banco. Dá pra mexer em `data/` direto pelo terminal que o app enxerga.
- **Sem build e sem CDN no front:** nada é carregado de fora; os ícones são SVG no próprio HTML.
- **Envio em streaming:** o corpo do `PUT` vai direto pro disco (num `.part` escondido, renomeado no fim). Vídeo grande não passa pela memória nem pelo `/tmp`. Os arquivos sobem um de cada vez, com barra de progresso.
- **Vídeo com seek:** o `/raw/` responde `Range`, então dá pra pular pra qualquer ponto do vídeo.
- **URLs:** a pasta aberta fica no hash (`/#/Documentos/Carro`), então qualquer nome de pasta funciona.

### 🔒 Autenticação

- Uma senha (`PASSWORD`). O cookie `s` é um HMAC da senha com `SECRET`: trocar a senha desloga todo mundo. Cookie `HttpOnly`, `Secure`, `SameSite=Lax`, vale 30 dias.
- **5 senhas erradas em 15 min bloqueiam aquele IP por 15 min**, e cada erro demora 1 s pra responder. O IP vem do `X-Forwarded-For` do Caddy (o container só escuta em `127.0.0.1`, então ninguém de fora forja esse cabeçalho). O bloqueio fica em memória e zera quando o container reinicia.
- Tudo fora do `/login` exige o cookie, inclusive os arquivos crus e as miniaturas.
- Nenhum caminho sai de `data/`, e nada que comece com `.` é acessível pela API (isso protege `.lixeira`, `.thumbs` e os `.part`).
- Arquivo enviado abre com `Content-Security-Policy: sandbox` e `nosniff`: um `.html` ou `.svg` malicioso não roda script com a sua sessão. O PDF fica de fora do sandbox porque o leitor do Chrome não abre nele.

### API

| Rota | Faz |
|---|---|
| `GET/POST /login`, `POST /logout` | sessão |
| `GET /api/list?path=` | conteúdo de uma pasta |
| `GET /api/search?q=` | busca por nome em tudo (até 300 resultados) |
| `GET /api/stats` | espaço usado, livre e na lixeira |
| `PUT /api/upload?path=` | corpo cru = arquivo; cabeçalho `X-Mtime` opcional com a data original |
| `POST /api/fs` | `{"action": "mkdir" \| "mv" \| "rm", "path": "...", "to": "..."}` (`rm` manda pra lixeira) |
| `GET /api/trash` / `POST /api/trash` | lista; `{"action": "restore" \| "purge" \| "empty", "id": "..."}` |
| `GET /raw/<caminho>` | o arquivo (`?dl=1` força download) |
| `GET /thumb/<caminho>` | miniatura WebP de imagem |

## 🚀 Subir do zero

Pré-requisitos no servidor: Docker com o plugin compose e o Caddy rodando no host como reverse proxy.

```bash
cd /root/opala/project/911
cp .env.example .env        # defina PASSWORD e um SECRET aleatório
docker compose up -d --build
```

Para gerar um segredo aleatório:

```bash
head -c 32 /dev/urandom | base64
```

Bloco no `/etc/caddy/Caddyfile` (troque o domínio pelo que for usar):

```caddy
911.premiumlts.com.br {
reverse_proxy 127.0.0.1:8084
}
```

```bash
caddy reload --config /etc/caddy/Caddyfile
```

DNS: registro **A** `911` apontando para o IP do servidor.

O Caddy não limita o tamanho do envio por padrão, então vídeo grande passa sem configurar nada.

### Checklist pós-deploy

- [ ] `curl -I http://127.0.0.1:8084/` responde `307` para `/login`
- [ ] o domínio abre com HTTPS válido
- [ ] login funciona com a senha do `.env`
- [ ] enviar um vídeo e conseguir pular pro meio dele

## 🔧 Manutenção

| Situação | Comando |
|---|---|
| mudou código ou `static/` | `docker compose up -d --build` |
| mudou o `.env` | `docker compose up -d` (**não** use `restart`: ele não relê o `.env`) |
| logs | `docker compose logs -f` |
| esvaziar miniaturas (são recriadas) | `rm -rf data/.thumbs/*` |
| backup | copiar a pasta `data/` inteira (ela não vai pro git) |

> ⚠️ `data/` **não** está no git (vídeo não cabe lá). O backup é por sua conta: `rsync`, `rclone` pra um storage, ou um disco externo.

## 🎨 Cores

Em variáveis CSS no `:root` de `index.html`. O vermelho é o *Guards Red* da Porsche.

| | |
|---|---|
| fundo | `#0c0c0d` |
| cartões | `#141416` |
| texto | `#ececee` |
| destaque | `#d5001c` |
