FROM ghcr.io/astral-sh/uv:python3.13-alpine
# ffmpeg junta o vídeo e o áudio que o YouTube manda separados; o deno resolve o desafio de JS do YouTube
RUN apk add --no-cache ffmpeg deno
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen
COPY app.py ./
COPY static ./static
# só o Caddy (via 127.0.0.1) alcança a porta, então dá pra confiar no X-Forwarded-For
CMD ["uv", "run", "--no-sync", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
