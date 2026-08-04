import uuid
import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from backend.app.database import init_db, get_db
from backend.app.models import (
    UserDB, SettingsDB, BuildJobDB,
    UserLogin, TokenResponse, SettingsSchema, TestConnectionRequest,
    RepoPullRequest, FileContentRequest, FileOperationRequest,
    GitPushRequest, DockerBuildRequest, DockerPushRequest, DockerHubTagRequest, CredentialsUpdate
)
from backend.app.services.auth_service import (
    verify_password, get_password_hash, create_access_token, get_current_user
)
from backend.app.services.git_service import GitService
from backend.app.services.docker_service import DockerService
from backend.app.services.dockerhub_service import DockerHubService

app = FastAPI(
    title="DockForge CI/CD API",
    description="Self-hosted Docker building & GitHub pipeline API",
    version="1.0.0"
)

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def on_startup():
    init_db()
    try:
        import subprocess
        subprocess.run(["git", "config", "--global", "--add", "safe.directory", "*"], check=False)
        print('✅ Configured Git global safe.directory "*" in FastAPI backend')
    except Exception as e:
        print(f"⚠️ Notice configuring git safe.directory in FastAPI: {e}")

# Health Check
@app.get("/api/health")
def health_check():
    return {"status": "ok", "app": "DockForge", "timestamp": datetime.datetime.utcnow().isoformat()}

# Authentication Routes
@app.post("/api/auth/login", response_model=TokenResponse)
def login(payload: UserLogin, db: Session = Depends(get_db)):
    user = db.query(UserDB).filter(UserDB.username == payload.username).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password"
        )
    token = create_access_token({"sub": user.username})
    return {"access_token": token, "token_type": "bearer"}

@app.get("/api/auth/me")
def get_me(current_user: UserDB = Depends(get_current_user)):
    return {"username": current_user.username, "created_at": current_user.created_at.isoformat()}

@app.get("/api/auth/credentials")
def get_credentials(current_user: UserDB = Depends(get_current_user)):
    return {"username": current_user.username}

