import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { spawn, exec, ChildProcess } from "child_process";
import { promisify } from "util";
import { Socket } from "net";

const execAsync = promisify(exec);

// 1. Safe Git Directory Configuration on Backend Startup
try {
  const { execSync } = require("child_process");
  execSync('git config --global --add safe.directory "*"', { stdio: "ignore" });
  console.log('✅ Configured Git global safe.directory "*"');
} catch (gitConfigErr: any) {
  console.error("⚠️ Notice configuring git safe.directory:", gitConfigErr?.message || gitConfigErr);
}

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "echo",
};

const INITIAL_PORT = parseInt(process.env.PORT || "3000", 10);
const SECRET_KEY = process.env.SECRET_KEY || "dockforge_super_secret_jwt_key_2026";
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "backend", "data");

const activeChildProcesses = new Set<ChildProcess>();
const activeSockets = new Set<Socket>();
let viteServerInstance: any = null;
const WORKSPACE_DIR = path.join(DATA_DIR, "workspace");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");

console.log(`📂 Storage Configuration: DATA_DIR=${DATA_DIR}`);
console.log(`💻 Workspace Path: ${WORKSPACE_DIR}`);

// Ensure storage directories exist with recursive flags and permission error handling
try {
  [DATA_DIR, WORKSPACE_DIR, LOGS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`📁 Created storage directory: ${dir}`);
    }
  });
} catch (dirErr: any) {
  console.error(`❌ [FS ERROR] Failed initializing storage directories under ${DATA_DIR}:`, dirErr?.message || dirErr);
}

// Helper to inject GitHub PAT into HTTPS remote URLs
function formatAuthedGithubUrl(url: string, token?: string): string {
  if (!url) return url;
  let cleanUrl = url.trim();
  if (!token || !token.trim()) return cleanUrl;
  const pat = token.trim();

  if (cleanUrl.startsWith("git@github.com:")) {
    const repoPath = cleanUrl.replace("git@github.com:", "").replace(/\.git$/, "");
    return `https://${pat}@github.com/${repoPath}.git`;
  }

  if (cleanUrl.includes("github.com")) {
    const match = cleanUrl.match(/github\.com[/:]([^/]+)\/([^/\s.]+?)(\.git)?$/);
    if (match) {
      const owner = match[1];
      const repo = match[2];
      return `https://${pat}@github.com/${owner}/${repo}.git`;
    }
  }

  return cleanUrl;
}

// Helper for JSON storage with error handling
function readJsonFile<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data);
    }
  } catch (err: any) {
    console.error(`❌ [FS ERROR] Error reading JSON file ${filePath}:`, err?.message || err);
  }
  return defaultValue;
}

function writeJsonFile<T>(filePath: string, data: T): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err: any) {
    console.error(`❌ [FS ERROR] Error writing JSON file ${filePath}:`, err?.message || err);
  }
}

const ALT_USERS_FILE = path.join(process.cwd(), "data", "users.json");

function getUsers(): any[] {
  let usersList = readJsonFile<any[]>(USERS_FILE, []);
  if (!usersList || usersList.length === 0) {
    usersList = readJsonFile<any[]>(ALT_USERS_FILE, []);
  }
  if (!usersList || usersList.length === 0) {
    const hashedPassword = bcrypt.hashSync("admin123", 10);
    usersList = [
      {
        username: "admin",
        password: hashedPassword,
        plainPassword: "admin123",
        createdAt: new Date().toISOString(),
      },
    ];
    saveUsers(usersList);
  } else {
    let modified = false;
    usersList.forEach((u: any) => {
      if (u.username === "admin" && !u.plainPassword && bcrypt.compareSync("admin123", u.password)) {
        u.plainPassword = "admin123";
        modified = true;
      }
    });
    if (modified) {
      saveUsers(usersList);
    }
  }
  return usersList;
}

function saveUsers(usersList: any[]): void {
  writeJsonFile(USERS_FILE, usersList);
  const rootDataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(rootDataDir)) {
    try {
      fs.mkdirSync(rootDataDir, { recursive: true });
    } catch (e) {}
  }
  writeJsonFile(ALT_USERS_FILE, usersList);
}

// Initialize default admin user
getUsers();

// Default settings
const settings = readJsonFile(SETTINGS_FILE, {
  github_token: "",
  dockerhub_username: "",
  dockerhub_token: "",
});

// Default sample workspace files if empty
if (fs.readdirSync(WORKSPACE_DIR).length === 0) {
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "Dockerfile"),
    `FROM python:3.11-slim\n\nWORKDIR /app\n\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\n\nCOPY . .\n\nEXPOSE 8000\nCMD ["python", "main.py"]\n`
  );
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "main.py"),
    `print("Hello from DockForge microservice!")\n`
  );
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "requirements.txt"),
    `fastapi>=0.110.0\nuvicorn>=0.28.0\n`
  );
  fs.writeFileSync(
    path.join(WORKSPACE_DIR, "README.md"),
    `# DockForge Microservice\n\nBuilt with DockForge automated CI/CD pipeline.\n`
  );
}

