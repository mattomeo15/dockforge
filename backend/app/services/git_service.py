import os
import shutil
import re
import logging
import git
from pathlib import Path
from typing import List, Dict, Any, Optional

logger = logging.getLogger("dockforge.git")

# Environment setup for non-interactive Git CLI operations
os.environ["GIT_TERMINAL_PROMPT"] = "0"
os.environ["GIT_ASKPASS"] = "echo"

# Resolve DATA_DIR properly
env_data_dir = os.getenv("DATA_DIR")
if env_data_dir:
    DATA_DIR = Path(env_data_dir).resolve()
elif os.path.exists("/app/data"):
    DATA_DIR = Path("/app/data").resolve()
else:
    DATA_DIR = Path("./data").resolve()

WORKSPACE_DIR = DATA_DIR / "workspace"

try:
    WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
except Exception as e:
    logger.error(f"Failed creating WORKSPACE_DIR at {WORKSPACE_DIR}: {e}")

def format_authed_github_url(url: str, token: Optional[str] = None) -> str:
    if not url:
        return url
    clean_url = url.strip()
    if not token or not token.strip():
        return clean_url
    pat = token.strip()

    if clean_url.startswith("git@github.com:"):
        repo_path = clean_url.replace("git@github.com:", "").rstrip(".git")
        return f"https://{pat}@github.com/{repo_path}.git"

    if "github.com" in clean_url:
        match = re.search(r"github\.com[/:]([^/]+)/([^/\s.]+?)(?:\.git)?$", clean_url)
        if match:
            owner, repo = match.group(1), match.group(2)
            return f"https://{pat}@github.com/{owner}/{repo}.git"

    return clean_url

class GitService:
    @staticmethod
    def pull_repository(repo_url: str, branch: str = "main", github_token: Optional[str] = None) -> Dict[str, Any]:
        """Pull or clone a Git repository into the workspace directory."""
        formatted_url = format_authed_github_url(repo_url, github_token)

        # If existing git repo, try pull first
        if (WORKSPACE_DIR / ".git").exists():
            try:
                repo = git.Repo(WORKSPACE_DIR)
                if github_token:
                    repo.remote("origin").set_url(formatted_url)
                repo.remotes.origin.pull(branch)
                commit_sha = repo.head.commit.hexsha[:7] if repo.head else "unknown"
                return {
                    "status": "success",
                    "message": f"Successfully pulled repository updates ({branch})",
                    "commit_sha": commit_sha,
                    "path": str(WORKSPACE_DIR)
                }
            except Exception as pull_err:
                logger.warning(f"Failed git pull in existing workspace ({pull_err}). Performing fresh clone...")

        try:
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
        except Exception as err:
            logger.error(f"Failed cloning repository {repo_url}: {err}")
            raise RuntimeError(f"Git clone failed: {err}")

    @staticmethod
    def get_file_tree(base_path: Path = WORKSPACE_DIR) -> List[Dict[str, Any]]:
        """Recursively scan workspace directory to generate file tree."""
        if not base_path.exists():
            return []

        tree = []
        ignored_names = {".git", "node_modules", "__pycache__", ".venv", "dist", ".DS_Store"}

        try:
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
        except Exception as err:
            logger.error(f"Error scanning file tree at {base_path}: {err}")
        return tree

    @staticmethod
    def read_file(file_path: str) -> str:
        """Read content of a workspace file."""
        target_file = (WORKSPACE_DIR / file_path).resolve()
        if not target_file.is_relative_to(WORKSPACE_DIR.resolve()) or not target_file.exists():
            raise FileNotFoundError("File not found in workspace")
        try:
            return target_file.read_text(encoding="utf-8", errors="replace")
        except Exception as err:
            logger.error(f"Error reading file {file_path}: {err}")
            raise err

    @staticmethod
    def write_file(file_path: str, content: str) -> None:
        """Write content to a workspace file."""
        target_file = (WORKSPACE_DIR / file_path).resolve()
        if not target_file.is_relative_to(WORKSPACE_DIR.resolve()):
            raise ValueError("Invalid target path")
        try:
            target_file.parent.mkdir(parents=True, exist_ok=True)
            target_file.write_text(content, encoding="utf-8")
        except Exception as err:
            logger.error(f"Error writing file {file_path}: {err}")
            raise err

    @staticmethod
    def delete_path(rel_path: str) -> None:
        """Delete a file or directory in workspace."""
        target = (WORKSPACE_DIR / rel_path).resolve()
        if not target.is_relative_to(WORKSPACE_DIR.resolve()) or not target.exists():
            raise FileNotFoundError("Path not found in workspace")
        try:
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
        except Exception as err:
            logger.error(f"Error deleting path {rel_path}: {err}")
            raise err

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
            authed_url = format_authed_github_url(url, github_token)
            origin.set_url(authed_url)

        origin = repo.remote("origin")
        push_info = origin.push(refspec=f"{branch}:{branch}")
        
        return {
            "status": "success",
            "message": f"Successfully pushed commit to {branch}",
            "commit_sha": repo.head.commit.hexsha[:7]
        }
