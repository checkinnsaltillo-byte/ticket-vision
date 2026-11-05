FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 zlib1g libbz2-1.0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir google-cloud-storage osmium
WORKDIR /app
COPY nacional.py osm_nacional.py ./
CMD ["python3", "-I", "nacional.py"]