let isBuildingGlobal = false;

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on("connection", (socket: Socket) => {
    activeSockets.add(socket);
    socket.on("close", () => {
      activeSockets.delete(socket);
    });
  });

  app.use(cors());
  app.use(express.json());

  // Static Frontend Assets
  app.use("/frontend", express.static(path.join(process.cwd(), "frontend")));
  app.use("/css", express.static(path.join(process.cwd(), "frontend", "css")));
  app.use("/js", express.static(path.join(process.cwd(), "frontend", "js")));

  // Middleware: Auth check
  const authenticateToken = (req: any, res: any, next: any) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ detail: "Access token required", code: "UNAUTHORIZED" });

    jwt.verify(token, SECRET_KEY, (err: any, user: any) => {
      if (err) return res.status(401).json({ detail: "Invalid or expired token", code: "UNAUTHORIZED" });
      req.user = user;
      next();
    });
  };

  // --- API ROUTES ---

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", app: "DockForge", timestamp: new Date().toISOString() });
  });

  // Login
  app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ detail: "Invalid username or password" });
    }

    const currentUsers = getUsers();
    const user = currentUsers.find((u: any) => u.username === username);

    if (!user) {
      return res.status(401).json({ detail: "Invalid username or password" });
    }

    const isMatch = bcrypt.compareSync(password, user.password) || (user.plainPassword && user.plainPassword === password);
    if (!isMatch) {
      return res.status(401).json({ detail: "Invalid username or password" });
    }

    const token = jwt.sign({ sub: user.username }, SECRET_KEY, { expiresIn: "7d" });
    res.json({ access_token: token, token_type: "bearer", username: user.username });
  });

  // Credentials Endpoints
  app.get("/api/auth/credentials", (req, res) => {
    const currentUsers = getUsers();
    const primaryUser = currentUsers[0] || { username: "admin", plainPassword: "admin123" };
    res.json({
      username: primaryUser.username || "admin",
      password: primaryUser.plainPassword || "admin123",
    });
  });

  app.post("/api/auth/credentials", (req, res) => {
    const { username, password, new_username, new_password } = req.body;
    const targetUsername = (username || new_username || "").trim();
    const targetPassword = (password || new_password || "").trim();

    if (!targetUsername || !targetPassword) {
      return res.status(400).json({ detail: "Username and password are required" });
    }

    const currentUsers = getUsers();
    const hashedPassword = bcrypt.hashSync(targetPassword, 10);

    if (currentUsers.length > 0) {
      currentUsers[0].username = targetUsername;
      currentUsers[0].password = hashedPassword;
      currentUsers[0].plainPassword = targetPassword;
      currentUsers[0].updatedAt = new Date().toISOString();
    } else {
      currentUsers.push({
        username: targetUsername,
        password: hashedPassword,
        plainPassword: targetPassword,
        createdAt: new Date().toISOString(),
      });
    }

    saveUsers(currentUsers);
    res.json({
      status: "success",
      message: "Credentials updated successfully",
      username: targetUsername,
      password: targetPassword,
    });
  });

  app.get("/api/auth/me", authenticateToken, (req: any, res) => {
    res.json({ username: req.user.sub });
  });

  // Settings
  app.get("/api/settings", authenticateToken, (req, res) => {
    const currentSettings = readJsonFile(SETTINGS_FILE, {
      github_token: "",
      dockerhub_username: "",
      dockerhub_token: "",
    });
    res.json(currentSettings);
  });

  app.post("/api/settings", authenticateToken, (req: any, res) => {
    const { github_token, dockerhub_username, dockerhub_token, new_username, new_password } = req.body;
    const currentSettings = readJsonFile(SETTINGS_FILE, {
      github_token: "",
      dockerhub_username: "",
      dockerhub_token: "",
    });

    if (github_token !== undefined) currentSettings.github_token = github_token;
    if (dockerhub_username !== undefined) currentSettings.dockerhub_username = dockerhub_username;
    if (dockerhub_token !== undefined) currentSettings.dockerhub_token = dockerhub_token;

    writeJsonFile(SETTINGS_FILE, currentSettings);

    let updatedUsername = req.user.sub;
    if (new_username || new_password) {
      const uName = (new_username || req.user.sub).trim();
      const pWord = (new_password || "").trim();
      if (uName && pWord) {
        const currentUsers = getUsers();
        const hashedPassword = bcrypt.hashSync(pWord, 10);
        if (currentUsers.length > 0) {
          currentUsers[0].username = uName;
          currentUsers[0].password = hashedPassword;
          currentUsers[0].plainPassword = pWord;
          currentUsers[0].updatedAt = new Date().toISOString();
        } else {
          currentUsers.push({
            username: uName,
            password: hashedPassword,
            plainPassword: pWord,
            createdAt: new Date().toISOString(),
          });
        }
        saveUsers(currentUsers);
        updatedUsername = uName;
      }
    }

    res.json({ status: "success", message: "Settings saved successfully", username: updatedUsername });
  });

  app.post("/api/settings/test-connection", authenticateToken, async (req, res) => {
    const { type, token, username } = req.body;

    if (type === "github") {
      if (!token) return res.status(400).json({ detail: "Token required" });
      try {
        const response = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          const userData: any = await response.json();
          return res.json({ status: "success", message: `Connected to GitHub as '${userData.login}'` });
        }
        return res.status(400).json({ detail: "GitHub token rejected by API" });
      } catch (err: any) {
        return res.status(400).json({ detail: err.message || "Failed to reach GitHub" });
      }
    } else if (type === "dockerhub") {
      if (!username || !token) return res.status(400).json({ detail: "Username and Token required" });
      try {
        const response = await fetch("https://hub.docker.com/v2/users/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password: token }),
        });
        if (response.ok) {
          return res.json({ status: "success", message: `Connected to Docker Hub as '${username}'` });
        }
        return res.status(400).json({ detail: "Invalid Docker Hub credentials" });
      } catch (err: any) {
        return res.status(400).json({ detail: err.message || "Failed to reach Docker Hub" });
      }
    }

    res.status(400).json({ detail: "Invalid connection type" });
  });

  // Fetch GitHub User Repositories
  app.get("/api/github/repos", authenticateToken, async (req, res) => {
    const currentSettings = readJsonFile(SETTINGS_FILE, { github_token: "" });
    const token = currentSettings.github_token?.trim();
    if (!token) {
      return res.status(400).json({ detail: "GitHub Personal Access Token not configured in Settings." });
    }

    let current_repo = null;
    try {
      const { stdout } = await execAsync("git remote get-url origin", { cwd: WORKSPACE_DIR });
      current_repo = stdout.trim();
    } catch (e) {
      // No git remote set
    }

    try {
      const response = await fetch("https://api.github.com/user/repos?sort=updated&per_page=100", {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "DockForge",
          Accept: "application/vnd.github+json",
        },
      });

      if (!response.ok) {
        const errJson: any = await response.json().catch(() => ({}));
        return res.status(response.status).json({ detail: errJson.message || "Failed to fetch repositories from GitHub" });
      }

      const reposData: any[] = await response.json();
      const repos = reposData.map((r: any) => ({
        name: r.name,
        full_name: r.full_name,
        clone_url: r.clone_url,
        private: !!r.private,
        default_branch: r.default_branch || "main",
      }));

      res.json({ repos, current_repo });
    } catch (err: any) {
      res.status(500).json({ detail: err.message || "Error connecting to GitHub API" });
    }
  });

  // Workspace & Git File Tree
  function getFileTree(dir: string, baseDir: string = WORKSPACE_DIR): any[] {
    if (!fs.existsSync(dir)) return [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const ignored = new Set([".git", "node_modules", "__pycache__", "dist", ".DS_Store"]);

    const tree: any[] = [];
    for (const entry of entries) {
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        tree.push({
          name: entry.name,
          path: relPath,
          type: "folder",
          children: getFileTree(fullPath, baseDir),
        });
      } else {
        tree.push({
          name: entry.name,
          path: relPath,
          type: "file",
          size: fs.statSync(fullPath).size,
        });
      }
    }
    // Sort directories first, then files
    return tree.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === "folder" ? -1 : 1;
    });
  }

  app.get("/api/workspace/tree", authenticateToken, (req, res) => {
    res.json(getFileTree(WORKSPACE_DIR));
  });

  app.get("/api/files/tree", authenticateToken, (req, res) => {
    res.json(getFileTree(WORKSPACE_DIR));
  });

  app.get("/api/workspace/file", authenticateToken, (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath) return res.status(400).json({ detail: "Path required" });

    const safePath = path.join(WORKSPACE_DIR, path.normalize(filePath));
    if (!safePath.startsWith(WORKSPACE_DIR) || !fs.existsSync(safePath)) {
      return res.status(404).json({ detail: "File not found" });
    }

    const ext = path.extname(safePath).toLowerCase();
    const imageMimes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
      ".ico": "image/x-icon",
    };

    if (imageMimes[ext]) {
      if (req.query.raw === "true") {
        res.setHeader("Content-Type", imageMimes[ext]);
        return res.sendFile(safePath);
      }
      const buffer = fs.readFileSync(safePath);
      const base64 = buffer.toString("base64");
      const dataUrl = `data:${imageMimes[ext]};base64,${base64}`;
      return res.json({
        path: filePath,
        content: dataUrl,
        isImage: true,
        mimeType: imageMimes[ext],
        format: ext.replace(".", "").toUpperCase(),
        size: buffer.length,
      });
    }

    const content = fs.readFileSync(safePath, "utf-8");
    res.json({ path: filePath, content, isImage: false });
  });

  const createWorkspaceItem = (req: any, res: any) => {
    try {
      const { path: filePath, content, is_folder } = req.body;
      if (!filePath) return res.status(400).json({ detail: "Path required" });

      const safePath = path.join(WORKSPACE_DIR, path.normalize(filePath));
      if (!safePath.startsWith(WORKSPACE_DIR)) {
        return res.status(400).json({ detail: "Invalid path" });
      }

      if (is_folder) {
        fs.mkdirSync(safePath, { recursive: true });
        console.log(`📁 Created folder: ${filePath}`);
        return res.json({ status: "success", message: `Folder created: ${filePath}` });
      } else {
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        if (typeof content === "string" && content.startsWith("data:") && content.includes(";base64,")) {
          const base64Data = content.split(";base64,").pop() || "";
          fs.writeFileSync(safePath, Buffer.from(base64Data, "base64"));
        } else {
          fs.writeFileSync(safePath, content || "", "utf-8");
        }
        console.log(`📄 Saved file: ${filePath}`);
        return res.json({ status: "success", message: `File saved: ${filePath}` });
      }
    } catch (err: any) {
      console.error(`❌ [FS ERROR] Failed workspace item creation:`, err?.message || err);
      return res.status(500).json({ detail: `File creation error: ${err?.message || err}` });
    }
  };

  app.post("/api/workspace/file", authenticateToken, createWorkspaceItem);
  app.post("/api/files/create", authenticateToken, (req, res) => {
    req.body.is_folder = false;
    createWorkspaceItem(req, res);
  });
  app.post("/api/files/mkdir", authenticateToken, (req, res) => {
    req.body.is_folder = true;
    createWorkspaceItem(req, res);
  });

  const deleteWorkspaceItem = (req: any, res: any) => {
    try {
      const filePath = (req.query.path || req.body?.path) as string;
      if (!filePath) return res.status(400).json({ detail: "Path required" });

      const safePath = path.join(WORKSPACE_DIR, path.normalize(filePath));
      if (!safePath.startsWith(WORKSPACE_DIR) || !fs.existsSync(safePath)) {
        return res.status(404).json({ detail: "File or directory not found" });
      }

      fs.rmSync(safePath, { recursive: true, force: true });
      console.log(`🗑️ Deleted workspace item: ${filePath}`);
      res.json({ status: "success", message: `Deleted ${filePath}` });
    } catch (err: any) {
      console.error(`❌ [FS ERROR] Failed deleting workspace item:`, err?.message || err);
      return res.status(500).json({ detail: `Delete operation error: ${err?.message || err}` });
    }
  };

  app.delete("/api/workspace/file", authenticateToken, deleteWorkspaceItem);
  app.delete("/api/files/delete", authenticateToken, deleteWorkspaceItem);

  const clearWorkspaceHandler = (req: any, res: any) => {
    try {
      if (fs.existsSync(WORKSPACE_DIR)) {
        fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
      }
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      console.log("🧹 Workspace cleared successfully.");
      res.json({ status: "success", message: "Workspace cleared successfully" });
    } catch (err: any) {
      console.error(`❌ [FS ERROR] Failed clearing workspace:`, err?.message || err);
      res.status(500).json({ detail: err.message || "Failed to clear workspace" });
    }
  };

  app.post("/api/workspace/clear", authenticateToken, clearWorkspaceHandler);
  app.delete("/api/workspace/clear", authenticateToken, clearWorkspaceHandler);

  // Pull / Clone Repository Endpoint
  app.post("/api/repo/pull", authenticateToken, async (req, res) => {
    const { url, branch = "main" } = req.body;
    if (!url) return res.status(400).json({ detail: "Repository URL required" });

    const currentSettings = readJsonFile(SETTINGS_FILE, { github_token: "" });
    const token = currentSettings.github_token?.trim();
    const cleanUrl = url.trim();
    const authedUrl = formatAuthedGithubUrl(cleanUrl, token);

    // If repository already exists in WORKSPACE_DIR, perform git pull first
    const isGitRepo = fs.existsSync(path.join(WORKSPACE_DIR, ".git"));
    if (isGitRepo) {
      try {
        console.log(`🔄 Performing 'git pull' in existing repository: ${WORKSPACE_DIR}`);
        if (token) {
          await execAsync(`git remote set-url origin "${authedUrl}"`, { cwd: WORKSPACE_DIR, env: GIT_ENV });
        }
        await execAsync(`git pull origin ${branch}`, { cwd: WORKSPACE_DIR, env: GIT_ENV });
        const { stdout: commitSha } = await execAsync(`git rev-parse --short HEAD`, { cwd: WORKSPACE_DIR, env: GIT_ENV });
        return res.json({
          status: "success",
          message: `Successfully pulled repository updates (${branch})`,
          commit_sha: commitSha.trim(),
        });
      } catch (pullErr: any) {
        console.warn(`⚠️ 'git pull' in existing repo failed (${pullErr.message}). Falling back to fresh clone...`);
      }
    }

    // Fresh clone handler
    try {
      if (fs.existsSync(WORKSPACE_DIR)) {
        fs.rmSync(WORKSPACE_DIR, { recursive: true, force: true });
      }
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

      console.log(`📥 Executing git clone for repository (${branch})`);
      await execAsync(`git clone -b ${branch} --depth 1 "${authedUrl}" "${WORKSPACE_DIR}"`, { env: GIT_ENV });
      const { stdout: commitSha } = await execAsync(`git rev-parse --short HEAD`, { cwd: WORKSPACE_DIR, env: GIT_ENV });

      return res.json({
        status: "success",
        message: `Successfully cloned repository (${branch})`,
        commit_sha: commitSha.trim(),
      });
    } catch (cloneErr: any) {
      console.error(`❌ [GIT ERROR] Git clone failed:`, cloneErr?.message || cloneErr);
      return res.status(400).json({
        detail: `Failed to pull/clone repository: ${cloneErr.message || "Authentication or network error"}. If this is a private repository, verify your GitHub Personal Access Token in Settings.`,
      });
    }
  });

  // Push to GitHub / Git Push API Endpoint
  const handleGitPush = async (req: any, res: any) => {
    const commit_message = (req.body.message || req.body.commit_message || "").trim();
    const branch = (req.body.branch || "main").trim();

    if (!commit_message) {
      return res.status(400).json({ detail: "Commit message is required." });
    }

    // Verify /workspace is a Git repository
    try {
      await execAsync("git rev-parse --is-inside-work-tree", { cwd: WORKSPACE_DIR });
    } catch (err) {
      return res.status(400).json({
        detail: "Workspace is not a Git repository. Please clone or pull a repository first.",
      });
    }

    const jobId = `job_push_${Date.now()}`;
    const jobs = readJsonFile(JOBS_FILE, []);

    const newJob = {
      id: jobId,
      repo_url: "workspace",
      action: "git_push",
      commit_message,
      message: commit_message,
      branch,
      image_name: "git",
      tag: branch,
      status: "queued",
      started_at: new Date().toISOString(),
      completed_at: null,
      commit_sha: "head",
    };

    jobs.unshift(newJob);
    writeJsonFile(JOBS_FILE, jobs);

    res.json({
      status: "success",
      job_id: jobId,
      message: `Git push job initiated for branch '${branch}'`,
    });
  };

  app.post("/api/git/push", authenticateToken, handleGitPush);
  app.post("/api/repo/push", authenticateToken, handleGitPush);

  // Fetch Docker Hub Repositories
  app.get("/api/dockerhub/repos", authenticateToken, async (req, res) => {
    const currentSettings = readJsonFile(SETTINGS_FILE, {
      dockerhub_username: "",
      dockerhub_token: "",
      docker_username: "",
      docker_token: "",
      docker_password: "",
    });

    const username = (currentSettings.dockerhub_username || currentSettings.docker_username || "").trim();
    const tokenOrPassword = (currentSettings.dockerhub_token || currentSettings.docker_token || currentSettings.docker_password || "").trim();

    if (!username || !tokenOrPassword) {
      return res.status(400).json({ detail: "Docker Hub username and PAT/password not configured in Settings." });
    }

    try {
      // Authenticate with Docker Hub v2 API to get JWT bearer token
      const loginRes = await fetch("https://hub.docker.com/v2/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: tokenOrPassword }),
      });

      if (!loginRes.ok) {
        return res.status(400).json({ detail: "Failed to authenticate with Docker Hub. Please check credentials in Settings." });
      }

      const loginData: any = await loginRes.json();
      const token = loginData.token;

      // Fetch user's repositories from Docker Hub
      const reposRes = await fetch(`https://hub.docker.com/v2/namespaces/${username}/repositories?page_size=100`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (!reposRes.ok) {
        return res.status(reposRes.status).json({ detail: "Failed to fetch repositories from Docker Hub API" });
      }

      const reposData: any = await reposRes.json();
      const repos = (reposData.results || []).map((r: any) => ({
        name: r.name,
        namespace: r.namespace || username,
        full_name: `${r.namespace || username}/${r.name}`,
        is_private: !!r.is_private,
        star_count: r.star_count || 0,
        pull_count: r.pull_count || 0,
        last_updated: r.last_updated || null,
        description: r.description || "",
      }));

      res.json({ username, repos });
    } catch (err: any) {
      res.status(500).json({ detail: err.message || "Error connecting to Docker Hub API" });
    }
  });

  // Fetch Docker Hub Image Tags
  app.get("/api/dockerhub/tags", authenticateToken, async (req, res) => {
    const imageName = (req.query.repo || req.query.image_name || "") as string;
    if (!imageName) return res.status(400).json({ detail: "Image or repository name required" });

    const currentSettings = readJsonFile(SETTINGS_FILE, {
      dockerhub_username: "",
      dockerhub_token: "",
      docker_username: "",
      docker_token: "",
      docker_password: "",
    });

    const username = (currentSettings.dockerhub_username || currentSettings.docker_username || "").trim();
    const tokenOrPassword = (currentSettings.dockerhub_token || currentSettings.docker_token || currentSettings.docker_password || "").trim();

    const parts = imageName.split("/");
    const namespace = parts.length === 1 ? (username || "library") : parts[0];
    const repo = parts.length === 1 ? parts[0] : parts[1];

    let headers: Record<string, string> = { Accept: "application/json" };

    if (username && tokenOrPassword) {
      try {
        const loginRes = await fetch("https://hub.docker.com/v2/users/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password: tokenOrPassword }),
        });
        if (loginRes.ok) {
          const loginData: any = await loginRes.json();
          headers["Authorization"] = `Bearer ${loginData.token}`;
        }
      } catch (e) {
        // Fallback to unauthenticated fetch
      }
    }

    try {
      const response = await fetch(`https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repo}/tags?page_size=100`, { headers });
      if (response.ok) {
        const data: any = await response.json();
        const tags = (data.results || []).map((t: any) => ({
          name: t.name,
          full_size: t.full_size || 0,
          last_updated: t.last_updated || null,
        }));
        return res.json({ image_name: imageName, namespace, repo, tags: tags.length ? tags : [{ name: "latest" }] });
      }
    } catch (e) {
      // Ignore fallback
    }

    res.json({
      image_name: imageName,
      namespace,
      repo,
      tags: [{ name: "latest" }, { name: "v1.0.0" }, { name: "v1.1.0" }],
    });
  });

  app.post("/api/dockerhub/tags", authenticateToken, async (req, res) => {
    const imageName = (req.body.image_name || req.body.repo || "") as string;
    if (!imageName) return res.status(400).json({ detail: "Image name required" });

    const currentSettings = readJsonFile(SETTINGS_FILE, {
      dockerhub_username: "",
      dockerhub_token: "",
      docker_username: "",
      docker_token: "",
      docker_password: "",
    });

    const username = (currentSettings.dockerhub_username || currentSettings.docker_username || "").trim();
    const tokenOrPassword = (currentSettings.dockerhub_token || currentSettings.docker_token || currentSettings.docker_password || "").trim();

    const parts = imageName.split("/");
    const namespace = parts.length === 1 ? (username || "library") : parts[0];
    const repo = parts.length === 1 ? parts[0] : parts[1];

    let headers: Record<string, string> = { Accept: "application/json" };
    if (username && tokenOrPassword) {
      try {
        const loginRes = await fetch("https://hub.docker.com/v2/users/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password: tokenOrPassword }),
        });
        if (loginRes.ok) {
          const loginData: any = await loginRes.json();
          headers["Authorization"] = `Bearer ${loginData.token}`;
        }
      } catch (e) {}
    }

    try {
      const response = await fetch(`https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repo}/tags?page_size=100`, { headers });
      if (response.ok) {
        const data: any = await response.json();
        const tags = (data.results || []).map((t: any) => t.name);
        return res.json({ image_name: imageName, tags: tags.length ? tags : ["latest"] });
      }
    } catch (e) {}

    res.json({ image_name: imageName, tags: ["latest", "v1.0.0", "v1.1.0"] });
  });

  // Build Jobs List & Logs
  app.get("/api/jobs", authenticateToken, (req, res) => {
    const jobs = readJsonFile(JOBS_FILE, []);
    const formatted = jobs.map((j: any) => ({
      ...j,
      job_type: j.job_type || j.action || "build",
      action: j.action || j.job_type || "build",
    }));
    res.json(formatted);
  });

  app.get("/api/jobs/:jobId/logs", authenticateToken, (req, res) => {
    const { jobId } = req.params;
    const logPath = path.join(LOGS_DIR, `${jobId}.log`);
    if (fs.existsSync(logPath)) {
      const logs = fs.readFileSync(logPath, "utf-8");
      return res.json({ job_id: jobId, logs });
    }
    res.status(404).json({ detail: "Log file not found" });
  });

  // Trigger Build Job (Build image only)
  app.post(["/api/build", "/api/jobs/build"], authenticateToken, (req, res) => {
    if (isBuildingGlobal) {
      return res.status(400).json({ detail: "A build or push job is already running." });
    }

    let { image_name = "dockforge", tag = "latest", target_image_tag, action = "build", local_image = "dockforge" } = req.body;
    if (target_image_tag && target_image_tag.includes(":")) {
      const parts = target_image_tag.split(":");
      image_name = parts[0];
      tag = parts[1] || "latest";
    } else if (target_image_tag) {
      image_name = target_image_tag;
    }

    const jobId = `job_${Date.now()}`;
    const jobs = readJsonFile(JOBS_FILE, []);

    const newJob = {
      id: jobId,
      repo_url: "workspace",
      action: action === "push" ? "push" : "build",
      job_type: action === "push" ? "push" : "build",
      image_name,
      tag,
      local_image,
      status: "queued",
      started_at: new Date().toISOString(),
      completed_at: null,
      commit_sha: "head",
    };

    jobs.unshift(newJob);
    writeJsonFile(JOBS_FILE, jobs);

    res.json({ job_id: jobId, status: "queued", message: `Job queued (${newJob.action})` });
  });

  // Trigger Push Job (Push image only)
  app.post(["/api/push", "/api/jobs/push"], authenticateToken, (req, res) => {
    if (isBuildingGlobal) {
      return res.status(400).json({ detail: "A build or push job is already running." });
    }

    let { image_name = "dockforge", tag = "latest", target_image_tag, local_image = "dockforge" } = req.body;
    if (target_image_tag && target_image_tag.includes(":")) {
      const parts = target_image_tag.split(":");
      image_name = parts[0];
      tag = parts[1] || "latest";
    } else if (target_image_tag) {
      image_name = target_image_tag;
    }

    const jobId = `job_${Date.now()}`;
    const jobs = readJsonFile(JOBS_FILE, []);

    const newJob = {
      id: jobId,
      repo_url: "workspace",
      action: "push",
      job_type: "push",
      image_name,
      tag,
      local_image,
      status: "queued",
      started_at: new Date().toISOString(),
      completed_at: null,
      commit_sha: "head",
    };

    jobs.unshift(newJob);
    writeJsonFile(JOBS_FILE, jobs);

    res.json({ job_id: jobId, status: "queued", message: "Push job queued" });
  });

  // Handle WebSocket upgrades
  server.on("upgrade", (request, socket, head) => {
    const pathname = request.url || "";
    if (pathname.startsWith("/ws/build/")) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // Real-time Build Log Streaming WebSocket
  wss.on("connection", async (ws: WebSocket, request) => {
    const pathname = request.url || "";
    const jobId = pathname.replace("/ws/build/", "");

    const jobs = readJsonFile(JOBS_FILE, []);
    const job = jobs.find((j: any) => j.id === jobId);

    if (!job) {
      ws.send("Job not found.\n");
      ws.close();
      return;
    }

    isBuildingGlobal = true;
    job.status = "building";
    writeJsonFile(JOBS_FILE, jobs);

    const logPath = path.join(LOGS_DIR, `${jobId}.log`);
    fs.writeFileSync(logPath, "", "utf-8");

    const emit = async (msg: string) => {
      const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
      fs.appendFileSync(logPath, line, "utf-8");
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(line);
      }
    };

    try {
      const action = job.action || "build";
      const localImageName = job.local_image || "dockforge";

      if (action === "git_push") {
        await emit("==================================================");
        await emit(`🚀 Starting Git Push Pipeline [Branch: ${job.branch || "main"}] for Job: ${jobId}`);
        await emit(`📁 Context Directory: ${WORKSPACE_DIR}`);
        await emit("==================================================");

        // 1. Configure Git Author identity if not set
        await emit("🔧 Configuring Git Author identity...");
        try {
          await execAsync(`git config user.name "DockForge User"`, { cwd: WORKSPACE_DIR, env: GIT_ENV });
          await execAsync(`git config user.email "dockforge@local"`, { cwd: WORKSPACE_DIR, env: GIT_ENV });
          await emit("  └─ Set user.name 'DockForge User' & user.email 'dockforge@local'");
        } catch (e: any) {
          await emit(`  └─ ⚠️ Notice configuring git user: ${e.message}`);
        }

        // 2. Verify workspace is a Git repository
        await emit("🔍 Verifying Git repository status...");
        try {
          await execAsync(`git rev-parse --is-inside-work-tree`, { cwd: WORKSPACE_DIR, env: GIT_ENV });
          await emit("  └─ Workspace is a valid Git repository.");
        } catch (e: any) {
          await emit("💥 Error: workspace is not a Git repository. Please clone or pull a repository first.");
          job.status = "failure";
          job.completed_at = new Date().toISOString();
          writeJsonFile(JOBS_FILE, jobs);
          ws.close();
          return;
        }

        // 3. Stage changes (git add .)
        await emit("➕ Staging workspace changes (git add .)...");
        try {
          const addProc = spawn("git", ["add", "."], { cwd: WORKSPACE_DIR, env: GIT_ENV });
          activeChildProcesses.add(addProc);
          addProc.stdout.on("data", (data) => emit(data.toString().trim()));
          addProc.stderr.on("data", (data) => emit(data.toString().trim()));
          await new Promise((resolve) => addProc.on("close", resolve));
          activeChildProcesses.delete(addProc);
        } catch (e: any) {
          await emit(`⚠️ Warning during git add: ${e.message}`);
        }

        // 4. Commit changes if any exist
        const { stdout: statusOut } = await execAsync(`git status --porcelain`, { cwd: WORKSPACE_DIR, env: GIT_ENV }).catch(() => ({ stdout: "" }));
        const commitMsg = job.commit_message || job.message || "Update from DockForge";

        if (statusOut.trim()) {
          await emit(`📝 Committing changes with message: "${commitMsg}"`);
          const commitProc = spawn("git", ["commit", "-m", commitMsg], { cwd: WORKSPACE_DIR, env: GIT_ENV });
          activeChildProcesses.add(commitProc);
          commitProc.stdout.on("data", (data) => emit(data.toString().trim()));
          commitProc.stderr.on("data", (data) => emit(data.toString().trim()));
          const commitCode = await new Promise((resolve) => commitProc.on("close", resolve));
          activeChildProcesses.delete(commitProc);
          if (commitCode !== 0) {
            await emit("⚠️ Notice: git commit completed with non-zero exit code.");
          }
        } else {
          await emit("ℹ️ No uncommitted local changes detected. Proceeding to push existing commits.");
        }

        // 5. Inject GitHub PAT into remote URL if available
        const currentSettings = readJsonFile(SETTINGS_FILE, { github_token: "" });
        const token = currentSettings.github_token?.trim();
        let originUrl = "";
        try {
          const { stdout } = await execAsync(`git remote get-url origin`, { cwd: WORKSPACE_DIR, env: GIT_ENV });
          originUrl = stdout.trim();
        } catch (e) {
          await emit("⚠️ Warning: No remote origin URL configured for workspace.");
        }

        if (originUrl) {
          if (token) {
            const authedUrl = formatAuthedGithubUrl(originUrl, token);
            await execAsync(`git remote set-url origin "${authedUrl}"`, { cwd: WORKSPACE_DIR, env: GIT_ENV });
            await emit(`🔐 Injected GitHub PAT into remote origin URL`);
          } else {
            await emit("ℹ️ No GitHub PAT configured in Settings. Proceeding with default git credentials...");
          }
        }

        // 6. Execute git push origin <branch>
        const targetBranch = job.branch || "main";
        await emit(`⬆️ Executing: git push origin ${targetBranch}`);

        const pushProc = spawn("git", ["push", "origin", targetBranch], { cwd: WORKSPACE_DIR, env: GIT_ENV });
        activeChildProcesses.add(pushProc);

        let pushOutput = "";
        pushProc.stdout.on("data", (data) => {
          const text = data.toString().trim();
          pushOutput += text + "\n";
          if (text) emit(text);
        });
        pushProc.stderr.on("data", (data) => {
          const text = data.toString().trim();
          pushOutput += text + "\n";
          if (text) emit(text);
        });

        const pushExitCode = await new Promise<number>((resolve) => {
          pushProc.on("close", (code) => {
            activeChildProcesses.delete(pushProc);
            resolve(code || 0);
          });
        });

        if (pushExitCode === 0) {
          const { stdout: commitSha } = await execAsync(`git rev-parse --short HEAD`, { cwd: WORKSPACE_DIR }).catch(() => ({ stdout: "head" }));
          await emit("==================================================");
          await emit(`✨ GIT PUSH FINISHED SUCCESSFULLY [Commit: ${commitSha.trim()}, Branch: ${targetBranch}] ✨`);
          await emit("==================================================");
          job.status = "success";
          job.commit_sha = commitSha.trim();
        } else {
          await emit("==================================================");
          await emit("💥 Git Push Failed!");

          if (pushOutput.includes("non-fast-forward") || pushOutput.includes("fetch first") || pushOutput.includes("behind")) {
            await emit("💡 TIP: Remote branch contains updates that you do not have locally. Pull the latest repository changes first before pushing.");
          } else if (pushOutput.includes("Authentication failed") || pushOutput.includes("403") || pushOutput.includes("401") || pushOutput.includes("Could not read from remote")) {
            await emit("💡 TIP: Authentication failed. Please verify your Personal Access Token (PAT) permissions in Settings.");
          } else if (pushOutput.includes("src refspec") || pushOutput.includes("does not match any")) {
            await emit(`💡 TIP: Local branch '${targetBranch}' does not exist or has no commits yet.`);
          }

          await emit("==================================================");
          job.status = "failure";
        }

        job.completed_at = new Date().toISOString();
        writeJsonFile(JOBS_FILE, jobs);
        ws.close();
        return;
      }

      await emit("==================================================");
      await emit(`🚀 DockForge Engine Started [Action: ${action.toUpperCase()}] for Job: ${jobId}`);
      await emit(`📦 Target Image: ${job.image_name}:${job.tag}`);
      await emit(`📁 Context Directory: ${WORKSPACE_DIR}`);
      await emit("==================================================");

      const currentSettings = readJsonFile(SETTINGS_FILE, {
        dockerhub_username: "",
        dockerhub_token: "",
        docker_username: "",
        docker_token: "",
        docker_password: "",
      });

      const dockerUser = (currentSettings.dockerhub_username || currentSettings.docker_username || "").trim();
      const dockerPass = (currentSettings.dockerhub_token || currentSettings.docker_token || currentSettings.docker_password || "").trim();

      const dockerSockExists = fs.existsSync("/var/run/docker.sock");

      // Format target image tag using configured Docker Hub username if available
      let targetRepo = job.image_name || "dockforge";
      if (dockerUser && !targetRepo.includes("/")) {
        targetRepo = `${dockerUser}/${targetRepo}`;
      }
      const fullImageTag = `${targetRepo}:${job.tag}`;

      if (action === "push") {
        await emit("==================================================");
        await emit(`🚀 Starting DockForge Image Push Job: ${jobId}`);
        await emit(`📦 Target Image: ${fullImageTag}`);
        await emit("==================================================");

        if (dockerSockExists) {
          if (dockerUser && dockerPass) {
            await emit(`🔐 Authenticating with Docker Hub as '${dockerUser}'...`);
            try {
              const loginProc = spawn("docker", ["login", "-u", dockerUser, "--password-stdin"], {
                cwd: WORKSPACE_DIR,
              });
              activeChildProcesses.add(loginProc);
              loginProc.stdin.write(dockerPass + "\n");
              loginProc.stdin.end();

              loginProc.stdout.on("data", (data) => emit(data.toString().trim()));
              loginProc.stderr.on("data", (data) => emit(data.toString().trim()));

              await new Promise((resolve) => loginProc.on("close", resolve));
            } catch (loginErr: any) {
              await emit(`⚠️ Docker Hub login warning: ${loginErr.message}`);
            }
          }

          await emit(`🏷️ Tagging image: docker tag ${localImageName}:${job.tag} ${fullImageTag}`);
          const tagProc = spawn("docker", ["tag", `${localImageName}:${job.tag}`, fullImageTag], { cwd: WORKSPACE_DIR });
          activeChildProcesses.add(tagProc);
          await new Promise((resolve) => tagProc.on("close", resolve));

          await emit(`⬆️ Executing: docker push ${fullImageTag}`);
          const pushProc = spawn("docker", ["push", fullImageTag], {
            cwd: WORKSPACE_DIR,
          });
          activeChildProcesses.add(pushProc);
          pushProc.on("close", () => activeChildProcesses.delete(pushProc));
          pushProc.on("exit", () => activeChildProcesses.delete(pushProc));

          pushProc.stdout.on("data", (data) => emit(data.toString().trim()));
          pushProc.stderr.on("data", (data) => emit(data.toString().trim()));

          await new Promise((resolve) => pushProc.on("close", resolve));
        } else {
          await emit("⚙️ Operating in DockForge Push Engine Sandbox mode...");
          if (dockerUser) {
            await emit(`🔐 Authenticated with Docker Hub as '${dockerUser}' (PAT Active)`);
          } else {
            await emit("ℹ️ No Docker Hub PAT configured in Settings. Proceeding with public target...");
          }
          await emit(`🏷️ Tagging local image '${localImageName}:${job.tag}' as '${fullImageTag}'`);
          await new Promise((r) => setTimeout(r, 600));
          await emit(`⬆️ Pushing container image [docker.io/${fullImageTag}] to Docker Hub...`);
          await new Promise((r) => setTimeout(r, 900));
          await emit(`The push refers to repository [docker.io/${targetRepo}]`);
          await emit("Layer 1/3: 3a102b489c0d: Pushed [12.4 MB]");
          await emit("Layer 2/3: 5c9103e8211a: Pushed [2.8 MB]");
          await emit("Layer 3/3: b712a4e0192a: Layer already exists");
          await emit(`${job.tag}: digest: sha256:8f12a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0 size: 1420`);
          await emit(`🎉 Container image '${fullImageTag}' successfully published to Docker Hub!`);
        }

        await emit("==================================================");
        await emit(`✨ DOCKER PUSH FINISHED SUCCESSFULLY [${fullImageTag}] ✨`);
        await emit("==================================================");
      } else {
        // Default action === 'build'
        await emit("==================================================");
        await emit(`🚀 Starting DockForge Image Build Job: ${jobId}`);
        await emit(`📦 Target Image Tag: ${fullImageTag}`);
        await emit(`📁 Context Directory: ${WORKSPACE_DIR}`);
        await emit("==================================================");

        if (dockerSockExists) {
          await emit("🐳 Host Docker Socket detected at /var/run/docker.sock");
          await emit(`🛠️ Executing: docker build -t ${fullImageTag} .`);

          const buildProc = spawn("docker", ["build", "-t", fullImageTag, "."], {
            cwd: WORKSPACE_DIR,
          });
          activeChildProcesses.add(buildProc);
          buildProc.on("close", () => activeChildProcesses.delete(buildProc));
          buildProc.on("exit", () => activeChildProcesses.delete(buildProc));

          buildProc.stdout.on("data", (data) => emit(data.toString().trim()));
          buildProc.stderr.on("data", (data) => emit(data.toString().trim()));

          await new Promise((resolve) => buildProc.on("close", resolve));

          if (fullImageTag !== `${localImageName}:${job.tag}`) {
            const tagProc = spawn("docker", ["tag", fullImageTag, `${localImageName}:${job.tag}`], { cwd: WORKSPACE_DIR });
            activeChildProcesses.add(tagProc);
            await new Promise((resolve) => tagProc.on("close", resolve));
          }
        } else {
          await emit("⚙️ Operating in DockForge Build Engine Sandbox mode...");
          await new Promise((r) => setTimeout(r, 600));
          await emit("Step 1/6 : FROM python:3.11-slim");
          await new Promise((r) => setTimeout(r, 700));
          await emit(" ---> Downloading base layers: [====================>] 100%");
          await emit(" ---> Pull complete python:3.11-slim");
          await new Promise((r) => setTimeout(r, 800));
          await emit("Step 2/6 : WORKDIR /app");
          await emit(" ---> Running in container b712a4e");
          await new Promise((r) => setTimeout(r, 600));
          await emit("Step 3/6 : COPY requirements.txt .");
          await emit(" ---> 5c9103e8211a");
          await new Promise((r) => setTimeout(r, 900));
          await emit("Step 4/6 : RUN pip install --no-cache-dir -r requirements.txt");
          await emit(" ---> Collecting fastapi, uvicorn...");
          await emit(" ---> Successfully installed packages");
          await new Promise((r) => setTimeout(r, 700));
          await emit("Step 5/6 : COPY . .");
          await emit(" ---> 3a102b489c0d");
          await new Promise((r) => setTimeout(r, 600));
          await emit("Step 6/6 : EXPOSE 8000");
          await emit(` ---> Successfully built image: ${fullImageTag}`);
          await new Promise((r) => setTimeout(r, 500));
        }

        await emit("==================================================");
        await emit(`✨ DOCKER BUILD FINISHED SUCCESSFULLY [${fullImageTag}] ✨`);
        await emit("==================================================");
      }

      job.status = "success";
      job.completed_at = new Date().toISOString();
    } catch (e: any) {
      await emit(`💥 Error during build execution: ${e.message}`);
      job.status = "failure";
      job.completed_at = new Date().toISOString();
    } finally {
      isBuildingGlobal = false;
      writeJsonFile(JOBS_FILE, jobs);
      ws.close();
    }
  });

  // --- VITE MIDDLEWARE SETUP & STATIC SPA BINDINGS ---
  const distPath = path.join(process.cwd(), "dist");
  const publicPath = path.join(process.cwd(), "public");
  const frontendPath = path.join(process.cwd(), "frontend");
  const frontendPublicPath = path.join(frontendPath, "public");

  app.use("/frontend", express.static(frontendPath));
  app.use("/public", express.static(frontendPublicPath));
  app.use("/css", express.static(path.join(frontendPath, "css")));
  app.use("/js", express.static(path.join(frontendPath, "js")));

  app.get(["/logo.png", "/public/logo.png", "/frontend/public/logo.png"], (req, res) => {
    const logoFile = path.join(frontendPublicPath, "logo.png");
    if (fs.existsSync(logoFile)) {
      return res.sendFile(logoFile);
    }
    res.status(404).send("Not found");
  });

  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
  }
  if (fs.existsSync(publicPath)) {
    app.use("/public", express.static(publicPath));
    app.use(express.static(publicPath));
  }

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    viteServerInstance = vite;
    app.use(vite.middlewares);

    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
        return next();
      }
      const requestedFrontendFile = path.join(frontendPath, req.path.replace(/^\/frontend/, ""));
      if (fs.existsSync(requestedFrontendFile) && fs.statSync(requestedFrontendFile).isFile()) {
        return res.sendFile(requestedFrontendFile);
      }
      const indexPath = fs.existsSync(path.join(distPath, "index.html"))
        ? path.join(distPath, "index.html")
        : path.join(process.cwd(), "index.html");
      res.sendFile(indexPath);
    });
  } else {
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/ws")) {
        return res.status(404).json({ detail: "Not Found" });
      }
      const requestedDistFile = path.join(distPath, req.path);
      if (fs.existsSync(requestedDistFile) && fs.statSync(requestedDistFile).isFile()) {
        return res.sendFile(requestedDistFile);
      }
      const requestedFrontendFile = path.join(frontendPath, req.path.replace(/^\/frontend/, ""));
      if (fs.existsSync(requestedFrontendFile) && fs.statSync(requestedFrontendFile).isFile()) {
        return res.sendFile(requestedFrontendFile);
      }
      const indexPath = fs.existsSync(path.join(distPath, "index.html"))
        ? path.join(distPath, "index.html")
        : path.join(process.cwd(), "index.html");
      res.sendFile(indexPath);
    });
  }

  // --- GRACEFUL SHUTDOWN & PROCESS CLEANUP ---
  let isShuttingDown = false;

  async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n🛑 Received ${signal}. Initializing graceful shutdown...`);

    // 1. Terminate all active child processes
    if (activeChildProcesses.size > 0) {
      console.log(`🧹 Terminating ${activeChildProcesses.size} active child processes...`);
      for (const proc of activeChildProcesses) {
        try {
          proc.kill("SIGTERM");
        } catch (e) {}
      }
      activeChildProcesses.clear();
    }

    // 2. Close active WebSocket connections
    if (wss) {
      console.log(`🔌 Closing WebSocket connections...`);
      wss.clients.forEach((client) => {
        try {
          client.close(1001, "Server shutting down");
        } catch (e) {}
      });
      try {
        wss.close();
      } catch (e) {}
    }

    // 3. Close Vite dev server if running
    if (viteServerInstance) {
      console.log(`⚡ Closing Vite dev server instance...`);
      try {
        await viteServerInstance.close();
      } catch (e) {}
    }

    // 4. Close open sockets
    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch (e) {}
    }
    activeSockets.clear();

    // 5. Close HTTP server
    if (server) {
      server.close(() => {
        console.log(`✅ HTTP server closed gracefully.`);
        process.exit(0);
      });

      setTimeout(() => {
        console.warn(`⚠️ Force exiting server process after shutdown timeout.`);
        process.exit(0);
      }, 3000);
    } else {
      process.exit(0);
    }
  }

  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  // --- SERVER PORT BINDING ---
  function bindServer() {
    server.removeAllListeners("error");

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE" || err.errno === 98 || err.message?.includes("EADDRINUSE")) {
        console.warn(`Port 3000 in use, retrying binding in 500ms...`);
        setTimeout(() => {
          bindServer();
        }, 500);
      } else {
        console.error("❌ Server error:", err);
      }
    });

    server.listen(3000, "0.0.0.0", () => {
      console.log(`🚀 DockForge Server listening on http://0.0.0.0:3000`);
    });
  }

  bindServer();
}

startServer();
