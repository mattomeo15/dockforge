import os
from pathlib import Path
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from backend.app.models import Base, UserDB, SettingsDB

DATA_DIR = Path(os.getenv("DATA_DIR", "./data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "dockforge.db"
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    """Initialize SQLite database with automatic table creation and column migrations."""
    Base.metadata.create_all(bind=engine)
    
    # Run safe column migrations for future schema additions
    with engine.connect() as conn:
        try:
            conn.execute(text("ALTER TABLE settings ADD COLUMN dockerhub_username VARCHAR(100)"))
            conn.commit()
        except Exception:
            pass  # Column already exists

        try:
            conn.execute(text("ALTER TABLE settings ADD COLUMN theme VARCHAR(20) DEFAULT 'dark'"))
            conn.commit()
        except Exception:
            pass
            
        try:
            conn.execute(text("ALTER TABLE build_jobs ADD COLUMN commit_sha VARCHAR(40)"))
            conn.commit()
        except Exception:
            pass

    # Ensure default admin user if no user exists
    db = SessionLocal()
    try:
        user_count = db.query(UserDB).count()
        if user_count == 0:
            from pwdlib import PasswordHash
            from pwdlib.hashers.bcrypt import BcryptHasher
            password_hash = PasswordHash((BcryptHasher(),))
            hashed_pwd = password_hash.hash("admin123")
            default_admin = UserDB(username="admin", hashed_password=hashed_pwd)
            db.add(default_admin)
            
            default_settings = SettingsDB(
                github_token="",
                dockerhub_username="",
                dockerhub_token=""
            )
            db.add(default_settings)
            db.commit()
    finally:
        db.close()
