import os
import zipfile
import uuid
import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect, status, File, UploadFile, Form
from fastapi.responses import FileResponse, StreamingResponse
import io
import tarfile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from backend.app.database import init_db, get_db
from backend.app.models import (
    UserDB, SettingsDB, BuildJobDB,
    UserLogin, TokenResponse, SettingsSchema, TestConnectionRequest,
    RepoPullRequest, FileContentRequest, FileOperationRequest, FileMoveRequest,
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
        return {"github_token": "", "dockerhub_username": "", "dockerhub_token": "", "theme": "dark", "auto_prune_project_builds": True}
    return {
        "github_token": settings.github_token or "",
        "dockerhub_username": settings.dockerhub_username or "",
        "dockerhub_token": settings.dockerhub_token or "",
        "theme": settings.theme or "dark",
        "auto_prune_project_builds": settings.auto_prune_project_builds if settings.auto_prune_project_builds is not None else True
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
    if payload.auto_prune_project_builds is not None:
        settings.auto_prune_project_builds = payload.auto_prune_project_builds

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
@app.get("/api/workspace/files/raw/{file_path:path}")
def read_file(path: Optional[str] = None, file_path: Optional[str] = None, raw: bool = False, current_user: UserDB = Depends(get_current_user)):
    target_path = file_path or path
    if not target_path:
        raise HTTPException(status_code=400, detail="Path parameter required")
    is_raw_endpoint = file_path is not None or raw
    try:
        res = GitService.read_file(target_path, raw=is_raw_endpoint)
        if is_raw_endpoint and isinstance(res, dict) and "file_path" in res:
            return FileResponse(res["file_path"], media_type=res.get("mime_type"))
        if isinstance(res, dict):
            return res
        return {"path": target_path, "content": res}
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

@app.post("/api/workspace/upload")
async def upload_workspace_files(
    files: List[UploadFile] = File(...),
    paths: Optional[List[str]] = Form(None),
    current_user: UserDB = Depends(get_current_user)
):
    try:
        saved_count = 0
        for i, file in enumerate(files):
            rel_path = (paths[i] if paths and i < len(paths) and paths[i] else getattr(file, 'filename', '')) or 'uploaded_file'
            rel_path = rel_path.lstrip('/')
            if not rel_path:
                continue
            content = await file.read()
            target_file = (GitService.WORKSPACE_DIR / rel_path).resolve()
            if not target_file.is_relative_to(GitService.WORKSPACE_DIR.resolve()):
                continue
            target_file.parent.mkdir(parents=True, exist_ok=True)
            target_file.write_bytes(content)
            saved_count += 1
        return {"status": "success", "message": f"Successfully uploaded {saved_count} file(s)"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/files/delete")
@app.delete("/api/workspace/file")
@app.delete("/api/workspace/item")
@app.delete("/api/workspace/items")
def delete_file_route(path: str, current_user: UserDB = Depends(get_current_user)):
    try:
        GitService.delete_path(path)
        return {"status": "success", "message": f"Deleted {path}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/workspace/rename")
def rename_file_route(payload: Dict[str, Any], current_user: UserDB = Depends(get_current_user)):
    try:
        old_path = payload.get("old_path") or payload.get("src") or payload.get("oldPath")
        new_path = payload.get("new_path") or payload.get("dest") or payload.get("newPath")
        if not old_path or not new_path:
            raise HTTPException(status_code=400, detail="Both old_path and new_path parameters are required")
        GitService.move_path(old_path, new_path)
        return {"status": "success", "message": f"Renamed {old_path} to {new_path}", "old_path": old_path, "new_path": new_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/workspace/copy-paste")
def copy_paste_route(payload: Dict[str, Any], current_user: UserDB = Depends(get_current_user)):
    try:
        src_path = payload.get("src_path") or payload.get("src") or payload.get("path")
        dest_dir = payload.get("dest_dir") or payload.get("dest") or payload.get("target_dir") or ""
        if not src_path:
            raise HTTPException(status_code=400, detail="src_path parameter is required")
        new_path = GitService.copy_paste(src_path, dest_dir)
        return {"status": "success", "message": f"Copied {src_path} to {new_path}", "new_path": new_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/workspace/download-zip")
@app.get("/api/workspace/export-zip")
async def download_workspace_zip_endpoint(current_user: UserDB = Depends(get_current_user)):
    if not GitService.WORKSPACE_DIR.exists():
        raise HTTPException(status_code=404, detail="Workspace directory not found")

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for root, dirs, files in os.walk(GitService.WORKSPACE_DIR):
            for file in files:
                file_path = Path(root) / file
                if ".git" in file_path.parts or ".dockforge" in file_path.parts:
                    continue
                arcname = file_path.relative_to(GitService.WORKSPACE_DIR)
                zip_file.write(file_path, arcname)

    zip_buffer.seek(0)
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": "attachment; filename=workspace.zip"}
    )

@app.get("/api/workspace/download-folder")
async def download_workspace_folder_endpoint(path: str, current_user: UserDB = Depends(get_current_user)):
    target_folder = (GitService.WORKSPACE_DIR / path).resolve()
    if not target_folder.is_relative_to(GitService.WORKSPACE_DIR.resolve()) or not target_folder.exists() or not target_folder.is_dir():
        raise HTTPException(status_code=404, detail="Folder not found")

    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
        for root, dirs, files in os.walk(target_folder):
            for file in files:
                file_path = Path(root) / file
                arcname = file_path.relative_to(target_folder.parent)
                zip_file.write(file_path, arcname)

    zip_buffer.seek(0)
    folder_name = target_folder.name
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{folder_name}.zip"'}
    )

@app.get("/api/workspace/order")
def get_workspace_order(current_user: UserDB = Depends(get_current_user)):
    return GitService.load_tree_order()

@app.delete("/api/workspace/order")
def delete_workspace_order(current_user: UserDB = Depends(get_current_user)):
    try:
        GitService.save_tree_order({})
        return {"status": "success", "order_map": {}}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/workspace/order")
def save_workspace_order(payload: Dict[str, Any], current_user: UserDB = Depends(get_current_user)):
    try:
        if payload.get("reset") or payload.get("clear"):
            GitService.save_tree_order({})
            return {"status": "success", "order_map": {}}
        existing = GitService.load_tree_order()
        if "order_map" in payload and isinstance(payload["order_map"], dict):
            existing.update(payload["order_map"])
            GitService.save_tree_order(existing)
            return {"status": "success", "order_map": existing}
        elif "parent_path" in payload and isinstance(payload.get("order"), list):
            existing[payload["parent_path"]] = payload["order"]
            GitService.save_tree_order(existing)
            return {"status": "success", "order_map": existing}
        raise HTTPException(status_code=400, detail="Invalid order parameters")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/files/move")
@app.post("/api/workspace/move")
@app.patch("/api/workspace/move")
def move_file_route(payload: FileMoveRequest, current_user: UserDB = Depends(get_current_user)):
    try:
        old_p = payload.old_path or payload.src
        new_p = payload.new_path or payload.dest
        if not old_p or not new_p:
            raise HTTPException(status_code=400, detail="Both source (old_path) and target (new_path) parameters are required")
        GitService.move_path(old_p, new_p)
        return {"status": "success", "message": f"Moved {old_p} to {new_p}", "old_path": old_p, "new_path": new_p}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (ValueError, FileExistsError) as e:
        raise HTTPException(status_code=400, detail=str(e))
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
@app.get("/api/history")
@app.get("/api/images")
def list_build_history(db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    history = DockerService.load_image_history()
    result = []
    # Sort items by creation or reverse order so newest is first
    for img_id, item in list(history.items())[::-1]:
        target_tag = item.get("target_tag", "")
        img_name = target_tag.split(":")[0] if ":" in target_tag else target_tag
        tag_val = target_tag.split(":")[1] if ":" in target_tag else "latest"
        result.append({
            "id": img_id,
            "image_id": img_id,
            "target_tag": target_tag,
            "image_name": img_name,
            "tag": tag_val,
            "created": item.get("created"),
            "build_status": item.get("build_status", "SUCCESS"),
            "push_status": item.get("push_status"),
            "build_log": item.get("build_log"),
            "push_log": item.get("push_log"),
            "status": "success" if item.get("build_status") == "SUCCESS" else "failure",
            "action": "build"
        })
    return result

@app.get("/api/jobs/{job_id}/logs")
@app.get("/api/history/{job_id}/logs")
def get_job_logs(job_id: str, type: Optional[str] = None, db: Session = Depends(get_db), current_user: UserDB = Depends(get_current_user)):
    history = DockerService.load_image_history()
    item = history.get(job_id)
    if not item:
        for k, v in history.items():
            if k == job_id or v.get("image_id") == job_id or job_id in (v.get("build_log", ""), v.get("push_log", "")):
                item = v
                break

    logs_text = ""
    if item:
        if type == "build" and item.get("build_log"):
            p = LOGS_DIR / item["build_log"]
            if p.exists():
                logs_text = f"=== BUILD LOG [{item.get('image_id')}] ===\n" + p.read_text(encoding="utf-8")
        elif type == "push" and item.get("push_log"):
            p = LOGS_DIR / item["push_log"]
            if p.exists():
                logs_text = f"=== PUSH LOG [{item.get('image_id')}] ===\n" + p.read_text(encoding="utf-8")
        else:
            build_log_path = LOGS_DIR / item["build_log"] if item.get("build_log") else None
            push_log_path = LOGS_DIR / item["push_log"] if item.get("push_log") else None
            
            if build_log_path and build_log_path.exists():
                logs_text += f"=== BUILD LOG [{item.get('image_id')}] ===\n" + build_log_path.read_text(encoding="utf-8") + "\n"
            if push_log_path and push_log_path.exists():
                logs_text += f"\n=== PUSH LOG [{item.get('image_id')}] ===\n" + push_log_path.read_text(encoding="utf-8") + "\n"

    if not logs_text and type == "build":
        p = LOGS_DIR / f"{job_id}_build.log"
        if p.exists():
            logs_text = f"=== BUILD LOG [{job_id}] ===\n" + p.read_text(encoding="utf-8")

    if not logs_text and type == "push":
        p = LOGS_DIR / f"{job_id}_push.log"
        if p.exists():
            logs_text = f"=== PUSH LOG [{job_id}] ===\n" + p.read_text(encoding="utf-8")

    if not logs_text:
        candidate_files = list(LOGS_DIR.glob(f"*{job_id}*"))
        if candidate_files:
            logs_text = candidate_files[0].read_text(encoding="utf-8")

    if not logs_text:
        job = db.query(BuildJobDB).filter(BuildJobDB.id == job_id).first()
        if job and job.log_file and Path(job.log_file).exists():
            logs_text = Path(job.log_file).read_text(encoding="utf-8")

    if logs_text:
        return {"job_id": job_id, "logs": logs_text}
    
    return {"job_id": job_id, "logs": f"No {type or ''} logs recorded for this image."}

@app.get("/api/images/download/{image_id}")
async def download_image(image_id: str, current_user: UserDB = Depends(get_current_user)):
    history = DockerService.load_image_history()
    entry = history.get(image_id)
    if not entry:
        for k, v in history.items():
            if k == image_id or v.get("image_id") == image_id or v.get("target_tag") == image_id:
                entry = v
                break

    if not entry:
        raise HTTPException(status_code=404, detail="Image not found")

    target_tag = entry.get("target_tag", "dockforge:latest")
    filename = f"{image_id}.tar"

    docker_sock = Path("/var/run/docker.sock")
    if docker_sock.exists():
        proc = await asyncio.create_subprocess_exec(
            "docker", "save", target_tag,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        return StreamingResponse(
            proc.stdout,
            media_type="application/x-tar",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )
    else:
        # Sandbox mode - stream tar archive
        tar_stream = io.BytesIO()
        with tarfile.open(fileobj=tar_stream, mode="w") as tar:
            manifest_content = json.dumps([{"RepoTags": [target_tag], "Layers": []}]).encode("utf-8")
            tarinfo = tarfile.TarInfo(name="manifest.json")
            tarinfo.size = len(manifest_content)
            tar.addfile(tarinfo, io.BytesIO(manifest_content))
        tar_stream.seek(0)
        return StreamingResponse(
            tar_stream,
            media_type="application/x-tar",
            headers={"Content-Disposition": f"attachment; filename={filename}"}
        )

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
    auto_prune = settings.auto_prune_project_builds if (settings and settings.auto_prune_project_builds is not None) else True

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
            auto_prune=auto_prune,
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

if dist_dir.exists():
    if (dist_dir / "assets").exists():
        app.mount("/assets", StaticFiles(directory="dist/assets"), name="dist_assets")
    if (dist_dir / "frontend/public").exists():
        app.mount("/frontend/public", StaticFiles(directory="dist/frontend/public"), name="dist_frontend_public")
elif frontend_dir.exists():
    app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")
    if (frontend_dir / "public").exists():
        app.mount("/public", StaticFiles(directory="frontend/public"), name="public")
    if (frontend_dir / "css").exists():
        app.mount("/css", StaticFiles(directory="frontend/css"), name="css")
    if (frontend_dir / "js").exists():
        app.mount("/js", StaticFiles(directory="frontend/js"), name="js")

@app.get("/{full_path:path}")
def serve_spa(full_path: str):
    if full_path.startswith("api/") or full_path.startswith("ws/"):
        raise HTTPException(status_code=404, detail="Not Found")
    
    if full_path:
        # Check logo image & chime audio requests
        if full_path in ["logo.png", "public/logo.png", "frontend/public/logo.png", "assets/logo.png"]:
            logo_candidates = [
                dist_dir / "logo.png",
                dist_dir / "frontend/public/logo.png",
                dist_dir / "public/logo.png",
                dist_dir / "assets/logo.png",
                frontend_dir / "public/logo.png",
                frontend_dir / "logo.png",
                Path("frontend/public/logo.png"),
                Path("public/logo.png"),
                Path("logo.png")
            ]
            for candidate in logo_candidates:
                if candidate.is_file():
                    return FileResponse(candidate)

        if full_path in ["chime.wav", "public/chime.wav", "frontend/public/chime.wav", "assets/chime.wav"]:
            chime_candidates = [
                dist_dir / "chime.wav",
                dist_dir / "frontend/public/chime.wav",
                dist_dir / "public/chime.wav",
                dist_dir / "assets/chime.wav",
                frontend_dir / "public/chime.wav",
                frontend_dir / "chime.wav",
                Path("frontend/public/chime.wav"),
                Path("public/chime.wav"),
                Path("chime.wav")
            ]
            for candidate in chime_candidates:
                if candidate.is_file():
                    return FileResponse(candidate)

        # 1. Check inside dist_dir (highest priority when built)
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

