import os
import shutil
import git
from pathlib import Path
from typing import List, Dict, Any, Optional

DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
WORKSPACE_DIR = DATA_DIR / "workspace"
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

class GitService:
    @staticmethod
    def pull_repository(repo_url: str, branch: str = "main", github_token: Optional[str] = None) -> Dict[str, Any]:
        """Pull or clone a Git repository into the workspace directory."""
        formatted_url = repo_url.strip()
        
        # Inject GitHub token into URL if private repo
        if github_token and "github.com" in formatted_url and not "@github.com" in formatted_url:
            formatted_url = formatted_url.replace("https://", f"https://x-access-token:{github_token}@")
        
        if WORKSPACE_DIR.exists():
            shutil.rmtree(WORKSPACE_DIR, ignore_errors=True)
        WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

        repo = git.Repo.clone_from(formatted_url, WORKSPACE_DIR, branch=branch)
        
        commit_sha = repo.head.commit.hexsha[:7] if repo.head else "unknown"
        return {
            "status": "success",
            "message": f"Successfully pulled repository ({branch})",
            "commit_sha": commit_sha,
            "path": str(WORKSPACE_DIR)
        }

    @staticmethod
    def get_file_tree(base_path: Path = WORKSPACE_DIR) -> List[Dict[str, Any]]:
        """Recursively scan workspace directory to generate file tree."""
        if not base_path.exists():
            return []

        tree = []
        ignored_names = {".git", "node_modules", "__pycache__", ".venv", "dist", ".DS_Store"}

        for entry in sorted(base_path.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.name in ignored_names:
                continue

            rel_path = str(entry.relative_to(WORKSPACE_DIR))
            if entry.is_dir():
                tree.append({
                    "name": entry.name,
                    "path": rel_path,
                    "type": "folder",
                    "children": GitService.get_file_tree(entry)
                })
            else:
                tree.append({
                    "name": entry.name,
                    "path": rel_path,
                    "type": "file",
                    "size": entry.stat().st_size
                })
        return tree

    @staticmethod
    def read_file(file_path: str) -> str:
        """Read content of a workspace file."""
        target_file = (WORKSPACE_DIR / file_path).resolve()
        if not target_file.is_relative_to(WORKSPACE_DIR.resolve()) or not target_file.exists():
            raise FileNotFoundError("File not found in workspace")
        return target_file.read_text(encoding="utf-8", errors="replace")

    @staticmethod
    def write_file(file_path: str, content: str) -> None:
        """Write content to a workspace file."""
        target_file = (WORKSPACE_DIR / file_path).resolve()
        if not target_file.is_relative_to(WORKSPACE_DIR.resolve()):
            raise ValueError("Invalid target path")
        target_file.parent.mkdir(parents=True, exist_ok=True)
        target_file.write_text(content, encoding="utf-8")

    @staticmethod
    def delete_path(rel_path: str) -> None:
        """Delete a file or directory in workspace."""
        target = (WORKSPACE_DIR / rel_path).resolve()
        if not target.is_relative_to(WORKSPACE_DIR.resolve()) or not target.exists():
            raise FileNotFoundError("Path not found in workspace")
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()

    @staticmethod
    def push_to_github(commit_message: str, branch: str = "main", github_token: Optional[str] = None) -> Dict[str, Any]:
        """Stage all workspace changes, commit, and push to origin."""
        repo = git.Repo(WORKSPACE_DIR)
        
        # Configure author
        with repo.config_writer() as git_config:
            git_config.set_value('user', 'name', 'DockForge CI/CD')
            git_config.set_value('user', 'email', 'dockforge@selfhosted.local')

        repo.git.add(A=True)
        if not repo.is_dirty(index=True):
            return {"status": "no_changes", "message": "No local changes to commit."}

        repo.index.commit(commit_message)
        
        # Set authenticated remote URL if token provided
        if github_token:
            origin = repo.remote("origin")
            url = origin.url
            if "github.com" in url and not "@github.com" in url:
                authed_url = url.replace("https://", f"https://x-access-token:{github_token}@")
                origin.set_url(authed_url)

        origin = repo.remote("origin")
        push_info = origin.push(refspec=f"{branch}:{branch}")
        
        return {
            "status": "success",
            "message": f"Successfully pushed commit to {branch}",
            "commit_sha": repo.head.commit.hexsha[:7]
        }
