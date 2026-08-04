import re
from pathlib import Path

def sanitize_path(path_str: str) -> str:
    """Sanitize relative path strings to prevent path traversal attacks."""
    clean = re.sub(r'\.\./', '', path_str)
    clean = clean.lstrip('/')
    return clean

def get_file_extension(filename: str) -> str:
    """Return lowercase file extension or full name for special files like Dockerfile."""
    name_lower = filename.lower()
    if name_lower in ("dockerfile", "dockerfile.dev", "dockerfile.prod"):
        return "dockerfile"
    ext = Path(filename).suffix.lower()
    return ext.lstrip('.') if ext else "text"
