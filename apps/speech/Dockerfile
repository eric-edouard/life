FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.7.7 /uv /bin/uv

WORKDIR /app
ENV MODEL_DIR=/models/ecapa \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

# The pinned model revision is baked into the image; the build fails if it doesn't embed.
COPY app.py test_app.py ./
RUN python app.py download && python -m unittest -v

EXPOSE 8000
CMD ["python", "app.py"]
