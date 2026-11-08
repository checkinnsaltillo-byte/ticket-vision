FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 zlib1g libbz2-1.0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir google-cloud-storage osmium numpy pillow
WORKDIR /app
COPY nacional.py osm_nacional.py huellas_nacional.py ghsl_nacional.py worldcover_nacional.py inv_nacional.py hex_nacional.py colonias_nacional.py eic2025_municipal.json ./
CMD ["python3", "-I", "nacional.py"]