@app.post("/api/auth/credentials")
def update_credentials(payload: CredentialsUpdate, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    if payload.username and payload.username.strip():
        new_un = payload.username.strip()
        existing = db.query(UserDB).filter(UserDB.username == new_un, UserDB.id != current_user.id).first()
        if existing:
            raise HTTPException(status_code=400, detail="Username is already in use.")
        current_user.username = new_un
    if payload.password and payload.password.strip():
        current_user.hashed_password = get_password_hash(payload.password.strip())
    db.commit()
    return {"status": "success", "message": "Credentials updated successfully", "username": current_user.username}

# GitHub Repos Endpoint
@app.get("/api/github/repos")
async def get_github_repos(db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    settings = db.query(SettingsDB).first()
    token = settings.github_token.strip() if (settings and settings.github_token) else None
    if not token:
        raise HTTPException(status_code=400, detail="GitHub Personal Access Token not configured in Settings.")
    
    current_repo = None
    try:
        import subprocess
        from backend.app.services.git_service import WORKSPACE_DIR
        proc = subprocess.run(["git", "remote", "get-url", "origin"], cwd=WORKSPACE_DIR, capture_output=True, text=True)
        if proc.returncode == 0:
            current_repo = proc.stdout.strip()
    except Exception:
        pass

    import httpx
    async with httpx.AsyncClient() as client:
        try:
            res = await client.get(
                "https://api.github.com/user/repos?sort=updated&per_page=100",
                headers={
                    "Authorization": f"Bearer {token}",
                    "User-Agent": "DockForge",
                    "Accept": "application/vnd.github+json"
                },
                timeout=10.0
            )
            if res.status_code != 200:
                err_msg = "Failed to fetch repositories from GitHub API"
                try:
                    err_data = res.json()
                    if isinstance(err_data, dict) and err_data.get("message"):
                        err_msg = err_data.get("message")
                except Exception:
                    pass
                raise HTTPException(status_code=res.status_code, detail=err_msg)

            repos_data = res.json()
            repos = [
                {
                    "name": r.get("name"),
                    "full_name": r.get("full_name"),
                    "clone_url": r.get("clone_url"),
                    "private": bool(r.get("private")),
                    "default_branch": r.get("default_branch", "main")
                }
                for r in repos_data
            ]
            return {"repos": repos, "current_repo": current_repo}
        except HTTPException:
            raise
        except Exception as err:
            raise HTTPException(status_code=500, detail=str(err))

# Settings Routes
@app.get("/api/settings")
def get_settings(db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    settings = db.query(SettingsDB).first()
    if not settings:
        return {"github_token": "", "dockerhub_username": "", "dockerhub_token": "", "theme": "dark"}
    return {
        "github_token": settings.github_token or "",
        "dockerhub_username": settings.dockerhub_username or "",
        "dockerhub_token": settings.dockerhub_token or "",
        "theme": settings.theme or "dark"
    }

@app.post("/api/settings")
def update_settings(payload: SettingsSchema, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    settings = db.query(SettingsDB).first()
    if not settings:
        settings = SettingsDB()
        db.add(settings)

    if payload.github_token is not None:
        settings.github_token = payload.github_token
    if payload.dockerhub_username is not None:
        settings.dockerhub_username = payload.dockerhub_username
    if payload.dockerhub_token is not None:
        settings.dockerhub_token = payload.dockerhub_token
    if payload.theme is not None:
        settings.theme = payload.theme

    # Handle optional account credentials update
    if payload.new_username and payload.new_username.strip():
        new_un = payload.new_username.strip()
        existing = db.query(UserDB).filter(UserDB.username == new_un, UserDB.id != current_user.id).first()
        if existing:
            raise HTTPException(status_code=400, detail="Username is already in use.")
        current_user.username = new_un

    if payload.new_password and payload.new_password.strip():
        current_user.hashed_password = get_password_hash(payload.new_password.strip())

    db.commit()
    return {"status": "success", "message": "Settings updated successfully", "username": current_user.username}

@app.post("/api/settings/test-connection")
async def test_connection(payload: TestConnectionRequest, current_user: UserDB = Depends(get_current_user)):
    if payload.type == "github":
        if not payload.token:
            raise HTTPException(status_code=400, detail="Token required")
        import httpx
        async with httpx.AsyncClient() as client:
            res = await client.get(
                "https://api.github.com/user",
                headers={"Authorization": f"Bearer {payload.token}"},
                timeout=5.0
            )
            if res.status_code == 200:
                user_data = res.json()
                return {"status": "success", "message": f"Connected as GitHub user '{user_data.get('login')}'"}
            raise HTTPException(status_code=400, detail="Invalid GitHub PAT")

    elif payload.type == "dockerhub":
        if not payload.username or not payload.token:
            raise HTTPException(status_code=400, detail="Username and Token required")
        ok = await DockerHubService.verify_credentials(payload.username, payload.token)
        if ok:
            return {"status": "success", "message": f"Connected to Docker Hub as '{payload.username}'"}
        raise HTTPException(status_code=400, detail="Invalid Docker Hub credentials")

    raise HTTPException(status_code=400, detail="Unknown connection type")

# Git Workspace Routes
@app.post("/api/repo/pull")
def pull_repository(payload: RepoPullRequest, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    settings = db.query(SettingsDB).first()
    gh_token = settings.github_token if settings else None
    
    try:
        res = GitService.pull_repository(payload.url, payload.branch or "main", gh_token)
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/files/tree")
@app.get("/api/workspace/tree")
def get_file_tree(current_user: UserDB = Depends(get_current_user)):
    return GitService.get_file_tree()

@app.get("/api/workspace/file")
def read_file(path: str, current_user: UserDB = Depends(get_current_user)):
    try:
        content = GitService.read_file(path)
        return {"path": path, "content": content}
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))

@app.post("/api/files/create")
@app.post("/api/workspace/file")
def create_or_save_file(payload: FileContentRequest, current_user: UserDB = Depends(get_current_user)):
    try:
        if payload.is_folder:
            GitService.create_folder(payload.path)
            return {"status": "success", "message": f"Folder created: {payload.path}"}
        else:
            GitService.write_file(payload.path, payload.content or "")
            return {"status": "success", "message": f"Saved {payload.path}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/mkdir")
def create_folder_route(payload: FileOperationRequest, current_user: UserDB = Depends(get_current_user)):
    try:
        GitService.create_folder(payload.path)
        return {"status": "success", "message": f"Folder created: {payload.path}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/files/delete")
@app.delete("/api/workspace/file")
def delete_file_route(path: str, current_user: UserDB = Depends(get_current_user)):
    try:
        GitService.delete_path(path)
        return {"status": "success", "message": f"Deleted {path}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/workspace/clear")
@app.delete("/api/workspace/clear")
def clear_workspace_route(current_user: UserDB = Depends(get_current_user)):
    try:
        GitService.clear_workspace()
        return {"status": "success", "message": "Workspace cleared successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/git/push")
@app.post("/api/repo/push")
def push_to_github(payload: GitPushRequest, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    settings = db.query(SettingsDB).first()
    gh_token = settings.github_token if settings else None
    msg = payload.commit_message or payload.message or "Update from DockForge"

    try:
        res = GitService.push_to_github(msg, payload.branch or "main", gh_token)
        return res
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Docker Hub Routes
@app.get("/api/dockerhub/repos")
async def fetch_dockerhub_repos(db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    settings = db.query(SettingsDB).first()
    dh_user = settings.dockerhub_username.strip() if (settings and settings.dockerhub_username) else None
    dh_token = settings.dockerhub_token.strip() if (settings and settings.dockerhub_token) else None

    if not dh_user or not dh_token:
        raise HTTPException(status_code=400, detail="Docker Hub username and token not configured in Settings.")

    try:
        repos = await DockerHubService.fetch_user_repos(dh_user, dh_token)
        return {"username": dh_user, "repos": repos}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/dockerhub/tags")
@app.post("/api/dockerhub/tags")
async def fetch_dockerhub_tags(
    repo: Optional[str] = None,
    payload: Optional[DockerHubTagRequest] = None,
    current_user: UserDB = Depends(get_current_user)
):
    target_image = repo or (payload.image_name if payload else None) or "dockforge"
    tags = await DockerHubService.fetch_image_tags(target_image)
    return {"image_name": target_image, "tags": tags}

# Docker Build & Push Routes
@app.get("/api/jobs")
def list_build_jobs(db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    jobs = db.query(BuildJobDB).order_by(BuildJobDB.started_at.desc()).all()
    return [
        {
            "id": j.id,
            "repo_url": j.repo_url,
            "image_name": j.image_name,
            "tag": j.tag,
            "status": j.status,
            "action": getattr(j, "action", "build") or "build",
            "job_type": getattr(j, "job_type", None) or getattr(j, "action", "build") or "build",
            "started_at": j.started_at.isoformat() if j.started_at else None,
            "completed_at": j.completed_at.isoformat() if j.completed_at else None,
            "commit_sha": j.commit_sha
        }
        for j in jobs
    ]

@app.get("/api/jobs/{job_id}/logs")
def get_job_logs(job_id: str, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    job = db.query(BuildJobDB).filter(BuildJobDB.id == job_id).first()
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    log_file = Path(job.log_file) if job.log_file else None
    if log_file and log_file.exists():
        return {"job_id": job_id, "logs": log_file.read_text(encoding="utf-8")}
    return {"job_id": job_id, "logs": "Log file not found."}

@app.post("/api/build")
@app.post("/api/jobs/build")
async def trigger_build_job(
    payload: DockerBuildRequest,
    db: Session = Depends(get_db),
    current_user: UserDB = Depends(get_current_user)
):
    if DockerService.is_building:
        raise HTTPException(status_code=400, detail="A build or push job is already running.")

    job_id = str(uuid.uuid4())
    log_file = str(Path("./data/logs") / f"{job_id}.log")

    image_name = payload.image_name or "dockforge"
    tag = payload.tag or "latest"
    if payload.target_image_tag and ":" in payload.target_image_tag:
        parts = payload.target_image_tag.split(":", 1)
        image_name = parts[0]
        tag = parts[1]
    elif payload.target_image_tag:
        image_name = payload.target_image_tag

    job = BuildJobDB(
        id=job_id,
        repo_url="workspace",
        image_name=image_name,
        tag=tag,
        action=payload.action or "build",
        job_type=payload.action or "build",
        status="building",
        log_file=log_file,
        started_at=datetime.datetime.utcnow()
    )
    db.add(job)
    db.commit()

    return {"job_id": job_id, "status": "started", "message": "Build job initiated"}

@app.post("/api/push")
@app.post("/api/jobs/push")
async def trigger_push_job(
    payload: DockerPushRequest,
    db: Session = Depends(get_db),
    current_user: UserDB = Depends(get_current_user)
):
    if DockerService.is_building:
        raise HTTPException(status_code=400, detail="A build or push job is already running.")

    job_id = str(uuid.uuid4())
    log_file = str(Path("./data/logs") / f"{job_id}.log")

    image_name = payload.image_name or "dockforge"
    tag = payload.tag or "latest"
    if payload.target_image_tag and ":" in payload.target_image_tag:
        parts = payload.target_image_tag.split(":", 1)
        image_name = parts[0]
        tag = parts[1]
    elif payload.target_image_tag:
        image_name = payload.target_image_tag

    job = BuildJobDB(
        id=job_id,
        repo_url="workspace",
        image_name=image_name,
        tag=tag,
        action="push",
        job_type="push",
        status="building",
        log_file=log_file,
        started_at=datetime.datetime.utcnow()
    )
    db.add(job)
    db.commit()

    return {"job_id": job_id, "status": "started", "message": "Push job initiated"}

# Real-time WebSocket Log Streaming Endpoint
@app.websocket("/ws/build/{job_id}")
async def websocket_build_logs(websocket: WebSocket, job_id: str, db: Session = Depends(get_db)):
    await websocket.accept()

    job = db.query(BuildJobDB).filter(BuildJobDB.id == job_id).first()
    if not job:
        await websocket.send_text(f"Job {job_id} not found.")
        await websocket.close()
        return

    settings = db.query(SettingsDB).first()
    dh_user = settings.dockerhub_username if settings else None
    dh_token = settings.dockerhub_token if settings else None

    async def log_callback(line: str):
        try:
            await websocket.send_text(line)
        except Exception:
            pass

    if getattr(job, "action", "build") == "push":
        success = await DockerService.push_stream(
            job_id=job.id,
            image_name=job.image_name,
            tag=job.tag,
            dockerhub_username=dh_user,
            dockerhub_token=dh_token,
            log_callback=log_callback
        )
    else:
        success = await DockerService.build_stream(
            job_id=job.id,
            image_name=job.image_name,
            tag=job.tag,
            dockerfile_path="Dockerfile",
            dockerhub_username=dh_user,
            log_callback=log_callback
        )

    # Update job status
    job.status = "success" if success else "failure"
    job.completed_at = datetime.datetime.utcnow()
    db.commit()

    await websocket.send_text(f"--- JOB {job_id} FINISHED WITH STATUS: {job.status.upper()} ---\n")
    await websocket.close()

# Mount Static Files and Serve SPA
frontend_dir = Path("frontend")
dist_dir = Path("dist")

if frontend_dir.exists():
    app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")
if (frontend_dir / "public").exists():
    app.mount("/public", StaticFiles(directory="frontend/public"), name="public")
if (frontend_dir / "css").exists():
    app.mount("/css", StaticFiles(directory="frontend/css"), name="css")
if (frontend_dir / "js").exists():
    app.mount("/js", StaticFiles(directory="frontend/js"), name="js")
if dist_dir.exists() and (dist_dir / "assets").exists():
    app.mount("/assets", StaticFiles(directory="dist/assets"), name="dist_assets")

@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("ws/"):
        raise HTTPException(status_code=404, detail="Not Found")
    
    if full_path:
        # Check logo.png alias
        if full_path == "logo.png" and (frontend_dir / "public/logo.png").is_file():
            return FileResponse(frontend_dir / "public/logo.png")

        # 1. Check inside dist_dir
        if dist_dir.exists():
            file_dist = dist_dir / full_path
            if file_dist.is_file():
                return FileResponse(file_dist)
        
        # 2. Check inside frontend_dir
        if frontend_dir.exists():
            file_frontend = frontend_dir / full_path
            if file_frontend.is_file():
                return FileResponse(file_frontend)

        # 3. Check in project root
        file_root = Path(full_path)
        if file_root.is_file():
            return FileResponse(file_root)

    # Fallback SPA index.html
    if dist_dir.exists() and (dist_dir / "index.html").exists():
        return FileResponse(dist_dir / "index.html")
    if frontend_dir.exists() and (frontend_dir / "index.html").exists():
        return FileResponse(frontend_dir / "index.html")
    if Path("index.html").exists():
        return FileResponse("index.html")

    return {"message": "DockForge API Server is Running"}

