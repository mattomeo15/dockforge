from datetime import datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Boolean
from sqlalchemy.orm import declarative_base

Base = declarative_base()

# SQLAlchemy Database Models

class UserDB(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String(50), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)

class SettingsDB(Base):
    __tablename__ = "settings"

    id = Column(Integer, primary_key=True, index=True)
    github_token = Column(String(255), nullable=True)
    dockerhub_username = Column(String(100), nullable=True)
    dockerhub_token = Column(String(255), nullable=True)
    theme = Column(String(20), default="dark", nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class RepositoryDB(Base):
    __tablename__ = "repositories"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False)
    url = Column(String(255), nullable=False)
    branch = Column(String(100), default="main")
    local_path = Column(String(255), nullable=False)
    last_pulled_at = Column(DateTime, default=datetime.utcnow)

class BuildJobDB(Base):
    __tablename__ = "build_jobs"

    id = Column(String(36), primary_key=True)  # UUID
    repo_url = Column(String(255), nullable=False)
    image_name = Column(String(150), nullable=False)
    tag = Column(String(50), nullable=False)
    status = Column(String(20), default="queued")  # queued, building, pushing, success, failure
    log_file = Column(String(255), nullable=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)
    commit_sha = Column(String(40), nullable=True)


# Pydantic Schemas

class UserLogin(BaseModel):
    username: str
    password: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"

class SettingsSchema(BaseModel):
    github_token: Optional[str] = None
    dockerhub_username: Optional[str] = None
    dockerhub_token: Optional[str] = None
    theme: Optional[str] = "dark"
    new_username: Optional[str] = None
    new_password: Optional[str] = None

class TestConnectionRequest(BaseModel):
    type: str  # "github" or "dockerhub"
    token: Optional[str] = None
    username: Optional[str] = None

class RepoPullRequest(BaseModel):
    url: str
    branch: Optional[str] = "main"

class FileItem(BaseModel):
    name: str
    path: str
    type: str  # "file" or "folder"
    children: Optional[List['FileItem']] = None
    size: Optional[int] = None

class FileContentRequest(BaseModel):
    path: str
    content: Optional[str] = ""
    is_folder: Optional[bool] = False

class FileOperationRequest(BaseModel):
    path: str
    is_folder: Optional[bool] = False

class GitPushRequest(BaseModel):
    commit_message: Optional[str] = None
    message: Optional[str] = None
    branch: Optional[str] = "main"

class CredentialsUpdate(BaseModel):
    username: str
    password: str

class DockerBuildRequest(BaseModel):
    image_name: str
    tag: str
    dockerfile_path: Optional[str] = "Dockerfile"
    push_to_hub: bool = True

class DockerHubTagRequest(BaseModel):
    image_name: str

class BuildJobResponse(BaseModel):
    id: str
    repo_url: str
    image_name: str
    tag: str
    status: str
    started_at: str
    completed_at: Optional[str] = None
    commit_sha: Optional[str] = None
