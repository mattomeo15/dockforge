import os
import shutil
import stat
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
        """Pull or clone a Git repository into the workspace directory, ensuring workspace is cleanly wiped first."""
        formatted_url = format_authed_github_url(repo_url, github_token)

        # Always wipe workspace completely before cloning a repository
        GitService.clear_workspace()

        try:
            repo = git.Repo.clone_from(formatted_url, WORKSPACE_DIR, branch=branch)
        except Exception as clone_err:
            logger.info(f"Clone with branch '{branch}' failed ({clone_err}), trying default branch...")
            GitService.clear_workspace()
            try:
                repo = git.Repo.clone_from(formatted_url, WORKSPACE_DIR)
            except Exception as clone_default_err:
                logger.error(f"Failed cloning repository {repo_url}: {clone_default_err}")
                raise RuntimeError(f"Git clone failed: {clone_default_err}")

        commit_sha = repo.head.commit.hexsha[:7] if repo.head else "unknown"
        return {
            "status": "success",
            "message": f"Successfully pulled repository ({branch})",
            "commit_sha": commit_sha,
            "path": str(WORKSPACE_DIR)
        }

    @staticmethod
    def load_tree_order() -> Dict[str, List[str]]:
        try:
            order_file = WORKSPACE_DIR / ".tree_order.json"
            if order_file.exists():
                return json.loads(order_file.read_text(encoding="utf-8"))
        except Exception as err:
            logger.error(f"Failed loading .tree_order.json: {err}")
        return {}

    @staticmethod
    def save_tree_order(order_map: Dict[str, List[str]]) -> None:
        try:
            order_file = WORKSPACE_DIR / ".tree_order.json"
            order_file.write_text(json.dumps(order_map, indent=2), encoding="utf-8")
        except Exception as err:
            logger.error(f"Failed saving .tree_order.json: {err}")

    @staticmethod
    def get_file_tree(base_path: Path = WORKSPACE_DIR, order_map: Optional[Dict[str, List[str]]] = None) -> List[Dict[str, Any]]:
        """Recursively scan workspace directory to generate file tree."""
        if not base_path.exists():
            return []
        if order_map is None:
            order_map = GitService.load_tree_order()

        tree = []
        ignored_names = {".git", "node_modules", "__pycache__", ".venv", "dist", ".DS_Store", ".tree_order.json"}

        try:
            rel_dir_path = "" if base_path == WORKSPACE_DIR else str(base_path.relative_to(WORKSPACE_DIR)).replace("\\", "/")
            dir_order = order_map.get(rel_dir_path, [])

            entries = list(base_path.iterdir())
            def sort_key(e: Path):
                idx = dir_order.index(e.name) if e.name in dir_order else 999999
                return (idx, not e.is_dir(), e.name.lower())

            for entry in sorted(entries, key=sort_key):
                if entry.name in ignored_names:
                    continue

                rel_path = str(entry.relative_to(WORKSPACE_DIR)).replace("\\", "/")
                if entry.is_dir():
                    tree.append({
                        "name": entry.name,
                        "path": rel_path,
                        "type": "folder",
                        "children": GitService.get_file_tree(entry, order_map)
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
    def create_folder(folder_path: str) -> None:
        """Create a directory in workspace recursively."""
        target_dir = (WORKSPACE_DIR / folder_path).resolve()
        if not target_dir.is_relative_to(WORKSPACE_DIR.resolve()):
            raise ValueError("Invalid target path")
        try:
            target_dir.mkdir(parents=True, exist_ok=True)
        except Exception as err:
            logger.error(f"Error creating folder {folder_path}: {err}")
            raise err

    @staticmethod
    def clear_workspace() -> None:
        """Clear all files in workspace directory."""
        try:
            if WORKSPACE_DIR.exists():
                def remove_readonly(func, path, _):
                    try:
                        os.chmod(path, stat.S_IWRITE | stat.S_IWUSR)
                        func(path)
                    except Exception:
                        pass

                shutil.rmtree(WORKSPACE_DIR, onerror=remove_readonly)
            WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
        except Exception as err:
            logger.error(f"Error clearing workspace: {err}")
            WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

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
    def move_path(old_path: str, new_path: str) -> None:
        """Move or rename a file or directory in workspace."""
        source = (WORKSPACE_DIR / old_path).resolve()
        target = (WORKSPACE_DIR / new_path).resolve()

        if not source.is_relative_to(WORKSPACE_DIR.resolve()) or not target.is_relative_to(WORKSPACE_DIR.resolve()):
            raise ValueError("Invalid file path outside workspace")
        if not source.exists():
            raise FileNotFoundError(f"Source item not found: {old_path}")
        if source == target:
            raise ValueError("Source and destination paths are identical")

        if source.is_dir():
            try:
                target.relative_to(source)
                raise ValueError("Cannot move a folder into its own subfolder")
            except ValueError:
                pass

        if target.exists():
            raise FileExistsError(f"Target path already exists: {new_path}")

        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(target))

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
