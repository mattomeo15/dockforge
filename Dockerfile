# DockForge Production Dockerfile
FROM node:20-alpine AS frontend-builder
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npm run build

FROM python:3.11-slim
WORKDIR /app

# Install base packages, setup Docker repo, and clean cache immediately
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    gnupg \
    lsb-release \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Add Docker repo and install docker-ce-cli in a separate layer
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install Python requirements
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy built frontend and application code
COPY --from=frontend-builder /app/dist ./dist
COPY frontend ./frontend
COPY backend ./backend

EXPOSE 3000

ENV PORT=3000
ENV DATA_DIR=/app/backend/data

CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "3000"]
