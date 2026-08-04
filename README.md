# 🛠️ DockForge | Self-Hosted Web CI/CD Pipeline & In-Browser Docker IDE

DockForge is a self-hosted, lightweight web-based CI/CD pipeline and IDE. It enables developers to pull GitHub repositories, edit files using a browser-based Monaco Code Editor, manually commit & push back to GitHub, compile Docker images locally via the host's Docker socket, and push images directly to Docker Hub with real-time streaming build logs.

---

## ✨ Features

- **🌓 Dynamic Light/Dark Theme**: Toggle between Light and Dark visual themes with instant persistent sync to both Tailwind CSS styles and Monaco Editor (`vs` vs `vs-dark`).
- **🔐 Secure Single-User Authentication**: SQLite-backed authentication with hashed passwords (bcrypt) and JWT session tokens.
- **📁 Git Workspace Manager**:
  - Pull public Git repositories or private repositories using saved GitHub PAT credentials.
  - Interactive file explorer with expand/collapse folders, file creation, renaming, and deletion.
  - Direct commit and push back to GitHub with custom commit messages.
- **💻 Monaco Code Editor**: Full VS Code editing experience in your browser with multi-file tabs and auto syntax highlighting.
- **🐳 Docker Hub Tag Lookup & Image Builder**:
  - Automatically fetches existing tags for target images on Docker Hub to assist selection or tag creation.
  - Real-time streaming build logs via WebSocket (`ws://`) during `docker build` and `docker push`.
  - Concurrency control with job status history persisted in SQLite.

---

## 🚀 Quickstart with Docker Compose

1. **Clone the project repository:**
   ```bash
   git clone https://github.com/yourusername/dockforge.git
   cd dockforge
   ```

2. **Start the container stack:**
   ```bash
   docker-compose up -d
   ```

3. **Access DockForge:**
   Open your browser and navigate to `http://localhost:3000`.
   Default Admin Credentials:
   - **Username:** `admin`
   - **Password:** `admin123`

---

## ⚓ Deployment via Portainer

1. Open **Portainer** -> **Stacks** -> **Add Stack**.
2. Name your stack `dockforge`.
3. Paste the contents of `docker-compose.yml`:
   ```yaml
   version: '3.8'
   services:
     dockforge:
       image: dockforge:latest
       container_name: dockforge
       restart: unless-stopped
       ports:
         - "3000:3000"
       environment:
         - PUID=1000
         - PGID=1000
         - TZ=UTC
         - SECRET_KEY=dockforge_super_secret_jwt_key_2026
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock
         - ./data:/app/data
   ```
4. Click **Deploy the stack**.

---

## 🔑 Credential Setup Guide

### 1. GitHub Personal Access Token (PAT)
- Go to GitHub -> **Settings** -> **Developer Settings** -> **Personal Access Tokens**.
- Generate a token with `repo` scope permissions.
- Paste the token into DockForge **Settings** -> **GitHub Token** and click **Test Connection**.

### 2. Docker Hub Credentials
- Go to Docker Hub -> **Account Settings** -> **Security** -> **New Access Token**.
- Generate a token with Read/Write permissions.
- Paste your Docker Hub Username and Token into DockForge **Settings** -> **Docker Hub Credentials** and click **Test Connection**.

---

## 📂 Architecture

```
project-root/
├── backend/
│   ├── app/
│   │   ├── main.py              # API routes & WebSockets
│   │   ├── database.py          # SQLite setup & safe migrations
│   │   ├── models.py            # Data schemas
│   │   ├── services/            # Git, Docker, Auth & Docker Hub services
│   │   └── utils/               # Helper routines
│   └── requirements.txt
├── frontend/
│   ├── index.html               # Main SPA view
│   ├── css/                     # Tailwind & custom CSS
│   └── js/                      # Frontend script
├── data/                        # Persistent SQLite DB, workspace, and build logs
├── docker-compose.yml           # Production stack configuration
├── Dockerfile                   # Container build recipe
└── README.md
```
