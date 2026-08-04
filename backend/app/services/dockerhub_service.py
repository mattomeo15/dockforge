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
