FROM python:3.13-slim
WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY speechmux_api/ speechmux_api/

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "speechmux_api.main:app", "--host", "0.0.0.0", "--port", "8000"]
