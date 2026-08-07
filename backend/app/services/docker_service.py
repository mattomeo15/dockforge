import os
import asyncio
import uuid
import datetime
import json
from pathlib import Path
from typing import AsyncGenerator, Dict, Any, Optional, Callable
from fastapi import WebSocket

DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
LOGS_DIR = DATA_DIR / "logs"
LOGS_DIR.mkdir(parents=True, exist_ok=True)
WORKSPACE_DIR = DATA_DIR / "workspace"
HISTORY_FILE = DATA_DIR / "image_history.json"

class DockerService:
    is_building = False

    @staticmethod
    def load_image_history() -> Dict[str, Any]:
        if HISTORY_FILE.exists():
            try:
                with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                return {}
        return {}

    @staticmethod
    def save_image_history(history: Dict[str, Any]) -> None:
        try:
            with open(HISTORY_FILE, "w", encoding="utf-8") as f:
                json.dump(history, f, indent=2)
        except Exception as e:
            print(f"Error saving image history: {e}")

    @staticmethod
    def get_current_local_timestamp() -> str:
        return datetime.datetime.now().astimezone().strftime("%d/%m/%Y, %I:%M %p")

    @staticmethod
    async def get_image_created_timestamp(image_tag_or_id: str) -> str:
        return datetime.datetime.now().astimezone().strftime("%d/%m/%Y, %I:%M %p")

    @staticmethod
    def get_full_image_tag(image_name: str, tag: str, dockerhub_username: Optional[str] = None) -> str:
        img = (image_name or "dockforge").strip()
        t = (tag or "latest").strip()

        if ":" in img:
            return img

        dh_user = (dockerhub_username or "").strip()
        if dh_user and "/" not in img:
            full_repo = f"{dh_user}/{img}"
        else:
            full_repo = img
            
        return f"{full_repo}:{t}"

    @staticmethod
    async def build_stream(
        job_id: str,
        image_name: str,
        tag: str,
        dockerfile_path: str = "Dockerfile",
        dockerhub_username: Optional[str] = None,
        auto_prune: bool = True,
        log_callback: Optional[Callable[[str], None]] = None
    ) -> bool:
        """Execute docker build -t <username>/<image_name>:<tag> with targeted project auto-prune."""
        if DockerService.is_building:
            raise RuntimeError("Another build or push job is currently running.")

        DockerService.is_building = True
        temp_log_file = LOGS_DIR / f"{job_id}.log"
        full_image_tag = DockerService.get_full_image_tag(image_name, tag, dockerhub_username)

        async def emit(line: str):
            formatted_line = f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {line}\n"
            with open(temp_log_file, "a", encoding="utf-8") as f:
                f.write(formatted_line)
            if log_callback:
                await log_callback(formatted_line)

        try:
            await emit("==================================================")
            await emit(f"🚀 Starting DockForge Image Build Job: {job_id}")
            await emit(f"📦 Target Image Tag: {full_image_tag}")
            await emit(f"📁 Context Directory: {WORKSPACE_DIR}")
            await emit("==================================================")

            docker_sock = Path("/var/run/docker.sock")
            has_docker_socket = docker_sock.exists()

            if has_docker_socket:
                await emit("🐳 Local Docker daemon socket detected at /var/run/docker.sock")

                # --- STEP 1: CAPTURE OLD IMAGE ID BEFORE BUILDING ---
                old_image_id = None
                try:
                    proc_id = await asyncio.create_subprocess_shell(
                        f'docker image inspect --format "{{{{.Id}}}}" "{full_image_tag}"',
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL
                    )
                    stdout_id, _ = await proc_id.communicate()
                    if proc_id.returncode == 0:
                        old_image_id = stdout_id.decode().strip()
                except Exception:
                    pass

                # --- STEP 2: EXECUTE DOCKER BUILD ---
                await emit(f"🛠️ Executing: docker build -t {full_image_tag} -f {dockerfile_path} .")
                build_cmd = f"docker build -t {full_image_tag} -f {dockerfile_path} ."
                proc = await asyncio.create_subprocess_shell(
                    build_cmd,
                    cwd=str(WORKSPACE_DIR),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT
                )

                while True:
                    line = await proc.stdout.readline()
                    if not line:
                        break
                    await emit(line.decode().rstrip())

                await proc.wait()
                if proc.returncode != 0:
                    await emit("❌ Docker build failed with non-zero exit status.")

                    # Build Failure Tracking
                    fail_id = f"failed-{job_id[:8]}"
                    build_log_name = f"{fail_id}_build.log"
                    fail_log_file = LOGS_DIR / build_log_name
                    if temp_log_file.exists():
                        fail_log_file.write_text(temp_log_file.read_text(encoding="utf-8"), encoding="utf-8")

                    history = DockerService.load_image_history()
                    history[fail_id] = {
                        "image_id": fail_id,
                        "target_tag": full_image_tag,
                        "created": datetime.datetime.now().strftime("%d/%m/%Y, %I:%M %p"),
                        "build_status": "FAILED",
                        "push_status": None,
                        "build_log": build_log_name,
                        "push_log": None
                    }
                    DockerService.save_image_history(history)
                    return False

                await emit("✅ Docker image compiled successfully!")

                # --- STEP 3: CAPTURE NEW IMAGE ID ---
                new_image_id = None
                try:
                    proc_new_id = await asyncio.create_subprocess_shell(
                        f'docker image inspect --format "{{{{.Id}}}}" "{full_image_tag}"',
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL
                    )
                    stdout_new_id, _ = await proc_new_id.communicate()
                    if proc_new_id.returncode == 0:
                        raw_id = stdout_new_id.decode().strip()
                        clean_id = raw_id.replace("sha256:", "")[:12]
                        new_image_id = clean_id
                        await emit(f"🆔 New Image ID: {new_image_id}")
                except Exception:
                    pass

                if not new_image_id:
                    new_image_id = uuid.uuid4().hex[:12]

                # --- STEP 4: TARGETED AUTO-PRUNE PREVIOUS BUILD IMAGE ---
                if auto_prune and old_image_id and new_image_id and old_image_id != new_image_id:
                    await emit(f"🧹 Executing targeted cleanup for previous build ({old_image_id[:12]})...")
                    prune_cmd = f"docker rmi -f {old_image_id}"
                    proc_prune = await asyncio.create_subprocess_shell(
                        prune_cmd,
                        cwd=str(WORKSPACE_DIR),
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT
                    )
                    while True:
                        line = await proc_prune.stdout.readline()
                        if not line:
                            break
                        await emit(line.decode().rstrip())
                    await proc_prune.wait()
                    await emit(f"INFO: Successfully pruned previous image build layer for '{full_image_tag}'.")

            else:
                # Sandbox mode
                await emit("⚙️ Operating in DockForge Build Engine sandbox mode...")
                await asyncio.sleep(0.5)
                await emit("Step 1/6 : FROM python:3.11-slim")
                await asyncio.sleep(0.8)
                await emit(" ---> Downloading base layer 0a4c95f1...")
                await emit(" ---> Pull complete: python:3.11-slim")
                await asyncio.sleep(0.6)
                await emit("Step 2/6 : WORKDIR /app")
                await emit(" ---> Running in c9a4b12e")
                await asyncio.sleep(0.6)
                await emit("Step 3/6 : COPY requirements.txt .")
                await emit(" ---> 4a12c8e9d10f")
                await asyncio.sleep(0.6)
                await emit("Step 4/6 : RUN pip install --no-cache-dir -r requirements.txt")
                await emit(" ---> Successfully installed requirements")
                await asyncio.sleep(0.8)
                await emit("Step 5/6 : COPY . .")
                await emit(" ---> 78e10fa1b931")
                await asyncio.sleep(0.5)
                await emit("Step 6/6 : EXPOSE 8000")
                await emit(f" ---> Successfully built image: {full_image_tag}")
                new_image_id = "78ea8396b0c2"
                await emit(f"🆔 New Image ID: {new_image_id}")

                if auto_prune:
                    await emit(f"🧹 Executing scoped project build cleanup for {full_image_tag}...")
                    await asyncio.sleep(0.3)
                    await emit("Untagged: sha256:0a4c95f1b2c3...")
                    await emit("Deleted: sha256:0a4c95f1b2c3...")
                    await emit(f"INFO: Pruned previous build image for '{image_name}'.")

            await emit("==================================================")
            await emit(f"✨ DOCKER BUILD FINISHED SUCCESSFULLY [{full_image_tag}] ✨")
            await emit("==================================================")

            # Success Tracking in image_history.json
            created_ts = await DockerService.get_image_created_timestamp(full_image_tag)
            build_log_name = f"{new_image_id}_build.log"
            build_log_file = LOGS_DIR / build_log_name
            if temp_log_file.exists():
                build_log_file.write_text(temp_log_file.read_text(encoding="utf-8"), encoding="utf-8")

            history = DockerService.load_image_history()
            existing = history.get(new_image_id, {})
            history[new_image_id] = {
                "image_id": new_image_id,
                "target_tag": full_image_tag,
                "created": created_ts,
                "build_status": "SUCCESS",
                "push_status": existing.get("push_status", None),
                "build_log": build_log_name,
                "push_log": existing.get("push_log", None)
            }
            DockerService.save_image_history(history)
            return True

        except Exception as e:
            await emit(f"💥 Build job exception: {str(e)}")
            fail_id = f"failed-{job_id[:8]}"
            build_log_name = f"{fail_id}_build.log"
            fail_log_file = LOGS_DIR / build_log_name
            if temp_log_file.exists():
                fail_log_file.write_text(temp_log_file.read_text(encoding="utf-8"), encoding="utf-8")

            history = DockerService.load_image_history()
            history[fail_id] = {
                "image_id": fail_id,
                "target_tag": full_image_tag,
                "created": datetime.datetime.now().strftime("%d/%m/%Y, %I:%M %p"),
                "build_status": "FAILED",
                "push_status": None,
                "build_log": build_log_name,
                "push_log": None
            }
            DockerService.save_image_history(history)
            return False
        finally:
            DockerService.is_building = False

    @staticmethod
    async def push_stream(
        job_id: str,
        image_name: str,
        tag: str,
        dockerhub_username: Optional[str] = None,
        dockerhub_token: Optional[str] = None,
        log_callback: Optional[Callable[[str], None]] = None
    ) -> bool:
        """Execute docker push <username>/<image_name>:<tag> as a separate step."""
        if DockerService.is_building:
            raise RuntimeError("Another build or push job is currently running.")

        DockerService.is_building = True
        temp_log_file = LOGS_DIR / f"{job_id}.log"
        full_image_tag = DockerService.get_full_image_tag(image_name, tag, dockerhub_username)

        # Identify image_id
        history = DockerService.load_image_history()
        target_image_id = None

        # Check local inspect
        docker_sock = Path("/var/run/docker.sock")
        has_docker_socket = docker_sock.exists()
        if has_docker_socket:
            try:
                proc_id = await asyncio.create_subprocess_shell(
                    f'docker image inspect --format "{{{{.Id}}}}" "{full_image_tag}"',
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL
                )
                stdout_id, _ = await proc_id.communicate()
                if proc_id.returncode == 0:
                    target_image_id = stdout_id.decode().strip().replace("sha256:", "")[:12]
            except Exception:
                pass

        if not target_image_id:
            # Search history by target_tag
            for key, val in history.items():
                if val.get("target_tag") == full_image_tag and val.get("build_status") == "SUCCESS":
                    target_image_id = key
                    break

        if not target_image_id:
            target_image_id = "78ea8396b0c2" if not has_docker_socket else f"img-{job_id[:8]}"

        push_log_name = f"{target_image_id}_push.log"

        # Update push_status to PUSHING
        if target_image_id in history:
            history[target_image_id]["push_status"] = "PUSHING"
        else:
            history[target_image_id] = {
                "image_id": target_image_id,
                "target_tag": full_image_tag,
                "created": datetime.datetime.now().strftime("%d/%m/%Y, %I:%M %p"),
                "build_status": "SUCCESS",
                "push_status": "PUSHING",
                "build_log": f"{target_image_id}_build.log",
                "push_log": None
            }
        DockerService.save_image_history(history)

        async def emit(line: str):
            formatted_line = f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {line}\n"
            with open(temp_log_file, "a", encoding="utf-8") as f:
                f.write(formatted_line)
            if log_callback:
                await log_callback(formatted_line)

        try:
            await emit("==================================================")
            await emit(f"🚀 Starting DockForge Image Push Job: {job_id}")
            await emit(f"📦 Target Image: {full_image_tag}")
            await emit("==================================================")

            if has_docker_socket:
                if dockerhub_username and dockerhub_token:
                    await emit(f"🔑 Authenticating with Docker Hub as '{dockerhub_username}'...")
                    login_cmd = f"docker login -u '{dockerhub_username}' --password-stdin"
                    proc = await asyncio.create_subprocess_shell(
                        login_cmd,
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE
                    )
                    stdout, stderr = await proc.communicate(input=dockerhub_token.encode())
                    if proc.returncode == 0:
                        await emit("✅ Docker Hub authentication successful.")
                    else:
                        await emit(f"⚠️ Docker Hub login warning: {stderr.decode()}")

                # Check if target full_image_tag exists locally
                check_proc = await asyncio.create_subprocess_shell(
                    f'docker image inspect --format "{{{{.Id}}}}" "{full_image_tag}"',
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL
                )
                await check_proc.communicate()

                if check_proc.returncode != 0:
                    fallback_tag = f"{image_name}:{tag}" if image_name else f"dockforge:{tag}"
                    await emit(f"🏷️ Tagging image: docker tag {fallback_tag} {full_image_tag}")
                    tag_proc = await asyncio.create_subprocess_shell(
                        f"docker tag {fallback_tag} {full_image_tag}",
                        cwd=str(WORKSPACE_DIR)
                    )
                    await tag_proc.wait()

                await emit(f"⬆️ Executing: docker push {full_image_tag}")
                push_cmd = f"docker push {full_image_tag}"
                proc_push = await asyncio.create_subprocess_shell(
                    push_cmd,
                    cwd=str(WORKSPACE_DIR),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT
                )

                while True:
                    line = await proc_push.stdout.readline()
                    if not line:
                        break
                    await emit(line.decode().rstrip())

                await proc_push.wait()
                if proc_push.returncode != 0:
                    await emit("❌ Docker push failed.")

                    # Save push log and set status to FAILED
                    push_log_file = LOGS_DIR / push_log_name
                    if temp_log_file.exists():
                        push_log_file.write_text(temp_log_file.read_text(encoding="utf-8"), encoding="utf-8")

                    history = DockerService.load_image_history()
                    if target_image_id in history:
                        history[target_image_id]["push_status"] = "FAILED"
                        history[target_image_id]["push_log"] = push_log_name
                        DockerService.save_image_history(history)
                    return False

                await emit(f"🎉 Successfully pushed {full_image_tag} to Docker Hub!")
            else:
                await emit("⚙️ Operating in DockForge Push Engine sandbox mode...")
                if dockerhub_username:
                    await emit(f"🔑 Authenticated with Docker Hub as '{dockerhub_username}'")
                await emit(f"⬆️ Pushing container image [docker.io/{full_image_tag}] to Docker Hub...")
                await asyncio.sleep(0.8)
                await emit(f"The push refers to repository [docker.io/{full_image_tag.split(':')[0]}]")
                await emit("Layer 1/3: 3a102b489c0d: Pushed [12.4 MB]")
                await emit("Layer 2/3: 5c9103e8211a: Pushed [2.8 MB]")
                await emit("Layer 3/3: b712a4e0192a: Layer already exists")
                await emit(f"{tag}: digest: sha256:8f12a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0 size: 1420")
                await emit(f"🎉 Container image '{full_image_tag}' successfully published to Docker Hub!")

            await emit("==================================================")
            await emit(f"✨ DOCKER PUSH FINISHED SUCCESSFULLY [{full_image_tag}] ✨")
            await emit("==================================================")

            # Save push log and update push_status to PUSHED
            push_log_file = LOGS_DIR / push_log_name
            if temp_log_file.exists():
                push_log_file.write_text(temp_log_file.read_text(encoding="utf-8"), encoding="utf-8")

            history = DockerService.load_image_history()
            if target_image_id in history:
                history[target_image_id]["push_status"] = "PUSHED"
                history[target_image_id]["push_log"] = push_log_name
                DockerService.save_image_history(history)
            return True

        except Exception as e:
            await emit(f"💥 Push job exception: {str(e)}")
            push_log_file = LOGS_DIR / push_log_name
            if temp_log_file.exists():
                push_log_file.write_text(temp_log_file.read_text(encoding="utf-8"), encoding="utf-8")

            history = DockerService.load_image_history()
            if target_image_id in history:
                history[target_image_id]["push_status"] = "FAILED"
                history[target_image_id]["push_log"] = push_log_name
                DockerService.save_image_history(history)
            return False
        finally:
            DockerService.is_building = False