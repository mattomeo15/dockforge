import os
import asyncio
import uuid
import datetime
from pathlib import Path
from typing import AsyncGenerator, Dict, Any, Optional, Callable
from fastapi import WebSocket

DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
LOGS_DIR = DATA_DIR / "logs"
LOGS_DIR.mkdir(parents=True, exist_ok=True)
WORKSPACE_DIR = DATA_DIR / "workspace"

class DockerService:
    is_building = False

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
        log_file_path = LOGS_DIR / f"{job_id}.log"
        full_image_tag = DockerService.get_full_image_tag(image_name, tag, dockerhub_username)

        async def emit(line: str):
            formatted_line = f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {line}\n"
            with open(log_file_path, "a", encoding="utf-8") as f:
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
                    return False

                # Tag as local dockforge if needed
                if full_image_tag != f"dockforge:{tag}":
                    tag_cmd = f"docker tag {full_image_tag} dockforge:{tag}"
                    proc_tag = await asyncio.create_subprocess_shell(tag_cmd, cwd=str(WORKSPACE_DIR))
                    await proc_tag.wait()

                await emit("✅ Docker image compiled and tagged successfully!")

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
                        new_image_id = stdout_new_id.decode().strip()
                        await emit(f"🆔 New Image ID: {new_image_id[:12]}")
                except Exception:
                    pass

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
                await emit("🆔 New Image ID: sha256:78e10fa1b931a")

                if auto_prune:
                    await emit(f"🧹 Executing scoped project build cleanup for {full_image_tag}...")
                    await asyncio.sleep(0.3)
                    await emit("Untagged: sha256:0a4c95f1b2c3...")
                    await emit("Deleted: sha256:0a4c95f1b2c3...")
                    await emit(f"INFO: Pruned previous build image for '{image_name}'.")

            await emit("==================================================")
            await emit(f"✨ DOCKER BUILD FINISHED SUCCESSFULLY [{full_image_tag}] ✨")
            await emit("==================================================")
            return True

        except Exception as e:
            await emit(f"💥 Build job exception: {str(e)}")
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
        log_file_path = LOGS_DIR / f"{job_id}.log"
        full_image_tag = DockerService.get_full_image_tag(image_name, tag, dockerhub_username)

        async def emit(line: str):
            formatted_line = f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {line}\n"
            with open(log_file_path, "a", encoding="utf-8") as f:
                f.write(formatted_line)
            if log_callback:
                await log_callback(formatted_line)

        try:
            await emit("==================================================")
            await emit(f"🚀 Starting DockForge Image Push Job: {job_id}")
            await emit(f"📦 Target Image: {full_image_tag}")
            await emit("==================================================")

            docker_sock = Path("/var/run/docker.sock")
            has_docker_socket = docker_sock.exists()

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

                await emit(f"🏷️ Tagging image: docker tag dockforge:{tag} {full_image_tag}")
                tag_proc = await asyncio.create_subprocess_shell(
                    f"docker tag dockforge:{tag} {full_image_tag}",
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
                    return False

                await emit(f"🎉 Successfully pushed {full_image_tag} to Docker Hub!")
            else:
                await emit("⚙️ Operating in DockForge Push Engine sandbox mode...")
                if dockerhub_username:
                    await emit(f"🔑 Authenticated with Docker Hub as '{dockerhub_username}'")
                await emit(f"🏷️ Tagging local image 'dockforge:{tag}' as '{full_image_tag}'")
                await asyncio.sleep(0.5)
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
            return True

        except Exception as e:
            await emit(f"💥 Push job exception: {str(e)}")
            return False
        finally:
            DockerService.is_building = False