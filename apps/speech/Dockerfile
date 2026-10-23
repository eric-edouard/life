FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.7.7 /uv /bin/uv

WORKDIR /app
ENV MODEL_DIR=/models \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

COPY app.py test_app.py test_contract.py ./
RUN python -m unittest -v test_contract

# The models (about 3 GB) live in a volume at /models, fetched at the first start; later starts find
# them. The real test, by hand: docker run --rm -v <volume>:/models <image> python -m unittest -v
VOLUME /models
EXPOSE 8000
CMD ["sh", "-c", "python app.py download && exec python app.py"]
