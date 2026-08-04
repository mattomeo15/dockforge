import httpx
from typing import List, Dict, Any, Optional

class DockerHubService:
    @staticmethod
    async def verify_credentials(username: str, token: str) -> bool:
        """Verify Docker Hub username and access token/password."""
        async with httpx.AsyncClient() as client:
            res = await client.post(
                "https://hub.docker.com/v2/users/login",
                json={"username": username, "password": token},
                timeout=10.0
            )
            return res.status_code == 200

    @staticmethod
    async def fetch_user_repos(username: str, token_or_password: str) -> List[Dict[str, Any]]:
        """Fetch repositories for a Docker Hub user namespace."""
        async with httpx.AsyncClient() as client:
            login_res = await client.post(
                "https://hub.docker.com/v2/users/login",
                json={"username": username, "password": token_or_password},
                timeout=10.0
            )
            if login_res.status_code != 200:
                raise RuntimeError("Failed to authenticate with Docker Hub")

            token = login_res.json().get("token")
            repos_res = await client.get(
                f"https://hub.docker.com/v2/namespaces/{username}/repositories?page_size=100",
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                timeout=10.0
            )
            if repos_res.status_code != 200:
                raise RuntimeError("Failed to fetch Docker Hub repositories")

            results = repos_res.json().get("results", [])
            return [
                {
                    "name": r.get("name"),
                    "namespace": r.get("namespace", username),
                    "full_name": f"{r.get('namespace', username)}/{r.get('name')}",
                    "is_private": bool(r.get("is_private")),
                    "star_count": r.get("star_count", 0),
                    "pull_count": r.get("pull_count", 0),
                    "last_updated": r.get("last_updated"),
                    "description": r.get("description", "")
                }
                for r in results
            ]

    @staticmethod
    async def fetch_image_tags(image_name: str) -> List[str]:
        """Fetch existing image tags for a repository on Docker Hub."""
        parts = image_name.split("/")
        if len(parts) == 1:
            namespace = "library"
            repo = parts[0]
        else:
            namespace = parts[0]
            repo = parts[1]

        url = f"https://hub.docker.com/v2/repositories/{namespace}/{repo}/tags"
        
        async with httpx.AsyncClient() as client:
            try:
                res = await client.get(url, params={"page_size": 20}, timeout=8.0)
                if res.status_code == 200:
                    data = res.json()
                    results = data.get("results", [])
                    return [item["name"] for item in results]
                return ["latest"]
            except Exception:
                return ["latest"]
