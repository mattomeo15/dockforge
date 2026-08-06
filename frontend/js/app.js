/**
 * DockForge - Self-Hosted Docker CI/CD IDE
 * Vanilla JS SPA Engine
 */

(function () {
  'use strict';

  // --- SAFE LOCALSTORAGE ACCESS HELPERS ---
  function safeLocalStorageGet(key, fallbackValue = null) {
    try {
      const val = localStorage.getItem(key);
      return val !== null ? val : fallbackValue;
    } catch (e) {
      console.warn(`[DockForge] localStorage get failed for key "${key}":`, e);
      return fallbackValue;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      if (value === null || value === undefined) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, value);
      }
    } catch (e) {
      console.warn(`[DockForge] localStorage set failed for key "${key}":`, e);
    }
  }

  function safeLocalStorageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn(`[DockForge] localStorage remove failed for key "${key}":`, e);
    }
  }

  // --- HTML SANITIZATION HELPER ---
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m] || m));
  }
  window.escapeHtml = escapeHtml;

  // --- STATE MANAGEMENT ---
  const state = {
    theme: safeLocalStorageGet('dockforge_theme') || safeLocalStorageGet('theme') || 'dark',
    token: safeLocalStorageGet('dockforge_token') || null,
    user: safeLocalStorageGet('dockforge_user') || null,
    files: [],
    openTabs: [],
    activeTabPath: null,
    settings: {
      github_token: '',
      dockerhub_username: '',
      dockerhub_token: '',
      theme: 'dark'
    },
    jobs: [],
    activeJobLogs: '',
    terminalAutoScroll: true,
    terminalScrollTop: null,
    currentWs: null,
    lastLocalBuild: (() => {
      try {
        const val = safeLocalStorageGet('dockforge_last_build');
        return val ? JSON.parse(val) : null;
      } catch (e) {
        return null;
      }
    })(),
    dockerLocalTagInput: 'latest',
    modals: {
      pull: false,
      push: false,
      build: false,
      pushDocker: false,
      jobs: false,
      settings: false,
      newFile: false,
      newFolder: false,
      clearWorkspace: false,
      deleteItem: null
    },
    loading: {
      pull: false,
      push: false,
      build: false,
      settings: false,
      testGh: false,
      testDh: false
    },
    tagsList: ['latest'],
    dockerImageInput: '',
    dockerTagInput: 'latest',
    expandedFolders: new Set(['']),
    treeOrder: {},
    draggedPath: null,
    draggedIsFolder: false,
    editorMaximized: false,
    terminalMaximized: false,
    mobileTab: 'code',
    mobileMenuOpen: false,
    currentCredentials: null,
    repos: [],
    currentRepoUrl: '',
    pullRepoUrl: '',
    pullBranch: 'main',
    loadingRepos: false,
    cloningRepo: false,
    activeProject: null,
    repoPath: null,
    activeBranch: null,
    activeRepo: {
      name: 'No Project Loaded',
      full_name: '',
      branch: '',
      url: ''
    },
    activeProjectMenuOpen: false,
    dockerHubRepos: [],
    dockerHubTags: [],
    loadingDockerHubRepos: false,
    loadingDockerHubTags: false
  };

  // --- THEME MANAGEMENT & DOM UPDATES ---
  function applyTheme(themeName) {
    const validTheme = (themeName === 'light' || themeName === 'dark') ? themeName : 'dark';
    state.theme = validTheme;
    if (state.settings) {
      state.settings.theme = validTheme;
    }
    safeLocalStorageSet('dockforge_theme', validTheme);
    safeLocalStorageSet('theme', validTheme);

    if (validTheme === 'dark') {
      document.documentElement.classList.add('dark');
      document.body.classList.add('dark');
      document.body.classList.remove('light');
    } else {
      document.documentElement.classList.remove('dark');
      document.body.classList.remove('dark');
      document.body.classList.add('light');
    }
  }

  // Initial application on script load
  try {
    applyTheme(state.theme);
  } catch (err) {
    console.error('[DockForge] Theme initialization error:', err);
  }

  // --- API HELPERS ---
  async function apiFetch(endpoint, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }

    const res = await fetch(endpoint, { ...options, headers });
    if (res.status === 401 && endpoint !== '/api/auth/login') {
      try {
        const cloned = res.clone();
        const data = await cloned.json();
        if (data.code === 'UNAUTHORIZED' || data.detail === 'Access token required' || data.detail === 'Invalid or expired token') {
          handleLogout();
          throw new Error('Session expired. Please log in again.');
        }
      } catch (e) {
        if (e.message === 'Session expired. Please log in again.') {
          throw e;
        }
      }
    }
    return res;
  }

  function handleLogout() {
    state.token = null;
    state.user = null;
    safeLocalStorageRemove('dockforge_auth');
    safeLocalStorageRemove('dockforge_token');
    safeLocalStorageRemove('dockforge_user');
    loadCredentials().then(() => {
      render();
    });
  }

  function showToast(message, isError = false) {
    const existing = document.getElementById('dockforge-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'dockforge-toast';
    toast.className = `fixed bottom-6 right-6 z-[100] px-4 py-3 rounded-lg shadow-2xl text-xs font-semibold flex items-center space-x-2 transition-all transform duration-300 ${
      isError ? 'bg-red-600 text-white' : 'bg-emerald-600 text-white'
    }`;
    toast.innerHTML = `<i class="fa-solid ${isError ? 'fa-circle-exclamation' : 'fa-circle-check'} text-sm"></i> <span>${escapeHtml(message)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('opacity-0', 'translate-y-2');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  async function loadCredentials() {
    try {
      const res = await fetch('/api/auth/credentials');
      if (res.ok) {
        state.currentCredentials = await res.json();
      }
    } catch (e) {
      console.warn('Failed to fetch credentials:', e);
    }
  }

  // --- DATA FETCHING ---
  async function loadWorkspaceTree(showToastOnSuccess = false) {
    if (!state.token) return;
    try {
      const [treeRes, orderRes] = await Promise.all([
        apiFetch('/api/files/tree'),
        apiFetch('/api/workspace/order').catch(() => null)
      ]);
      if (treeRes && treeRes.ok) {
        state.files = await treeRes.json();
      }
      if (orderRes && orderRes.ok) {
        state.treeOrder = await orderRes.json();
      }
      if (showToastOnSuccess) {
        showToast('File tree refreshed');
      }
      render();
    } catch (e) {
      console.error('Failed to load file tree:', e);
      if (showToastOnSuccess) {
        showToast(e.message || 'Failed to refresh file tree', true);
      }
    }
  }

  async function loadSettings() {
    if (!state.token) return;
    try {
      const res = await apiFetch('/api/settings');
      if (res.ok) {
        state.settings = await res.json();
        if (state.settings.theme) {
          applyTheme(state.settings.theme);
        }
        if (state.settings.github_token) {
          loadGitHubRepos();
        }
        if (state.settings.dockerhub_username || state.settings.docker_username) {
          loadDockerHubRepos();
        }
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
  }

  async function loadDockerHubRepos(showToastOnError = false) {
    if (!state.token) return;
    state.loadingDockerHubRepos = true;
    render();
    try {
      const res = await apiFetch('/api/dockerhub/repos');
      if (res.ok) {
        const data = await res.json();
        state.dockerHubRepos = data.repos || [];
        const parsed = parseRepoAndTag(state.dockerImageInput && state.dockerImageInput !== 'my-username/my-service' ? state.dockerImageInput : '');
        const matchedRepo = state.dockerHubRepos.find(r => r.full_name === parsed.repo || r.name === parsed.repo.split('/')[1]);
        if (matchedRepo) {
          state.dockerImageInput = matchedRepo.full_name;
        } else if (parsed.repo) {
          state.dockerImageInput = parsed.repo;
        }
        if (state.dockerImageInput) {
          await loadDockerHubTags(state.dockerImageInput);
        }
      } else {
        const err = await res.json().catch(() => ({}));
        if (showToastOnError && err.detail) {
          showToast(err.detail, true);
        }
      }
    } catch (e) {
      if (showToastOnError) {
        showToast(e.message || 'Failed to fetch Docker Hub repositories', true);
      }
    } finally {
      state.loadingDockerHubRepos = false;
      render();
    }
  }

  async function loadDockerHubTags(repoName) {
    if (!state.token || !repoName) return;
    state.loadingDockerHubTags = true;
    render();
    try {
      const res = await apiFetch(`/api/dockerhub/tags?repo=${encodeURIComponent(repoName)}`);
      if (res.ok) {
        const data = await res.json();
        state.dockerHubTags = data.tags || [];
        state.tagsList = (data.tags || []).map(t => typeof t === 'string' ? t : t.name);
      }
    } catch (e) {
      console.warn('Failed to load tags:', e);
    } finally {
      state.loadingDockerHubTags = false;
      render();
    }
  }

  function formatProjectTitle(name) {
    if (!name || name === 'No Project Loaded' || name === 'No Repository Loaded') {
      return 'No Project Loaded';
    }
    const cleanName = name.trim();
    if (cleanName.toLowerCase() === 'dockforge') return 'DockForge';
    if (cleanName.toLowerCase() === 'ip-freely') return 'IP-Freely';

    return cleanName
      .split(/[-_]+/)
      .map(part => {
        if (!part) return '';
        const lower = part.toLowerCase();
        if (lower === 'ip') return 'IP';
        if (lower === 'dockforge') return 'DockForge';
        if (lower === 'ui') return 'UI';
        if (lower === 'api') return 'API';
        if (lower === 'db') return 'DB';
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join('-');
  }

  function syncActiveRepo(urlOrFullName = null, targetBranch = null) {
    const url = urlOrFullName !== null ? urlOrFullName : (state.currentRepoUrl || '');
    if (!url) {
      state.activeProject = null;
      state.repoPath = null;
      state.activeBranch = null;
      state.activeRepo = {
        name: 'No Project Loaded',
        full_name: '',
        branch: '',
        url: ''
      };
      return;
    }

    let fullName = '';
    let shortName = '';
    let branch = targetBranch || state.pullBranch || 'main';

    const matchedRepo = (state.repos || []).find(r => {
      if (!r) return false;
      const rClone = (r.clone_url || '').toLowerCase();
      const rFull = (r.full_name || '').toLowerCase();
      const target = url.toLowerCase();
      return (rClone && (target === rClone || target.includes(rClone))) ||
             (rFull && (target === rFull || target.includes(rFull)));
    });

    if (matchedRepo) {
      fullName = matchedRepo.full_name;
      if (matchedRepo.name) {
        shortName = matchedRepo.name;
      } else if (matchedRepo.full_name.includes('/')) {
        shortName = matchedRepo.full_name.split('/')[1];
      } else {
        shortName = matchedRepo.full_name;
      }
      if (!targetBranch && matchedRepo.default_branch) {
        branch = matchedRepo.default_branch;
      }
    } else {
      let clean = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
      if (clean.includes('/')) {
        const parts = clean.split('/');
        if (parts.length >= 2) {
          fullName = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
          shortName = parts[parts.length - 1];
        } else {
          fullName = clean;
          shortName = clean;
        }
      } else {
        fullName = clean;
        shortName = clean;
      }
    }

    state.activeProject = shortName || null;
    state.repoPath = fullName || null;
    state.activeBranch = branch || null;

    state.activeRepo = {
      name: shortName || 'No Project Loaded',
      full_name: fullName,
      branch: branch,
      url: url
    };

    const newRepo = getCurrentRepoName();
    resetProjectContextState(newRepo);
  }

  async function loadGitHubRepos(showToastOnError = false) {
    if (!state.token) return;
    state.loadingRepos = true;
    render();
    try {
      const res = await apiFetch('/api/github/repos');
      if (res.ok) {
        const data = await res.json();
        state.repos = data.repos || [];
        if (data.current_repo) {
          state.currentRepoUrl = data.current_repo;
        } else {
          state.currentRepoUrl = '';
        }
        syncActiveRepo();
      } else {
        const err = await res.json().catch(() => ({}));
        if (showToastOnError && err.detail) {
          showToast(err.detail, true);
        }
      }
    } catch (e) {
      if (showToastOnError) {
        showToast(e.message || 'Failed to fetch GitHub repositories', true);
      }
    } finally {
      state.loadingRepos = false;
      render();
    }
  }

  async function switchRepository(repoUrl, branch = 'main', repoName = '') {
    if (!repoUrl) return;
    const nameToDisplay = repoName || repoUrl.split('/').pop().replace('.git', '');

    if (!confirm(`Switch workspace to repository "${nameToDisplay}" (${branch})?\nThis will clone/sync the repository into your workspace directory.`)) {
      render();
      return;
    }

    state.cloningRepo = true;
    showToast(`Cloning repository "${nameToDisplay}"...`);
    render();

    try {
      const res = await apiFetch('/api/repo/pull', {
        method: 'POST',
        body: JSON.stringify({ url: repoUrl, branch })
      });

      if (res.ok) {
        const data = await res.json();
        showToast(data.message || `Successfully pulled ${nameToDisplay}`);
        state.openTabs = [];
        state.activeTabPath = null;
        state.currentRepoUrl = repoUrl;
        state.pullRepoUrl = repoUrl;
        state.pullBranch = branch;
        syncActiveRepo(repoUrl, branch);
        await loadWorkspaceTree();
        await loadGitHubRepos();
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || 'Failed to pull repository', true);
      }
    } catch (e) {
      showToast(e.message || 'Error pulling repository', true);
    } finally {
      state.cloningRepo = false;
      render();
    }
  }

  function isCurrentRepo(repo) {
    if (!repo) return false;
    const cur = (state.currentRepoUrl || (state.activeRepo && state.activeRepo.url) || '').toLowerCase();
    const activeFull = (state.activeRepo && state.activeRepo.full_name || '').toLowerCase();
    const fullName = repo.full_name ? repo.full_name.toLowerCase() : '';
    const cloneUrl = repo.clone_url ? repo.clone_url.toLowerCase() : '';
    return (fullName && (cur.includes(fullName) || activeFull === fullName)) || (cloneUrl && cur === cloneUrl);
  }

  async function loadJobs() {
    if (!state.token) return;
    try {
      const res = await apiFetch('/api/jobs');
      if (res.ok) {
        state.jobs = await res.json();
      }
    } catch (e) {
      console.error('Failed to load jobs:', e);
    }
  }

  async function openFile(filePath) {
    state.mobileTab = 'code';
    const existing = state.openTabs.find(t => t.path === filePath);
    if (existing) {
      state.activeTabPath = filePath;
      render();
      return;
    }

    try {
      const res = await apiFetch(`/api/workspace/file?path=${encodeURIComponent(filePath)}`);
      if (res.ok) {
        const data = await res.json();
        const ext = (data.path.split('.').pop() || '').toLowerCase();
        const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'];
        const isImg = !!data.isImage || imgExts.includes(ext);

        const tab = {
          path: data.path,
          name: data.path.split('/').pop(),
          content: data.content,
          originalContent: data.content,
          isDirty: false,
          isImage: isImg,
          format: (data.format || ext).toUpperCase(),
          mimeType: data.mimeType,
          zoomMode: 'fit',
          zoomScale: 100
        };
        state.openTabs.push(tab);
        state.activeTabPath = data.path;
        render();
      }
    } catch (e) {
      alert(`Error loading file: ${e.message}`);
    }
  }

  async function saveActiveFile() {
    const tab = state.openTabs.find(t => t.path === state.activeTabPath);
    if (!tab) return;

    try {
      const res = await apiFetch('/api/workspace/file', {
        method: 'POST',
        body: JSON.stringify({ path: tab.path, content: tab.content })
      });
      if (res.ok) {
        tab.originalContent = tab.content;
        tab.isDirty = false;
        render();
      } else {
        const err = await res.json();
        alert(`Failed to save: ${err.detail || 'Unknown error'}`);
      }
    } catch (e) {
      alert(`Save error: ${e.message}`);
    }
  }

  async function createNewItem(isFolder) {
    if (isFolder) {
      state.modals.newFolder = true;
    } else {
      state.modals.newFile = true;
    }
    render();
  }

  async function deleteFile(filePath, isFolder = false) {
    if (!filePath) return;
    state.modals.deleteItem = { path: filePath, isFolder };
    render();
  }

  // --- WEBSOCKET LOG STREAMING ---
  function connectWebSocket(jobId) {
    if (state.currentWs) {
      state.currentWs.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/build/${jobId}`;

    state.activeJobLogs = `[${new Date().toLocaleTimeString()}] Connecting to DockForge build stream (${jobId})...\n`;
    state.terminalAutoScroll = true;
    state.terminalScrollTop = null;
    render();

    const ws = new WebSocket(wsUrl);
    state.currentWs = ws;

    ws.onmessage = (event) => {
      state.activeJobLogs += event.data;
      render();
    };

    ws.onclose = () => {
      state.activeJobLogs += `\n[${new Date().toLocaleTimeString()}] Stream closed. Execution complete.\n`;
      if (state.activeJobLogs.includes('GIT PUSH FINISHED SUCCESSFULLY')) {
        showToast('Git Push completed successfully!');
      } else if (state.activeJobLogs.includes('Git Push Failed') || state.activeJobLogs.includes('Push Rejected') || state.activeJobLogs.includes('💥 Error: /workspace is not a Git repository')) {
        showToast('Git Push failed. Check Build Console for details.', true);
      } else if (state.activeJobLogs.includes('DOCKER BUILD FINISHED SUCCESSFULLY') || state.activeJobLogs.includes('LOCAL DOCKER BUILD FINISHED SUCCESSFULLY') || state.activeJobLogs.includes('BUILD & PUSH JOB FINISHED SUCCESSFULLY') || state.activeJobLogs.includes('Successfully built')) {
        const buildTag = state.dockerTargetImageTagInput || state.dockerLocalTagInput || 'latest';
        const parsed = parseRepoAndTag(buildTag);
        const activeRepoName = getCurrentRepoName();
        state.lastLocalBuild = {
          ready: true,
          projectName: activeRepoName,
          imageName: parsed.repo,
          tag: buildTag,
          parsedRepo: parsed.repo,
          parsedTag: parsed.tag,
          timestamp: new Date().toLocaleTimeString()
        };
        state.dockerImageInput = parsed.repo;
        state.dockerTagInput = parsed.tag;
        safeLocalStorageSet('dockforge_last_build', JSON.stringify(state.lastLocalBuild));
        showToast(`Docker image build completed (${parsed.repo}:${parsed.tag})!`);
      } else if (state.activeJobLogs.includes('DOCKER PUSH FINISHED SUCCESSFULLY') || state.activeJobLogs.includes('Successfully pushed')) {
        showToast('Docker image push completed successfully!');
      }
      loadJobs();
      render();
    };

    ws.onerror = (err) => {
      state.activeJobLogs += `\n[ERROR] WebSocket error occurred.\n`;
      render();
    };
  }

  // --- GLOBAL UI ERROR BOUNDARY FALLBACK ---
  function renderErrorBoundary(error) {
    const appEl = document.getElementById('app');
    if (!appEl) return;

    const errorMsg = error?.message || error?.toString() || 'An unexpected application error occurred.';
    const errorStack = error?.stack || '';

    appEl.innerHTML = `
      <div class="min-h-screen flex items-center justify-center bg-slate-900 text-slate-100 p-6 font-sans">
        <div class="max-w-md w-full bg-slate-800 border border-red-500/30 rounded-xl p-6 shadow-2xl space-y-4">
          <div class="flex items-center space-x-3 text-red-400">
            <i class="fa-solid fa-triangle-exclamation text-2xl"></i>
            <h2 class="text-lg font-bold text-white">Application Error Caught</h2>
          </div>
          <p class="text-sm text-slate-300">
            DockForge encountered an unhandled error while rendering the interface.
          </p>
          <div class="bg-slate-950 p-3 rounded-lg border border-slate-700 font-mono text-xs text-red-300 overflow-x-auto max-h-40">
            ${escapeHtml(errorMsg)}
            ${errorStack ? `<pre class="mt-2 text-[10px] text-slate-500">${escapeHtml(errorStack)}</pre>` : ''}
          </div>
          <div class="flex justify-end space-x-3 pt-2">
            <button onclick="window.location.reload()" class="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs rounded-lg transition shadow-sm">
              <i class="fa-solid fa-rotate-right mr-1.5"></i> Reload App
            </button>
          </div>
        </div>
      </div>
    `;
  }

  // --- UI RENDER ROUTINES ---
  function render() {
    try {
      const appEl = document.getElementById('app');
      if (!appEl) return;

      if (!state.token) {
        appEl.innerHTML = renderAuthOverlay();
        attachAuthEvents();
        return;
      }

      const isMobileFiles = state.mobileTab === 'files';
      const isMobileCode = state.mobileTab === 'code';
      const isMobileConsole = state.mobileTab === 'console';

      appEl.innerHTML = `
        ${renderHeader()}
        <div class="flex-1 flex flex-col md:flex-row min-w-0 min-h-0 overflow-hidden relative">
          <!-- Sidebar / File Explorer Panel -->
          <div class="${isMobileFiles ? 'flex' : 'hidden'} md:flex w-full md:w-72 lg:w-80 h-full shrink-0 flex-col overflow-hidden">
            ${renderSidebar()}
          </div>

          <!-- Code Editor Panel -->
          <main class="${isMobileCode ? 'flex' : 'hidden'} md:flex flex-1 flex-col min-w-0 min-h-0 w-full h-full dark:bg-slate-950 bg-white dark:text-slate-100 text-slate-800 overflow-hidden">
            ${renderEditorTabs()}
            ${!state.terminalMaximized ? renderEditorBody() : ''}
            ${!state.editorMaximized ? `<div class="${state.terminalMaximized ? 'flex-1 min-h-0 h-full' : 'h-56 md:h-64 shrink-0 min-h-0'} hidden md:flex flex-col border-t dark:border-slate-800 border-slate-200 w-full overflow-hidden">${renderTerminalLogs()}</div>` : ''}
          </main>

          <!-- Console Terminal Panel (Mobile Standalone View) -->
          <div class="${isMobileConsole ? 'flex' : 'hidden'} md:hidden w-full h-full flex-col min-w-0 min-h-0 overflow-hidden bg-slate-900">
            ${renderTerminalLogs(true)}
          </div>
        </div>
        ${renderMobileNav()}
        ${renderModals()}
      `;

      attachEvents();
    } catch (err) {
      console.error('[DockForge] Unhandled UI Render Error:', err);
      renderErrorBoundary(err);
    }
  }

  function renderAuthOverlay() {
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/90 bg-slate-900/80 backdrop-blur-md p-4">
        <div class="w-full max-w-md dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl shadow-2xl overflow-hidden p-8 dark:text-slate-100 text-slate-800">
          <div class="text-center mb-8">
            <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600/10 border border-blue-500/20 text-blue-500 mb-4 overflow-hidden p-2">
              <img src="/frontend/public/logo.png" alt="DockForge Logo" class="w-full h-full object-contain" onerror="this.onerror=null; this.src='/public/logo.png';" />
            </div>
            <h1 class="text-2xl font-bold dark:text-white text-slate-900 tracking-tight">Welcome to DockForge</h1>
            <p class="text-sm dark:text-slate-400 text-slate-500 mt-1">Self-Hosted Docker CI/CD & Browser IDE</p>
          </div>

          <form id="auth-form" class="space-y-4" autocomplete="off">
            <div id="auth-error" class="hidden p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-xs font-medium"></div>
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Username</label>
              <input type="text" id="auth-username" value="" placeholder="Enter username" required
                autocomplete="new-password" data-lpignore="true"
                class="w-full px-4 py-2.5 rounded-lg dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 dark:text-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition" />
            </div>
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Password</label>
              <input type="password" id="auth-password" value="" placeholder="Enter password" required
                autocomplete="new-password" data-lpignore="true"
                class="w-full px-4 py-2.5 rounded-lg dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 dark:text-white text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition" />
            </div>
            <button type="submit"
              class="w-full py-3 px-4 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg shadow-lg shadow-blue-600/25 transition active:scale-[0.98]">
              Sign In to Dashboard
            </button>
          </form>
          <div class="mt-6 text-center text-xs dark:text-slate-500 text-slate-400 font-medium">
            <i class="fa-solid fa-shield-halved mr-1 text-blue-500"></i> DockForge Self-Hosted Security Portal
          </div>
        </div>
      </div>
    `;
  }

  function getDockerHubConfig() {
    const dhUser = (state.settings && (state.settings.dockerhub_username || state.settings.docker_username || state.settings.dockerHubUsername || state.settings.username)) ||
                   (state.currentCredentials && (state.currentCredentials.dockerhub_username || state.currentCredentials.docker_username)) ||
                   safeLocalStorageGet('dockforge_dh_username') || '';

    let username = dhUser ? dhUser.trim() : '';
    let repoName = '';

    // Determine target repository for current project / build
    let rawRepo = '';
    if (state.dockerImageInput && state.dockerImageInput !== 'my-username/my-service') {
      rawRepo = state.dockerImageInput.trim();
    } else if (state.lastLocalBuild && state.lastLocalBuild.image_name) {
      rawRepo = state.lastLocalBuild.image_name.trim();
    } else if (state.lastLocalBuild && state.lastLocalBuild.tag && state.lastLocalBuild.tag.includes('/')) {
      rawRepo = state.lastLocalBuild.tag.split(':')[0].trim();
    } else if ((state.activeProject && state.activeProject !== 'No Project Loaded') || (state.activeRepo && state.activeRepo.name && state.activeRepo.name !== 'No Project Loaded')) {
      rawRepo = getCurrentRepoName();
    }

    if (rawRepo) {
      if (rawRepo.includes('/')) {
        const parts = rawRepo.split('/');
        if (!username) {
          username = parts[0].trim();
        }
        repoName = parts.slice(1).join('/').split(':')[0].trim();
      } else {
        repoName = rawRepo.split(':')[0].trim();
      }
    }

    // Ignore default fallback if no actual project or image is targeted
    if (repoName === 'dockforge' && (!state.activeProject || state.activeProject === 'No Project Loaded') && (!state.activeRepo || state.activeRepo.name === 'No Project Loaded') && !state.dockerImageInput && !state.lastLocalBuild) {
      repoName = '';
    }

    let url = 'https://hub.docker.com';
    let title = 'Open Docker Hub (Configure Docker Hub credentials in Settings)';

    if (username && repoName) {
      url = `https://hub.docker.com/r/${username}/${repoName}`;
      title = `Open Docker Hub Repository: ${username}/${repoName} (${url})`;
    } else if (username) {
      url = `https://hub.docker.com/repositories/${username}`;
      title = `Open Docker Hub Repositories for ${username} (${url})`;
    } else if (repoName) {
      url = `https://hub.docker.com/search?q=${encodeURIComponent(repoName)}`;
      title = `Search Docker Hub for ${repoName} (${url}) - Configure credentials in Settings`;
    }

    return { url, title, username, repoName };
  }

  function renderHeader() {
    let githubUrl = 'https://github.com';
    const repoPathVal = state.repoPath || (state.activeRepo && state.activeRepo.full_name) || '';
    const repoUrlVal = (state.activeRepo && state.activeRepo.url) || state.currentRepoUrl || '';
    if (repoUrlVal && repoUrlVal.startsWith('http')) {
      githubUrl = repoUrlVal;
    } else if (repoPathVal && repoPathVal !== 'No Project Loaded') {
      githubUrl = repoPathVal.startsWith('http') ? repoPathVal : `https://github.com/${repoPathVal}`;
    }

    const dhConfig = getDockerHubConfig();
    const dockerhubUrl = dhConfig.url;
    const dockerhubTitle = dhConfig.title;

    return `
      <header class="relative z-30 flex flex-col shrink-0 border-b dark:bg-slate-900 bg-white dark:border-slate-800 border-slate-200 shadow-sm transition-colors">
        <div class="h-14 px-4 flex items-center justify-between">
          <div class="flex items-center space-x-2 truncate">
            <div class="flex items-center shrink-0">
              <img src="/frontend/public/logo.png" alt="DockForge Logo" class="h-[45px] w-[45px] object-contain" onerror="this.onerror=null; this.src='/public/logo.png';" />
              <span class="font-bold text-2xl dark:text-white text-slate-900 tracking-wide uppercase ml-2">DOCKFORGE</span>
            </div>

            <div class="h-6 w-px dark:bg-slate-800 bg-slate-200 ml-1.5 mr-1 hidden sm:block"></div>

            <!-- HEADER ACTIVE PROJECT BADGE -->
            ${((state.activeProject && state.activeProject !== 'No Project Loaded') || (state.activeRepo && state.activeRepo.full_name && state.activeRepo.name !== 'No Project Loaded')) ? `
              <div class="px-2.5 py-1 ml-[10px] rounded-lg border dark:border-slate-700 border-slate-300 dark:bg-slate-800 bg-slate-100 text-xs font-bold flex items-center space-x-1.5 transition shadow-sm" title="Active Project">
                <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
                <span class="font-extrabold text-xs md:text-sm tracking-wide dark:text-amber-400 text-amber-600 truncate max-w-[150px] sm:max-w-[220px] md:max-w-[280px]">
                  ${escapeHtml(formatProjectTitle(state.activeProject || state.activeRepo.name))}
                </span>
              </div>
            ` : ''}
          </div>

          <!-- Desktop Navigation Actions -->
          <div class="hidden md:flex items-center space-x-2 shrink-0">

            <!-- Git Actions Group -->
            <div class="flex items-center space-x-1 p-1 mr-[5px] rounded-lg bg-slate-50/60 dark:bg-slate-800/40 border border-purple-200/80 dark:border-slate-700/50 shadow-2xs">
              <button id="btn-pull" class="h-8 px-2.5 text-xs font-semibold bg-purple-600 hover:bg-purple-500 text-white rounded-md shadow-2xs flex items-center space-x-1.5 transition border border-purple-500/30 cursor-pointer" title="Git Pull Repository">
                <i class="fa-solid fa-code-branch text-purple-100 text-[14px] mr-0"></i>
                <span>Git Pull</span>
              </button>

              <button id="btn-push" class="h-8 px-2.5 text-xs font-semibold bg-purple-700 hover:bg-purple-600 text-white rounded-md shadow-2xs flex items-center space-x-1.5 transition border border-purple-600/30 cursor-pointer" title="Git Push / Commit Changes">
                <i class="fa-solid fa-code-commit text-purple-100 text-[14px] mr-0"></i>
                <span>Git Push</span>
              </button>

              <!-- GitHub External Link Button -->
              <a href="${escapeHtml(githubUrl)}" target="_blank" rel="noopener noreferrer" class="h-8 w-[42px] px-0 text-xs font-semibold bg-purple-800 hover:bg-purple-700 text-white rounded-md border border-purple-700/40 flex items-center justify-center transition shadow-2xs cursor-pointer" title="Open GitHub Repository (${escapeHtml(githubUrl)})">
                <span class="w-6 h-6 rounded-full bg-white flex items-center justify-center shrink-0 shadow-2xs">
                  <i class="fa-brands fa-github text-slate-900 text-[15px]"></i>
                </span>
              </a>
            </div>

            <!-- Divider Line between Git and Docker groups -->
            <div class="h-5 w-px dark:bg-slate-800 bg-slate-200 shrink-0 ml-[6px]"></div>

            <!-- Docker Container/Image Actions Group -->
            <div class="flex items-center space-x-1 p-1 ml-[5px] rounded-lg bg-slate-50/60 dark:bg-slate-800/40 border border-blue-200/80 dark:border-slate-700/50 shadow-2xs">
              <button id="btn-build-image" class="h-8 px-2.5 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-md shadow-2xs flex items-center space-x-1.5 transition border border-blue-500/30 cursor-pointer" title="Build Docker Container Image">
                <i class="fa-solid fa-layer-group text-blue-100 text-[15px] mr-0"></i>
                <span>Image Build</span>
              </button>

              <button id="btn-push-docker" ${isBuildReadyForCurrentProject() ? '' : 'disabled'} class="h-8 px-2.5 text-xs font-semibold ${isBuildReadyForCurrentProject() ? 'bg-blue-700 hover:bg-blue-600 text-white shadow-2xs border border-blue-600/30 cursor-pointer' : 'bg-slate-100 dark:bg-slate-800/60 text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-slate-800 opacity-50 cursor-not-allowed pointer-events-none'} rounded-md flex items-center space-x-1.5 transition" title="${isBuildReadyForCurrentProject() ? 'Push Docker Image to Registry' : 'Please build the image for this project before pushing to Docker Hub'}">
                <i class="fa-solid fa-rocket ${isBuildReadyForCurrentProject() ? 'text-blue-100' : 'text-slate-400 dark:text-slate-500'} text-[15px] mr-0"></i>
                <span>Image Push</span>
              </button>

              <!-- DockerHub External Link Button -->
              <a href="${escapeHtml(dockerhubUrl)}" target="_blank" rel="noopener noreferrer" class="h-8 w-[42px] px-0 text-xs font-semibold bg-blue-800 hover:bg-blue-700 text-white rounded-md border border-blue-700/40 flex items-center justify-center transition shadow-2xs cursor-pointer" title="${escapeHtml(dockerhubTitle)}">
                <span class="w-6 h-6 rounded-full bg-white flex items-center justify-center shrink-0 shadow-2xs">
                  <i class="fa-brands fa-docker text-blue-600 text-[15px]"></i>
                </span>
              </a>
            </div>

            <!-- Divider Line between Docker and Logs/Settings groups -->
            <div class="h-5 w-px dark:bg-slate-800 bg-slate-200 shrink-0"></div>

            <!-- Logs & Settings Actions Group -->
            <div class="flex items-center space-x-1 p-1 ml-[5px] rounded-lg bg-slate-50/60 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/50 shadow-2xs">
              <!-- Logs Button -->
              <button id="btn-jobs" class="h-8 px-2.5 text-xs font-semibold bg-[#F1F5F9] hover:bg-slate-200 text-slate-800 rounded-md border border-slate-300/80 flex items-center space-x-1.5 transition shadow-2xs cursor-pointer" title="Build & Push Logs">
                <i class="fa-solid fa-list-check text-purple-700 text-[15px] mr-0"></i>
                <span>Logs</span>
              </button>

              <!-- Settings Button (Icon-Only with upgraded mechanical cogwheel SVG) -->
              <button id="btn-settings" class="h-8 w-[37px] ml-[3px] px-0 text-xs font-semibold bg-[#F1F5F9] hover:bg-slate-200 text-slate-800 rounded-md border border-slate-300/80 flex items-center justify-center transition shadow-2xs cursor-pointer" title="Settings">
                <svg class="w-[20px] h-[20px] text-slate-700 m-0" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                  <path fill-rule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.532 1.532 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.532 1.532 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clip-rule="evenodd"/>
                </svg>
              </button>

              <!-- Vertical Divider Line between Settings and Sign Out -->
              <div class="h-4 w-px bg-slate-300 dark:bg-slate-700 my-auto shrink-0 mx-0.5"></div>

              <!-- Sign Out Button (Icon-Only, matching Settings cog) -->
              <button id="btn-logout" class="h-8 w-[35px] text-xs font-semibold bg-[#F1F5F9] hover:bg-red-100/80 text-slate-800 rounded-md border border-slate-300/80 flex items-center justify-center transition shadow-2xs cursor-pointer" title="Sign Out">
                <i class="fa-solid fa-right-from-bracket text-red-600 text-[15px]"></i>
              </button>
            </div>
          </div>

          <!-- Mobile Hamburger / Overflow Menu Button -->
          <div class="flex md:hidden items-center space-x-2">
            <button id="btn-mobile-menu" class="p-2.5 rounded-lg dark:bg-slate-800 bg-slate-100 dark:text-slate-200 text-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700 transition flex items-center justify-center min-w-[40px] min-h-[40px]" title="Toggle Menu">
              <i class="fa-solid ${state.mobileMenuOpen ? 'fa-xmark text-lg' : 'fa-ellipsis-vertical text-lg'}"></i>
            </button>
          </div>
        </div>

        <!-- Mobile Collapsible Menu Drawer -->
        ${state.mobileMenuOpen ? `
          <div class="md:hidden border-t dark:border-slate-800 border-slate-200 dark:bg-slate-900/95 bg-slate-100/95 backdrop-blur-md p-3 grid grid-cols-2 gap-2 text-xs shadow-xl transition-all">
            <!-- Mobile Local Build Status Badge -->
            <div class="col-span-2 p-2 rounded-lg dark:bg-slate-800/80 bg-white border dark:border-slate-700 border-slate-300 flex items-center justify-between text-xs">
              <span class="font-medium text-slate-400">Local Build:</span>
              ${state.lastLocalBuild && state.lastLocalBuild.ready ? `
                <span class="text-emerald-500 font-semibold flex items-center space-x-1">
                  <span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  <span>Ready (${escapeHtml(state.lastLocalBuild.tag)})</span>
                </span>
              ` : `
                <span class="text-slate-500 flex items-center space-x-1">
                  <span class="w-2 h-2 rounded-full bg-slate-400"></span>
                  <span>No Active Build</span>
                </span>
              `}
            </div>

            <button id="btn-pull-mobile" class="p-2.5 rounded-lg bg-purple-600 text-white flex items-center space-x-2 shadow-sm hover:bg-purple-500 transition active:scale-95">
              <i class="fa-solid fa-code-branch text-purple-100 text-sm"></i>
              <span class="font-medium">Git Pull</span>
            </button>

            <button id="btn-push-mobile" class="p-2.5 rounded-lg bg-purple-800 text-white flex items-center space-x-2 shadow-sm hover:bg-purple-700 transition active:scale-95">
              <i class="fa-solid fa-code-commit text-purple-100 text-sm"></i>
              <span class="font-medium">Git Push</span>
            </button>

            <button id="btn-build-image-mobile" class="p-2.5 rounded-lg bg-blue-600 text-white flex items-center space-x-2 shadow-sm hover:bg-blue-500 transition active:scale-95">
              <i class="fa-solid fa-layer-group text-blue-200 text-sm"></i>
              <span class="font-medium">Image Build</span>
            </button>

            <button id="btn-push-docker-mobile" class="p-2.5 rounded-lg ${state.lastLocalBuild && state.lastLocalBuild.ready ? 'bg-indigo-600 text-white' : 'bg-indigo-600/80 text-white/90'} flex items-center space-x-2 shadow-sm hover:bg-indigo-500 transition active:scale-95">
              <i class="fa-solid fa-rocket text-indigo-200 text-sm"></i>
              <span class="font-medium">Image Push</span>
            </button>

            <button id="btn-jobs-mobile" class="p-2.5 rounded-lg dark:bg-slate-800 bg-white border dark:border-slate-700 border-slate-300 dark:text-slate-200 text-slate-800 flex items-center space-x-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition active:scale-95">
              <i class="fa-solid fa-list-check text-purple-500 text-sm"></i>
              <span class="font-medium">Logs</span>
            </button>

            <button id="btn-settings-mobile" class="p-2.5 rounded-lg dark:bg-slate-800 bg-white border dark:border-slate-700 border-slate-300 dark:text-slate-200 text-slate-800 flex items-center space-x-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition active:scale-95">
              <i class="fa-solid fa-gear text-amber-500 text-sm"></i>
              <span class="font-medium">Settings</span>
            </button>

            <a href="${escapeHtml(githubUrl)}" target="_blank" rel="noopener noreferrer" class="p-2.5 rounded-lg dark:bg-slate-800 bg-white border dark:border-slate-700 border-slate-300 dark:text-slate-200 text-slate-800 flex items-center space-x-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition active:scale-95">
              <span class="w-5 h-5 rounded-full bg-slate-900 dark:bg-white flex items-center justify-center shrink-0">
                <i class="fa-brands fa-github text-white dark:text-slate-900 text-xs"></i>
              </span>
              <span class="font-medium">GitHub</span>
            </a>

            <a href="${escapeHtml(dockerhubUrl)}" target="_blank" rel="noopener noreferrer" class="p-2.5 rounded-lg dark:bg-slate-800 bg-white border dark:border-slate-700 border-slate-300 dark:text-slate-200 text-slate-800 flex items-center space-x-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition active:scale-95" title="${escapeHtml(dockerhubTitle)}">
              <span class="w-5 h-5 rounded-full bg-blue-500/20 dark:bg-white flex items-center justify-center shrink-0">
                <i class="fa-brands fa-docker text-blue-600 text-xs"></i>
              </span>
              <span class="font-medium">DockerHub</span>
            </a>

            <button id="btn-logout-mobile" class="col-span-2 p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 flex items-center justify-center space-x-2 hover:bg-red-500/20 transition active:scale-95">
              <i class="fa-solid fa-right-from-bracket text-sm"></i>
              <span class="font-medium">Sign Out</span>
            </button>
          </div>
        ` : ''}
      </header>
    `;
  }

  function renderMobileNav() {
    const isFiles = state.mobileTab === 'files';
    const isCode = state.mobileTab === 'code';
    const isConsole = state.mobileTab === 'console';
    const hasDirtyTabs = state.openTabs.some(t => t.isDirty);

    return `
      <nav class="md:hidden h-14 dark:bg-slate-900/95 bg-slate-100/95 backdrop-blur-md border-t dark:border-slate-800 border-slate-200 flex items-center justify-around shrink-0 select-none z-20 text-xs font-medium">
        <button id="nav-tab-files" class="flex-1 h-full flex flex-col items-center justify-center space-y-1 transition active:bg-slate-200 dark:active:bg-slate-800 ${isFiles ? 'text-blue-500 font-semibold dark:bg-slate-950/60 bg-white border-t-2 border-blue-500' : 'dark:text-slate-400 text-slate-600 dark:hover:text-slate-200'}">
          <i class="fa-solid fa-folder-tree text-base"></i>
          <span>Files</span>
        </button>

        <button id="nav-tab-code" class="flex-1 h-full flex flex-col items-center justify-center space-y-1 transition active:bg-slate-200 dark:active:bg-slate-800 ${isCode ? 'text-blue-500 font-semibold dark:bg-slate-950/60 bg-white border-t-2 border-blue-500' : 'dark:text-slate-400 text-slate-600 dark:hover:text-slate-200'} relative">
          <i class="fa-solid fa-code text-base"></i>
          <div class="flex items-center space-x-1">
            <span>Code</span>
            ${hasDirtyTabs ? '<span class="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block"></span>' : ''}
          </div>
        </button>

        <button id="nav-tab-console" class="flex-1 h-full flex flex-col items-center justify-center space-y-1 transition active:bg-slate-200 dark:active:bg-slate-800 ${isConsole ? 'text-blue-500 font-semibold dark:bg-slate-950/60 bg-white border-t-2 border-blue-500' : 'dark:text-slate-400 text-slate-600 dark:hover:text-slate-200'}">
          <i class="fa-solid fa-terminal text-base"></i>
          <span>Console</span>
        </button>
      </nav>
    `;
  }

  function renderSidebar() {
    return `
      <aside class="w-full h-full dark:bg-slate-900 bg-slate-50 dark:border-slate-800 border-slate-200 flex flex-col shrink-0 select-none md:border-r">
        <!-- FULL REPOSITORY SUB-HEADER IN SIDEBAR -->
        <div class="px-3 py-2 border-b dark:border-slate-800 border-slate-200 dark:bg-slate-950/60 bg-slate-100/80 flex items-center justify-between text-xs">
          <div class="flex items-center space-x-1.5 truncate min-w-0 pr-1">
            <i class="fa-brands fa-github text-slate-400 shrink-0 text-[18px]"></i>
            <span class="font-mono font-bold dark:text-slate-200 text-slate-800 truncate text-xs" title="${escapeHtml(state.repoPath || (state.activeRepo && state.activeRepo.full_name ? state.activeRepo.full_name : 'No Repository Loaded'))}">
              ${escapeHtml(state.repoPath || (state.activeRepo && state.activeRepo.full_name ? state.activeRepo.full_name : 'No Repository Loaded'))}
            </span>
          </div>
          ${(state.activeBranch || (state.activeRepo && state.activeRepo.branch)) && (state.repoPath || (state.activeRepo && state.activeRepo.full_name)) ? `
            <span class="px-1.5 py-0.5 text-[10px] font-mono rounded bg-blue-500/10 text-blue-500 dark:text-blue-400 border border-blue-500/20 shrink-0 flex items-center space-x-1" title="Active Branch">
              <i class="fa-solid fa-code-branch text-[9px]"></i>
              <span>${escapeHtml(state.activeBranch || state.activeRepo.branch)}</span>
            </span>
          ` : ''}
        </div>

        <div class="p-3 border-b dark:border-slate-800 border-slate-200 flex items-center justify-between text-slate-400">
          <span class="text-xs font-semibold uppercase tracking-wider dark:text-slate-400 text-slate-600">Workspace Files</span>
          <div class="flex items-center space-x-1">
            <button id="btn-new-file" class="p-1 dark:hover:text-white hover:text-slate-900 rounded transition" title="New File">
              <i class="fa-solid fa-file-circle-plus text-xs"></i>
            </button>
            <button id="btn-new-folder" class="p-1 dark:hover:text-white hover:text-slate-900 rounded transition" title="New Folder">
              <i class="fa-solid fa-folder-plus text-xs"></i>
            </button>
            <button id="btn-refresh-tree" class="p-1 dark:hover:text-white hover:text-slate-900 rounded transition" title="Refresh Tree">
              <i class="fa-solid fa-arrows-rotate text-xs"></i>
            </button>
            <button id="btn-clear-tree" class="p-1 dark:hover:text-red-400 hover:text-red-600 text-slate-400 rounded transition" title="Clear Workspace">
              <i class="fa-solid fa-eraser text-xs"></i>
            </button>
          </div>
        </div>
        <div id="workspace-tree-container" class="flex-1 overflow-y-auto p-2 text-xs space-y-0.5 webkit-overflow-scrolling-touch rounded-lg transition-all duration-150 relative min-h-[150px]" title="Drag items here or drop onto folders to move them">
          ${renderTreeNodes(state.files)}
        </div>
      </aside>
    `;
  }

  function renderTreeNodes(nodes, depth = 0, parentPath = '') {
    if (!nodes || nodes.length === 0) {
      if (depth === 0) {
        return `<div class="p-4 text-center dark:text-slate-500 text-slate-400 select-none">Workspace is empty.<br>Pull a repo or create files.</div>`;
      }
      return '';
    }

    const dirOrder = state.treeOrder ? (state.treeOrder[parentPath] || []) : [];
    let sortedNodes = [...nodes];
    if (dirOrder && dirOrder.length > 0) {
      sortedNodes.sort((a, b) => {
        const idxA = dirOrder.indexOf(a.name);
        const idxB = dirOrder.indexOf(b.name);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'folder' ? -1 : 1;
      });
    }

    return sortedNodes.map(node => {
      const isFolder = node.type === 'folder';
      const isExpanded = state.expandedFolders.has(node.path);
      const paddingLeft = `${depth * 12 + 8}px`;

      if (isFolder) {
        return `
          <div>
            <div class="tree-node tree-folder flex items-center justify-between px-2.5 py-1.5 rounded dark:hover:bg-slate-800 hover:bg-slate-200 dark:text-slate-300 text-slate-700 dark:hover:text-white hover:text-slate-900 cursor-grab active:cursor-grabbing group transition-all duration-150 select-none"
                 style="padding-left: ${paddingLeft}"
                 draggable="true"
                 data-drag-path="${escapeHtml(node.path)}"
                 data-is-folder="true"
                 data-node-name="${escapeHtml(node.name)}"
                 data-parent-path="${escapeHtml(parentPath)}"
                 data-folder-path="${escapeHtml(node.path)}"
                 title="Drag folder to reorder or move into directory">
              <div class="flex items-center space-x-1.5 truncate pr-2 min-w-0 pointer-events-none">
                <i class="fa-solid ${isExpanded ? 'fa-folder-open text-amber-400' : 'fa-folder text-amber-500'} shrink-0"></i>
                <span class="truncate font-medium">${escapeHtml(node.name)}</span>
              </div>
              <button class="btn-delete-file opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition shrink-0 pointer-events-auto" data-delete-path="${escapeHtml(node.path)}" data-is-folder="true" title="Delete Folder">
                <i class="fa-solid fa-xmark"></i>
              </button>
            </div>
            ${isExpanded ? renderTreeNodes(node.children, depth + 1, node.path) : ''}
          </div>
        `;
      }

      const isActive = state.activeTabPath === node.path;
      const ext = node.name.split('.').pop()?.toLowerCase();
      const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'];
      let icon = 'fa-file text-slate-400';
      if (node.name.toLowerCase().includes('dockerfile')) icon = 'fa-docker text-blue-500';
      else if (ext && imgExts.includes(ext)) icon = 'fa-file-image text-purple-400';
      else if (ext === 'py') icon = 'fa-brands fa-python text-amber-500';
      else if (ext === 'js' || ext === 'jsx') icon = 'fa-brands fa-square-js text-yellow-500';
      else if (ext === 'json') icon = 'fa-code text-emerald-500';
      else if (ext === 'md') icon = 'fa-file-lines text-slate-400';

      return `
        <div class="tree-node tree-file flex items-center justify-between px-2.5 py-1.5 rounded dark:hover:bg-slate-800 hover:bg-slate-200 cursor-grab active:cursor-grabbing group transition-all duration-150 select-none ${isActive ? 'bg-blue-600/20 text-blue-600 dark:text-blue-400 font-semibold' : 'dark:text-slate-400 text-slate-600 dark:hover:text-slate-200 hover:text-slate-900'}"
             style="padding-left: ${paddingLeft}"
             draggable="true"
             data-drag-path="${escapeHtml(node.path)}"
             data-is-folder="false"
             data-node-name="${escapeHtml(node.name)}"
             data-parent-path="${escapeHtml(parentPath)}"
             data-file-path="${escapeHtml(node.path)}"
             title="Drag file to reorder or move into directory">
          <div class="flex items-center space-x-2 truncate pr-2 min-w-0 pointer-events-none">
            <i class="fa-solid ${icon} shrink-0"></i>
            <span class="truncate">${escapeHtml(node.name)}</span>
          </div>
          <button class="btn-delete-file opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition shrink-0 pointer-events-auto" data-delete-path="${escapeHtml(node.path)}" data-is-folder="false" title="Delete File">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      `;
    }).join('');
  }

  function renderEditorTabs() {
    if (state.openTabs.length === 0) return '';

    return `
      <div class="h-10 dark:bg-slate-900 bg-slate-100 border-b dark:border-slate-800 border-slate-200 flex items-center px-2 space-x-1 overflow-x-auto shrink-0 select-none">
        ${state.openTabs.map(tab => {
          const isActive = state.activeTabPath === tab.path;
          const ext = (tab.name.split('.').pop() || '').toLowerCase();
          const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'];
          const isImg = tab.isImage || imgExts.includes(ext);
          const icon = isImg ? 'fa-file-image text-purple-400' : 'fa-file-code text-slate-400';

          return `
            <div class="flex items-center space-x-2 px-3 py-1.5 text-xs rounded-t-lg cursor-pointer border-t-2 transition ${isActive ? 'dark:bg-slate-950 bg-white border-blue-500 dark:text-white text-slate-900 font-semibold shadow-sm' : 'dark:bg-slate-900/50 bg-slate-200/60 border-transparent dark:text-slate-400 text-slate-600 hover:dark:bg-slate-800 hover:bg-slate-300 hover:text-slate-900'}"
                 data-tab-path="${tab.path}">
              <i class="fa-solid ${icon} text-xs"></i>
              <span>${tab.name}</span>
              ${tab.isDirty ? '<span class="w-2 h-2 rounded-full bg-amber-400"></span>' : ''}
              <button class="btn-close-tab hover:text-red-500 p-0.5 rounded transition" data-close-path="${tab.path}">
                <i class="fa-solid fa-xmark text-xs"></i>
              </button>
            </div>
          `;
        }).join('')}
      </div>
    `;
  }

  function renderEditorBody() {
    const activeTab = state.openTabs.find(t => t.path === state.activeTabPath);

    if (!activeTab) {
      return `
        <div class="flex-1 flex flex-col items-center justify-center p-8 dark:text-slate-600 text-slate-400 select-none dark:bg-slate-950 bg-white">
          <i class="fa-solid fa-code text-6xl mb-4 dark:text-slate-800 text-slate-200"></i>
          <p class="text-base font-medium dark:text-slate-400 text-slate-600">No File Selected</p>
          <p class="text-xs dark:text-slate-500 text-slate-400 mt-1">Select a file from workspace or create a new file to edit</p>
        </div>
      `;
    }

    const ext = (activeTab.name.split('.').pop() || '').toLowerCase();
    const imgExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico'];
    const isImage = activeTab.isImage || imgExts.includes(ext);

    if (isImage) {
      const fileFormat = (activeTab.format || ext).toUpperCase();
      const fileName = activeTab.name;
      if (!activeTab.zoomMode) activeTab.zoomMode = 'fit';
      if (!activeTab.zoomScale) activeTab.zoomScale = 100;

      const isFit = activeTab.zoomMode === 'fit';
      const currentScale = activeTab.zoomScale || 100;

      return `
        <div class="flex-1 flex flex-col w-full h-full min-h-0 dark:bg-slate-950 bg-white">
          <!-- Top Toolbar for Image Preview with Zoom Controls -->
          <div class="h-10 dark:bg-slate-900/90 bg-slate-100 px-4 border-b dark:border-slate-800 border-slate-200 flex items-center justify-between text-xs dark:text-slate-400 text-slate-600 shrink-0 select-none">
            <div class="flex items-center space-x-2 font-mono truncate max-w-[35%]">
              <i class="fa-solid fa-file-image text-purple-400 text-sm"></i>
              <span class="truncate font-medium dark:text-slate-200 text-slate-800">${escapeHtml(activeTab.path)}</span>
            </div>
            
            <div class="flex items-center space-x-3 shrink-0">
              <!-- Zoom & View Mode Controls -->
              <div class="flex items-center space-x-1 dark:bg-slate-800/80 bg-slate-200/80 p-0.5 rounded-lg border dark:border-slate-700/60 border-slate-300/60">
                <button id="btn-zoom-out" class="w-6 h-6 rounded flex items-center justify-center dark:hover:bg-slate-700 hover:bg-slate-300 dark:text-slate-300 text-slate-700 transition" title="Zoom Out (-)">
                  <i class="fa-solid fa-minus text-[10px]"></i>
                </button>
                
                <span id="zoom-level-badge" class="px-2 py-0.5 text-[11px] font-mono font-semibold dark:text-slate-200 text-slate-800 min-w-[3.5rem] text-center">
                  ${isFit ? 'Fit' : currentScale + '%'}
                </span>
                
                <button id="btn-zoom-in" class="w-6 h-6 rounded flex items-center justify-center dark:hover:bg-slate-700 hover:bg-slate-300 dark:text-slate-300 text-slate-700 transition" title="Zoom In (+)">
                  <i class="fa-solid fa-plus text-[10px]"></i>
                </button>

                <div class="h-3 w-px dark:bg-slate-700 bg-slate-300 mx-1"></div>

                <button id="btn-zoom-fit" class="px-2 py-0.5 text-[11px] rounded font-medium transition ${isFit ? 'bg-blue-600 text-white font-semibold shadow-sm' : 'dark:text-slate-300 text-slate-700 dark:hover:bg-slate-700 hover:bg-slate-300'}" title="Fit to Screen">
                  Fit Screen
                </button>

                <button id="btn-zoom-100" class="px-2 py-0.5 text-[11px] rounded font-medium transition ${!isFit && currentScale === 100 ? 'bg-blue-600 text-white font-semibold shadow-sm' : 'dark:text-slate-300 text-slate-700 dark:hover:bg-slate-700 hover:bg-slate-300'}" title="100% Size">
                  100%
                </button>

                <button id="btn-zoom-reset" class="w-6 h-6 rounded flex items-center justify-center dark:hover:bg-slate-700 hover:bg-slate-300 dark:text-slate-400 text-slate-600 transition" title="Reset View">
                  <i class="fa-solid fa-rotate-left text-[10px]"></i>
                </button>
              </div>

              <span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/20 uppercase">
                ${escapeHtml(fileFormat)}
              </span>

              <span id="image-dim-badge" class="dark:text-slate-400 text-slate-500 font-mono text-xs hidden sm:inline-block">
                Detecting dimensions...
              </span>

              <button id="btn-toggle-editor-max" class="p-1 dark:hover:text-white hover:text-slate-900 rounded transition flex items-center justify-center text-slate-400 hover:text-slate-200" title="${state.editorMaximized ? 'Restore View' : 'Maximize Preview'}">
                <i class="fa-solid ${state.editorMaximized ? 'fa-compress' : 'fa-expand'} text-xs"></i>
              </button>
            </div>
          </div>

          <!-- Centered Media Preview Container with Checkerboard Background -->
          <div class="w-full h-full flex-1 relative flex flex-col items-center justify-center p-6 overflow-auto select-none dark:bg-slate-950 bg-slate-100 min-h-0"
               style="background-image: radial-gradient(rgba(148, 163, 184, 0.15) 1px, transparent 1px); background-size: 16px 16px;">
            
            <div class="relative p-3 rounded-2xl dark:bg-slate-900 bg-white shadow-2xl border dark:border-slate-800 border-slate-300 flex flex-col items-center justify-center max-w-full max-h-full transition-all duration-200">
              <div class="rounded-xl overflow-hidden border dark:border-slate-700/80 border-slate-200 p-2 dark:bg-slate-950 bg-slate-100/80 shadow-inner flex items-center justify-center max-w-full max-h-full"
                   style="background-image: linear-gradient(45deg, rgba(148, 163, 184, 0.12) 25%, transparent 25%), linear-gradient(-45deg, rgba(148, 163, 184, 0.12) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148, 163, 184, 0.12) 75%), linear-gradient(-45deg, transparent 75%, rgba(148, 163, 184, 0.12) 75%); background-size: 20px 20px; background-position: 0 0, 0 10px, 10px -10px, -10px 0;">
                <div id="image-fallback-msg" class="hidden text-center p-8 text-red-400 font-medium text-xs space-y-2">
                  <i class="fa-solid fa-triangle-exclamation text-3xl mb-1 text-red-500 block"></i>
                  <span>Unable to display image preview</span>
                </div>
                <img id="image-preview-element"
                  src="${activeTab.content}"
                  alt="${escapeHtml(fileName)}"
                  class="${isFit ? 'max-w-full max-h-[calc(100vh-250px)] object-contain w-auto h-auto rounded-lg shadow-lg block transition-all duration-200' : 'object-contain rounded-lg shadow-lg block transition-transform duration-200'}"
                  style="${isFit ? '' : `transform: scale(${currentScale / 100}); transform-origin: center center; max-width: none; max-height: none;`}"
                  onload="
                    const dim = document.getElementById('image-dim-badge');
                    const infoBar = document.getElementById('image-info-bar');
                    if (dim) dim.textContent = this.naturalWidth + ' x ' + this.naturalHeight + ' px';
                    if (infoBar) infoBar.textContent = '${escapeHtml(fileName)} • ${escapeHtml(fileFormat)} • ' + this.naturalWidth + ' x ' + this.naturalHeight + ' px';
                  "
                  onerror="
                    const dim = document.getElementById('image-dim-badge');
                    const infoBar = document.getElementById('image-info-bar');
                    const fall = document.getElementById('image-fallback-msg');
                    if (dim) dim.textContent = 'Unable to display preview';
                    if (infoBar) infoBar.textContent = 'Unable to display image preview';
                    if (fall) fall.classList.remove('hidden');
                    this.classList.add('hidden');
                  "
                />
              </div>
            </div>

            <div class="mt-4 px-4 py-1.5 rounded-full dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-300 shadow-md text-xs font-mono dark:text-slate-300 text-slate-700 flex items-center space-x-2 shrink-0">
              <i class="fa-solid fa-circle-info text-purple-400 text-xs"></i>
              <span id="image-info-bar">${escapeHtml(fileName)} • ${escapeHtml(fileFormat)}</span>
            </div>
          </div>
        </div>
      `;
    }

    const lines = activeTab.content.split('\n').length;
    let lineNumbersHtml = '';
    for (let i = 1; i <= lines; i++) {
      lineNumbersHtml += `<div>${i}</div>`;
    }

    return `
      <div class="flex-1 flex flex-col min-h-0 dark:bg-slate-950 bg-white">
        <div class="h-8 dark:bg-slate-900/80 bg-slate-100 px-4 border-b dark:border-slate-800/80 border-slate-200 flex items-center justify-between text-xs dark:text-slate-400 text-slate-600 shrink-0">
          <span class="font-mono truncate max-w-[50%]">${activeTab.path}</span>
          <div class="flex items-center space-x-3 shrink-0">
            <span id="line-count-badge" class="dark:text-slate-400 text-slate-500 font-mono">${lines} ${lines === 1 ? 'line' : 'lines'}</span>
            <button id="btn-save-file" class="px-2.5 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition flex items-center space-x-1">
              <i class="fa-solid fa-floppy-disk"></i>
              <span>Save (Ctrl+S)</span>
            </button>
            <button id="btn-toggle-editor-max" class="p-1 dark:hover:text-white hover:text-slate-900 rounded transition flex items-center justify-center text-slate-400 hover:text-slate-200" title="${state.editorMaximized ? 'Restore View' : 'Maximize Editor'}">
              <i class="fa-solid ${state.editorMaximized ? 'fa-compress' : 'fa-expand'} text-xs"></i>
            </button>
          </div>
        </div>
        <div class="flex-1 relative flex overflow-hidden dark:bg-slate-950 bg-slate-50">
          <div id="editor-gutter" class="py-4 pl-3 pr-4 select-none text-gray-500 dark:text-slate-600 font-mono text-xs leading-relaxed text-right border-r dark:border-slate-800/80 border-slate-200 shrink-0 overflow-hidden bg-slate-100/50 dark:bg-slate-900/40 min-w-[3.25rem]">
            ${lineNumbersHtml}
          </div>
          <textarea id="code-editor" class="flex-1 h-full py-4 px-3 dark:bg-slate-950 bg-slate-50 dark:text-slate-100 text-slate-800 font-mono text-xs leading-relaxed focus:outline-none resize-none whitespace-pre overflow-auto"
                    spellcheck="false">${escapeHtml(activeTab.content)}</textarea>
        </div>
      </div>
    `;
  }

  function renderTerminalLogs(isMobileStandalone = false) {
    const isFull = isMobileStandalone || state.terminalMaximized || state.mobileTab === 'console';
    const containerClass = 'flex-1 w-full h-full bg-slate-900 flex flex-col min-h-0 relative overflow-hidden';
    const isAutoScrolling = state.terminalAutoScroll !== false;

    return `
      <div class="${containerClass}">
        <div class="h-8 px-4 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400 bg-slate-900 shrink-0 select-none">
          <div class="flex items-center space-x-2">
            <i class="fa-solid fa-terminal text-blue-400"></i>
            <span class="font-semibold uppercase tracking-wider text-slate-300">Build Console & Log Stream</span>
            ${!isAutoScrolling ? `
              <span class="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-amber-500/20 text-amber-400 border border-amber-500/30">
                <i class="fa-solid fa-pause text-[9px] mr-1"></i> Scroll Paused
              </span>
            ` : ''}
          </div>
          <div class="flex items-center space-x-2">
            ${!isAutoScrolling ? `
              <button id="btn-terminal-resume-autoscroll" class="px-2 py-0.5 text-[11px] bg-blue-600 hover:bg-blue-500 text-white rounded flex items-center space-x-1 transition shadow-sm" title="Jump to Bottom & Resume Auto-scroll">
                <i class="fa-solid fa-arrow-down text-[10px]"></i>
                <span>Scroll to Bottom</span>
              </button>
            ` : ''}
            <button id="btn-copy-logs" class="p-1 hover:text-white transition text-slate-400 hover:text-slate-200" title="Copy Console Logs">
              <i class="fa-solid fa-copy"></i>
            </button>
            <button id="btn-clear-logs" class="p-1 hover:text-white transition text-slate-400 hover:text-slate-200" title="Clear Console">
              <i class="fa-solid fa-trash-can"></i>
            </button>
            <button id="btn-toggle-terminal-max" class="p-1 hover:text-white transition hidden md:inline-block text-slate-400 hover:text-slate-200" title="${state.terminalMaximized ? 'Restore View' : 'Maximize Console'}">
              <i class="fa-solid ${state.terminalMaximized ? 'fa-compress' : 'fa-expand'} text-xs"></i>
            </button>
          </div>
        </div>
        <div class="flex-1 relative min-h-0 h-full w-full overflow-hidden bg-slate-950">
          <pre id="terminal-logs-body" class="absolute inset-0 p-4 overflow-y-auto font-mono text-xs text-emerald-400 whitespace-pre-wrap leading-relaxed select-text webkit-overflow-scrolling-touch min-h-0 max-h-full">${escapeHtml(state.activeJobLogs || 'Ready. Click "Image Build" to compile image and stream logs.')}<div id="terminal-scroll-anchor" class="h-0 w-0"></div></pre>
        </div>
      </div>
    `;
  }

  function renderModals() {
    return `
      ${state.modals.pull ? renderPullModal() : ''}
      ${state.modals.push ? renderPushModal() : ''}
      ${state.modals.build ? renderBuildModal() : ''}
      ${state.modals.pushDocker ? renderPushDockerModal() : ''}
      ${state.modals.jobs ? renderJobsModal() : ''}
      ${state.modals.settings ? renderSettingsModal() : ''}
      ${state.modals.newFile ? renderNewFileModal() : ''}
      ${state.modals.newFolder ? renderNewFolderModal() : ''}
      ${state.modals.clearWorkspace ? renderClearWorkspaceModal() : ''}
      ${state.modals.deleteItem ? renderDeleteItemModal() : ''}
    `;
  }

  function renderNewFileModal() {
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-md dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-file-circle-plus text-blue-500"></i>
              <span>Create New File</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <form id="form-new-file" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">File Path</label>
              <input type="text" id="input-new-file-path" required placeholder="e.g. src/index.js, Dockerfile, styles.css" autofocus
                     class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none" />
              <p class="text-[11px] dark:text-slate-400 text-slate-500 mt-1">Relative path to workspace root.</p>
            </div>
            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="submit" class="px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg flex items-center space-x-1.5 shadow-sm">
                <i class="fa-solid fa-plus text-xs"></i>
                <span>Create File</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderNewFolderModal() {
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-md dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-folder-plus text-amber-500"></i>
              <span>Create New Folder</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <form id="form-new-folder" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Folder Path</label>
              <input type="text" id="input-new-folder-path" required placeholder="e.g. src/components, public/assets" autofocus
                     class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none" />
              <p class="text-[11px] dark:text-slate-400 text-slate-500 mt-1">Relative path to workspace root.</p>
            </div>
            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="submit" class="px-4 py-2 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-lg flex items-center space-x-1.5 shadow-sm">
                <i class="fa-solid fa-plus text-xs"></i>
                <span>Create Folder</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderDeleteItemModal() {
    const item = state.modals.deleteItem;
    if (!item || !item.path) return '';
    const name = item.path.split('/').pop() || item.path;
    const isFolder = !!item.isFolder;

    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-md dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-triangle-exclamation text-red-500"></i>
              <span>Delete ${isFolder ? 'Folder' : 'File'}</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="space-y-4">
            <p class="text-xs dark:text-slate-300 text-slate-700">
              Are you sure you want to delete <strong class="font-mono text-red-400">${escapeHtml(name)}</strong>?
              ${isFolder ? 'All contents within this folder will be permanently removed.' : 'This action cannot be undone.'}
            </p>
            <div class="p-2.5 rounded-lg dark:bg-slate-800 bg-slate-100 font-mono text-xs dark:text-slate-400 text-slate-600 truncate">
              Path: ${escapeHtml(item.path)}
            </div>
            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="button" id="btn-confirm-delete-item" class="px-4 py-2 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg flex items-center space-x-1.5 shadow-sm">
                <i class="fa-solid fa-trash-can text-xs"></i>
                <span>Delete Permanently</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderClearWorkspaceModal() {
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-md dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-trash-can text-red-500"></i>
              <span>Clear Workspace</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="space-y-4">
            <p class="text-xs dark:text-slate-300 text-slate-700">
              Are you sure you want to delete <strong class="text-red-400">ALL files and folders</strong> in the workspace?
            </p>
            <div class="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              This action will permanently wipe all local files and reset your workspace tree.
            </div>
            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="button" id="btn-confirm-clear-workspace" class="px-4 py-2 text-xs font-medium bg-red-600 hover:bg-red-500 text-white rounded-lg flex items-center space-x-1.5 shadow-sm">
                <i class="fa-solid fa-broom text-xs"></i>
                <span>Wipe Workspace</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function renderPullModal() {
    const defaultUrl = state.pullRepoUrl || state.currentRepoUrl || '';
    const defaultBranch = state.pullBranch || 'main';
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-lg dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-download text-blue-500"></i>
              <span>Pull Git Repository</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <form id="form-pull" class="space-y-4">
            <div>
              <div class="flex items-center justify-between mb-2">
                <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider">Select Saved Repository</label>
                <div class="flex items-center space-x-2">
                  ${(state.repos || []).length > 0 ? `<span class="text-[11px] text-blue-500 dark:text-blue-400 font-medium">${state.repos.length} Repositories</span>` : ''}
                  <button type="button" id="btn-refresh-pull-repos" class="p-1 text-slate-400 hover:text-blue-500 transition" title="Refresh GitHub Repositories">
                    <i class="fa-solid fa-arrows-rotate text-xs ${state.loadingRepos ? 'animate-spin text-blue-500' : ''}"></i>
                  </button>
                </div>
              </div>
              <select id="select-pull-repo" class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none cursor-pointer">
                <option value="">-- Choose from your GitHub repositories --</option>
                ${(state.repos || []).map(r => {
                  const active = isCurrentRepo(r);
                  const icon = r.private ? '🔒' : '🌐';
                  return `<option value="${escapeHtml(r.clone_url)}" data-branch="${escapeHtml(r.default_branch || 'main')}" ${active ? 'selected' : ''}>
                    ${icon} ${escapeHtml(r.full_name)}
                  </option>`;
                }).join('')}
              </select>
            </div>

            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Repository URL</label>
              <input type="url" id="pull-url" value="${escapeHtml(defaultUrl)}" required placeholder="https://github.com/username/repository.git"
                     class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Branch</label>
              <input type="text" id="pull-branch" value="${escapeHtml(defaultBranch)}" required
                     class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none" />
            </div>
            <p class="text-[11px] dark:text-slate-400 text-slate-500">Private repositories automatically utilize your saved GitHub PAT from Settings.</p>
            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="submit" id="btn-submit-pull" class="px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg flex items-center space-x-1.5 shadow-sm">
                <i class="fa-solid fa-download text-xs"></i>
                <span>Pull Repo</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderPushModal() {
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-lg dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-code-commit text-emerald-500"></i>
              <span>Push Changes to GitHub</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <form id="form-push" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Commit Message</label>
              <textarea id="push-message" required rows="3" placeholder="e.g. Update Dockerfile dependencies"
                        class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none"></textarea>
            </div>
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Branch</label>
              <input type="text" id="push-branch" value="main" required
                     class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-emerald-500 focus:outline-none" />
            </div>
            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="submit" class="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg flex items-center space-x-1.5 shadow-sm">
                <i class="fa-solid fa-code-commit text-xs"></i>
                <span>Commit & Push</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function getCurrentRepoName() {
    let name = '';
    if (state.activeProject && state.activeProject !== 'No Project Loaded') {
      name = state.activeProject;
    } else if (state.activeRepo && state.activeRepo.name && state.activeRepo.name !== 'No Project Loaded') {
      name = state.activeRepo.name;
    } else if (state.repoPath && state.repoPath !== 'No Project Loaded') {
      name = state.repoPath.includes('/') ? state.repoPath.split('/')[1] : state.repoPath;
    } else if (state.currentRepoUrl) {
      const clean = state.currentRepoUrl.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
      name = clean.includes('/') ? clean.split('/').pop() : clean;
    }
    if (!name) name = 'dockforge';
    return name.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  }

  function isBuildReadyForCurrentProject() {
    const currentProject = getCurrentRepoName();
    if (!state.lastLocalBuild || !state.lastLocalBuild.ready) return false;
    if (state.lastLocalBuild.projectName) {
      return state.lastLocalBuild.projectName.toLowerCase() === currentProject.toLowerCase();
    }
    if (state.lastLocalBuild.tag && state.lastLocalBuild.tag.toLowerCase().includes(currentProject.toLowerCase())) {
      return true;
    }
    return false;
  }

  function resetProjectContextState(newRepoName = null) {
    const currentRepo = (newRepoName || getCurrentRepoName()).toLowerCase();
    
    if (state.lastLocalBuild) {
      if (state.lastLocalBuild.projectName && state.lastLocalBuild.projectName.toLowerCase() !== currentRepo) {
        state.lastLocalBuild = null;
        safeLocalStorageRemove('dockforge_last_build');
      } else if (state.lastLocalBuild.tag && !state.lastLocalBuild.tag.toLowerCase().includes(currentRepo)) {
        state.lastLocalBuild = null;
        safeLocalStorageRemove('dockforge_last_build');
      }
    }

    const dhUser = (state.settings && (state.settings.dockerhub_username || state.settings.docker_username || state.settings.username)) ||
                   (state.currentCredentials && (state.currentCredentials.dockerhub_username || state.currentCredentials.docker_username)) ||
                   safeLocalStorageGet('dockforge_dh_username') || '';

    const defaultTag = dhUser ? `${dhUser}/${currentRepo}:latest` : `${currentRepo}:latest`;
    state.dockerTargetImageTagInput = defaultTag;
    state.dockerImageInput = dhUser ? `${dhUser}/${currentRepo}` : currentRepo;
    state.dockerTagInput = 'latest';
    state.dockerLocalTagInput = defaultTag;
  }

  function parseRepoAndTag(rawInput) {
    const dhUser = (state.settings && (state.settings.dockerhub_username || state.settings.docker_username || state.settings.dockerHubUsername || state.settings.username)) ||
                   (state.currentCredentials && (state.currentCredentials.dockerhub_username || state.currentCredentials.docker_username)) ||
                   safeLocalStorageGet('dockforge_dh_username') || '';
    const currentWorkspaceName = getCurrentRepoName();

    let input = (rawInput || '').trim();

    if (input === 'my-username/my-service' || input === 'dockforge' || input === 'docker-image-builder') {
      input = '';
    }

    if (!input) {
      if (state.lastLocalBuild && state.lastLocalBuild.tag) {
        input = state.lastLocalBuild.tag.trim();
      } else if (state.dockerTargetImageTagInput) {
        input = state.dockerTargetImageTagInput.trim();
      }
    }

    let repo = '';
    let tag = state.dockerTagInput && state.dockerTagInput !== 'latest' ? state.dockerTagInput : 'latest';

    if (input) {
      if (input.includes(':')) {
        const parts = input.split(':');
        repo = parts[0].trim();
        tag = parts[1].trim() || tag;
      } else {
        repo = input;
      }
    }

    if (repo && repo !== 'my-username/my-service') {
      if (repo.includes('/')) {
        // Already contains slash, e.g. mattomeo15/ip-freely
      } else if (dhUser) {
        repo = `${dhUser}/${repo}`;
      }
    } else {
      repo = dhUser ? `${dhUser}/${currentWorkspaceName}` : currentWorkspaceName;
    }

    return { repo, tag };
  }

  function getJobTypeBadge(actionType) {
    const type = (actionType || 'build').toLowerCase();
    if (type === 'build' || type === 'docker_build') {
      return `<span class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md bg-blue-500/10 text-blue-400 border border-blue-500/20"><i class="fa-solid fa-layer-group text-[9px] mr-1"></i>BUILD</span>`;
    } else if (type === 'push' || type === 'docker_push') {
      return `<span class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md bg-purple-500/10 text-purple-400 border border-purple-500/20"><i class="fa-solid fa-rocket text-[9px] mr-1"></i>PUSH</span>`;
    } else if (type === 'git_pull' || type === 'pull') {
      return `<span class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"><i class="fa-solid fa-code-branch text-[9px] mr-1"></i>GIT PULL</span>`;
    } else if (type === 'git_push') {
      return `<span class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"><i class="fa-solid fa-code-commit text-[9px] mr-1"></i>GIT PUSH</span>`;
    }
    return `<span class="px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider rounded-md bg-slate-500/10 text-slate-400 border border-slate-500/20">${escapeHtml(type.toUpperCase())}</span>`;
  }

  function renderBuildModal() {
    const dhUser = state.settings?.dockerhub_username || state.settings?.docker_username || state.settings?.username || '';
    const currentRepoName = getCurrentRepoName();
    const defaultTag = dhUser ? `${dhUser}/${currentRepoName}:latest` : `${currentRepoName}:latest`;
    
    let currentTargetTag = state.dockerTargetImageTagInput;
    if (!currentTargetTag || !currentTargetTag.includes(currentRepoName)) {
      currentTargetTag = defaultTag;
      state.dockerTargetImageTagInput = defaultTag;
    }

    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-md dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-layer-group text-blue-500"></i>
              <span>Build Container Image</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>

          <form id="form-build-image" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Target Image Tag</label>
              <input type="text" id="build-target-image-tag" value="${escapeHtml(currentTargetTag)}" required placeholder="e.g. username/repository:tag or dockforge:latest"
                     class="w-full px-3 py-2.5 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs font-mono focus:ring-2 focus:ring-blue-500 focus:outline-none" />
              <p class="text-[11px] text-slate-400 mt-1.5">Defaulted to <code class="text-blue-400 font-mono">${escapeHtml(defaultTag)}</code>. You can customize this tag before building.</p>
            </div>

            <div class="p-3 rounded-lg dark:bg-slate-800/60 bg-slate-100 border dark:border-slate-700/60 border-slate-200 text-xs dark:text-slate-300 text-slate-600 space-y-1.5">
              <p class="font-medium text-slate-300 flex items-center space-x-1.5">
                <i class="fa-solid fa-info-circle text-blue-400"></i>
                <span>Build Specifications:</span>
              </p>
              <ul class="list-disc list-inside space-y-1 text-[11px] text-slate-400">
                <li>Context Directory: <span class="font-mono text-slate-300">/workspace</span></li>
                <li>Dockerfile: <span class="font-mono text-slate-300">Dockerfile</span></li>
                <li>Action: <span class="text-emerald-400 font-medium">Local Docker Compile Only</span> (Decoupled from Push)</li>
              </ul>
            </div>

            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="submit" class="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white rounded-lg flex items-center space-x-1.5 shadow-sm transition">
                <i class="fa-solid fa-play text-xs"></i>
                <span>Start Build</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderPushDockerModal() {
    const dhUser = state.settings?.dockerhub_username || state.settings?.docker_username || '';

    let inputToParse = state.dockerImageInput;
    if (!inputToParse || inputToParse === 'my-username/my-service') {
      inputToParse = (state.lastLocalBuild && state.lastLocalBuild.tag) || state.dockerTargetImageTagInput || '';
    }

    const { repo: currentRepoValue, tag: currentTagValue } = parseRepoAndTag(
      inputToParse && state.dockerTagInput ? `${inputToParse}:${state.dockerTagInput}` : inputToParse
    );

    state.dockerImageInput = currentRepoValue;
    state.dockerTagInput = currentTagValue;

    const hasSelectedInList = state.dockerHubRepos.some(r => r.full_name === currentRepoValue);

    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-lg dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-cloud-arrow-up text-purple-500"></i>
              <span>Push Image to Docker Hub</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>

          <!-- Active Local Build Banner -->
          <div class="p-3 mb-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-between text-xs">
            <div class="flex items-center space-x-2">
              <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
              <span class="dark:text-emerald-300 text-emerald-800 font-medium">Source Image: <strong id="push-source-image-banner" class="font-mono">${escapeHtml(currentRepoValue)}:${escapeHtml(currentTagValue)}</strong></span>
            </div>
            <span class="text-[11px] text-emerald-400/80 font-mono">Ready for registry upload</span>
          </div>

          ${dhUser ? `
            <div class="p-2.5 mb-4 rounded-lg dark:bg-slate-800/80 bg-slate-100 border dark:border-slate-700/60 border-slate-200 flex items-center justify-between text-xs">
              <div class="flex items-center space-x-2 truncate">
                <i class="fa-brands fa-docker text-blue-400 text-sm shrink-0"></i>
                <span class="font-medium dark:text-slate-200 text-slate-800 truncate">Docker Hub: <strong class="text-blue-500">${escapeHtml(dhUser)}</strong></span>
              </div>
              <button type="button" id="btn-refresh-push-dh-repos" class="p-1.5 dark:hover:bg-slate-700 hover:bg-slate-200 rounded text-slate-400 hover:text-blue-500 transition shrink-0" title="Refresh Docker Hub Repositories">
                <i class="fa-solid fa-arrows-rotate text-xs ${state.loadingDockerHubRepos ? 'animate-spin text-blue-500' : ''}"></i>
              </button>
            </div>
          ` : `
            <div class="p-2.5 mb-4 rounded-lg dark:bg-amber-950/30 bg-amber-50 border dark:border-amber-800/50 border-amber-200 text-xs dark:text-amber-300 text-amber-800">
              Configure Docker Hub credentials in Settings to enable automatic repository syncing.
            </div>
          `}

          <form id="form-push-docker" class="space-y-4">
            <div>
              <div class="flex items-center justify-between mb-2">
                <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider">Target Docker Hub Repository</label>
                ${state.dockerHubRepos.length > 0 ? `<span class="text-[11px] text-purple-400 font-medium">${state.dockerHubRepos.length} Repositories Available</span>` : ''}
              </div>
              ${state.dockerHubRepos && state.dockerHubRepos.length > 0 ? `
                <select id="select-push-dockerhub-repo" class="w-full px-3 py-2 mb-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-purple-500 focus:outline-none cursor-pointer">
                  <option value="">-- Select Docker Hub Repository --</option>
                  ${!hasSelectedInList && currentRepoValue ? `<option value="${escapeHtml(currentRepoValue)}" selected>📦 ${escapeHtml(currentRepoValue)} (Active Image)</option>` : ''}
                  ${state.dockerHubRepos.map(r => {
                    const selected = currentRepoValue === r.full_name ? 'selected' : '';
                    const icon = r.is_private ? '🔒' : '🌐';
                    return `<option value="${escapeHtml(r.full_name)}" ${selected}>${icon} ${escapeHtml(r.full_name)}</option>`;
                  }).join('')}
                </select>
              ` : ''}
              <input type="text" id="push-docker-repo" value="${escapeHtml(currentRepoValue)}" required placeholder="username/repository (e.g. user/my-app)"
                     class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-purple-500 focus:outline-none" />
            </div>

            <div>
              <div class="flex items-center justify-between mb-2">
                <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider">Remote Tag</label>
                ${state.loadingDockerHubTags ? `<span class="text-[11px] text-purple-400 flex items-center space-x-1"><i class="fa-solid fa-spinner animate-spin"></i> <span>Loading tags...</span></span>` : ''}
              </div>
              <div class="flex space-x-2">
                <input type="text" id="push-docker-tag" value="${escapeHtml(currentTagValue)}" required placeholder="e.g. latest, v1.0.0"
                       class="flex-1 px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-purple-500 focus:outline-none" />
                <select id="select-push-tag-preset" class="px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs cursor-pointer min-w-[120px]">
                  <option value="">Select Tag</option>
                  ${(state.dockerHubTags && state.dockerHubTags.length > 0 ? state.dockerHubTags.map(t => {
                    const tagName = typeof t === 'string' ? t : t.name;
                    return `<option value="${escapeHtml(tagName)}">${escapeHtml(tagName)}</option>`;
                  }) : state.tagsList.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`)).join('')}
                </select>
              </div>
            </div>

            <p class="text-[11px] dark:text-slate-400 text-slate-500">Pushes <span id="push-summary-text" class="font-mono text-purple-400">${escapeHtml(currentRepoValue)}:${escapeHtml(currentTagValue)}</span> to Docker Hub registry.</p>
            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="submit" class="px-4 py-2 text-xs font-medium bg-purple-600 hover:bg-purple-500 text-white rounded-lg flex items-center space-x-1.5 shadow-sm">
                <i class="fa-solid fa-rocket text-xs"></i>
                <span>Push Image</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderJobsModal() {
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-3xl dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-list-check text-purple-500"></i>
              <span>Build Job History</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <div class="max-h-96 overflow-y-auto">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="border-b dark:border-slate-800 border-slate-200 dark:text-slate-400 text-slate-500 uppercase tracking-wider">
                  <th class="py-2.5 px-3">Job ID</th>
                  <th class="py-2.5 px-3">Type</th>
                  <th class="py-2.5 px-3">Image / Target</th>
                  <th class="py-2.5 px-3">Status</th>
                  <th class="py-2.5 px-3">Started</th>
                  <th class="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y dark:divide-slate-800/50 divide-slate-200">
                ${state.jobs.length === 0 ? `<tr><td colspan="6" class="py-4 text-center dark:text-slate-500 text-slate-400">No build jobs recorded yet.</td></tr>` : ''}
                ${state.jobs.map(j => `
                  <tr class="dark:hover:bg-slate-800/50 hover:bg-slate-100">
                    <td class="py-2.5 px-3 font-mono dark:text-slate-300 text-slate-600">${j.id}</td>
                    <td class="py-2.5 px-3">${getJobTypeBadge(j.job_type || j.action)}</td>
                    <td class="py-2.5 px-3 font-medium dark:text-white text-slate-900">${j.image_name}:${j.tag}</td>
                    <td class="py-2.5 px-3">${getStatusPill(j.status)}</td>
                    <td class="py-2.5 px-3 dark:text-slate-400 text-slate-500">${new Date(j.started_at).toLocaleTimeString()}</td>
                    <td class="py-2.5 px-3 text-right">
                      <button class="btn-view-job-logs px-2.5 py-1 text-xs dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-200 text-slate-700 rounded" data-job-id="${j.id}">
                        View Log
                      </button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function renderSettingsModal() {
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-2xl dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4 border-b dark:border-slate-800 border-slate-200 pb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-sliders text-amber-500"></i>
              <span>Credentials & Settings</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900 p-1 rounded transition"><i class="fa-solid fa-xmark text-base"></i></button>
          </div>
          <form id="form-settings" class="space-y-5">
            <!-- Appearance / Theme -->
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Appearance / Theme</label>
              <div class="flex space-x-3">
                <button type="button" data-theme-val="light" class="btn-theme-toggle flex-1 py-2.5 px-4 rounded-lg border transition flex items-center justify-center space-x-2 ${state.theme === 'light' ? 'border-blue-500 bg-blue-500/10 text-blue-600 dark:text-blue-400 font-semibold shadow-sm' : 'dark:border-slate-700 border-slate-300 dark:bg-slate-800 bg-slate-50 dark:text-slate-300 text-slate-700 hover:border-slate-400'}">
                  <i class="fa-solid fa-sun text-amber-500"></i>
                  <span>Light Mode</span>
                </button>
                <button type="button" data-theme-val="dark" class="btn-theme-toggle flex-1 py-2.5 px-4 rounded-lg border transition flex items-center justify-center space-x-2 ${state.theme === 'dark' ? 'border-blue-500 bg-blue-500/10 text-blue-400 font-semibold shadow-sm' : 'dark:border-slate-700 border-slate-300 dark:bg-slate-800 bg-slate-50 dark:text-slate-300 text-slate-700 hover:border-slate-400'}">
                  <i class="fa-solid fa-moon text-indigo-400"></i>
                  <span>Dark Mode</span>
                </button>
              </div>
            </div>

            <!-- GitHub PAT -->
            <div class="pt-4 border-t dark:border-slate-800 border-slate-200">
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">GitHub Personal Access Token (PAT)</label>
              <div class="flex space-x-2 items-center">
                <input type="password" id="setting-gh-token" value="${escapeHtml(state.settings.github_token || '')}" placeholder="ghp_xxxxxxxxxxxx"
                       class="flex-1 px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none" />
                <button type="button" id="btn-test-gh" class="w-36 h-9 px-3 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-200 text-slate-700 border dark:border-slate-700 border-slate-300 rounded-lg transition shrink-0 flex items-center justify-center space-x-1.5">
                  <i class="fa-solid fa-vial text-amber-500"></i>
                  <span>Test GitHub</span>
                </button>
              </div>
            </div>

            <!-- Docker Hub Credentials -->
            <div class="pt-4 border-t dark:border-slate-800 border-slate-200">
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Docker Hub Credentials</label>
              <div class="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2 items-stretch sm:items-center">
                <input type="text" id="setting-dh-user" value="${escapeHtml(state.settings.dockerhub_username || state.settings.docker_username || '')}" placeholder="Username"
                       class="flex-1 px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none min-w-0" />
                <input type="password" id="setting-dh-token" value="${escapeHtml(state.settings.dockerhub_token || state.settings.docker_token || state.settings.docker_password || '')}" placeholder="Access Token / Password"
                       class="flex-1 px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none min-w-0" />
                <button type="button" id="btn-test-dh" class="w-36 h-9 px-3 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-200 text-slate-700 border dark:border-slate-700 border-slate-300 rounded-lg transition shrink-0 flex items-center justify-center space-x-1.5">
                  <i class="fa-solid fa-vial text-amber-500"></i>
                  <span>Test Docker Hub</span>
                </button>
              </div>
            </div>

            <!-- Docker Build Cleanup -->
            <div class="pt-4 border-t dark:border-slate-800 border-slate-200">
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Docker Build Cleanup</label>
              <div class="flex items-center justify-between p-3 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg">
                <div class="space-y-0.5 pr-2">
                  <div class="text-xs font-medium dark:text-slate-200 text-slate-800">Auto-prune previous project builds</div>
                  <div class="text-[11px] text-slate-400">Prunes untagged dangling build layers filtered strictly by project label upon successful build</div>
                </div>
                <label class="relative inline-flex items-center cursor-pointer shrink-0">
                  <input type="checkbox" id="setting-auto-prune" ${state.settings?.auto_prune_project_builds !== false ? 'checked' : ''} class="sr-only peer">
                  <div class="relative w-11 h-6 shrink-0 bg-slate-300 peer-focus:outline-none dark:bg-slate-700 rounded-full peer peer-checked:after:translate-x-[22px] peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all after:duration-200 after:ease-in-out peer-checked:bg-amber-600"></div>
                </label>
              </div>
            </div>

            <!-- DockForge Account Credentials -->
            <div class="pt-4 border-t dark:border-slate-800 border-slate-200">
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">DockForge Account Credentials</label>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">New Username</label>
                  <input type="text" id="setting-acc-user" value="${escapeHtml(state.user || state.currentCredentials?.username || 'admin')}" placeholder="e.g., admin"
                         class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none" />
                </div>
                <div>
                  <label class="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">New Password</label>
                  <input type="password" id="setting-acc-pass" value="${escapeHtml(state.currentCredentials?.password || '')}" placeholder="New Password"
                         class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none" />
                </div>
              </div>
            </div>

            <div class="flex justify-end space-x-2 pt-4 border-t dark:border-slate-800 border-slate-200">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg transition">Cancel</button>
              <button type="submit" class="px-4 py-2 text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white rounded-lg shadow-sm transition">Save Credentials</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function getStatusPill(status) {
    if (status === 'success') {
      return `<span class="px-2 py-0.5 text-[10px] uppercase font-bold rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">Success</span>`;
    } else if (status === 'failure') {
      return `<span class="px-2 py-0.5 text-[10px] uppercase font-bold rounded-full bg-red-500/10 text-red-500 border border-red-500/20">Failed</span>`;
    } else if (status === 'building') {
      return `<span class="px-2 py-0.5 text-[10px] uppercase font-bold rounded-full bg-blue-500/10 text-blue-500 border border-blue-500/20 animate-pulse">Building</span>`;
    }
    return `<span class="px-2 py-0.5 text-[10px] uppercase font-bold rounded-full bg-slate-500/10 text-slate-500 border border-slate-500/20">Queued</span>`;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function updateLineNumbers() {
    const codeEditor = document.getElementById('code-editor');
    const gutter = document.getElementById('editor-gutter');
    const badge = document.getElementById('line-count-badge');
    if (!codeEditor) return;

    const lines = codeEditor.value.split('\n').length;
    if (badge) {
      badge.textContent = `${lines} ${lines === 1 ? 'line' : 'lines'}`;
    }

    if (gutter) {
      let gutterHtml = '';
      for (let i = 1; i <= lines; i++) {
        gutterHtml += `<div>${i}</div>`;
      }
      gutter.innerHTML = gutterHtml;
      gutter.scrollTop = codeEditor.scrollTop;
    }
  }

  // --- EVENT ATTACHMENTS ---
  function attachAuthEvents() {
    const form = document.getElementById('auth-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errBox = document.getElementById('auth-error');
      const u = document.getElementById('auth-username').value.trim();
      const p = document.getElementById('auth-password').value.trim();

      if (errBox) {
        errBox.classList.add('hidden');
        errBox.textContent = '';
      }

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: u, password: p })
        });

        if (res.ok) {
          const data = await res.json();
          state.token = data.access_token;
          state.user = data.username || u;
          safeLocalStorageSet('dockforge_auth', 'true');
          safeLocalStorageSet('dockforge_token', state.token);
          safeLocalStorageSet('dockforge_user', state.user);
          await loadWorkspaceTree();
          await loadSettings();
          await loadJobs();
          render();
        } else {
          let errorMsg = 'Invalid username or password';
          try {
            const err = await res.json();
            if (err.detail) errorMsg = err.detail;
          } catch (e) {}
          if (errBox) {
            errBox.textContent = errorMsg;
            errBox.classList.remove('hidden');
          }
        }
      } catch (e) {
        if (errBox) {
          errBox.textContent = e.message || 'Login request failed';
          errBox.classList.remove('hidden');
        }
      }
    });
  }

  // --- WORKSPACE DRAG & DROP UTILITIES ---
  function getParentFolderPath(filePath) {
    if (!filePath) return '';
    const parts = filePath.split('/');
    parts.pop();
    return parts.join('/');
  }

  function isValidRootTarget(srcPath) {
    if (!srcPath) return false;
    return srcPath.includes('/');
  }

  function highlightRootTarget(container, isHighlighted) {
    if (isHighlighted) {
      container.classList.add('ring-2', 'ring-blue-500/80', 'bg-blue-500/10', 'border-2', 'border-dashed', 'border-blue-500/60');
    } else {
      container.classList.remove('ring-2', 'ring-blue-500/80', 'bg-blue-500/10', 'border-2', 'border-dashed', 'border-blue-500/60');
    }
  }

  function cleanupDropTargetHighlights() {
    document.querySelectorAll('.tree-node').forEach(el => {
      el.classList.remove(
        'border-t-2', 'border-b-2', 'border-blue-500', 'shadow-sm',
        'ring-2', 'ring-blue-500', 'bg-blue-500/20', 'dark:bg-blue-500/30',
        'text-blue-600', 'dark:text-blue-300', 'shadow-md',
        'ring-amber-400', 'bg-amber-400/20', 'dark:bg-amber-400/30', 'animate-pulse'
      );
      const pulsingIcon = el.querySelector('.fa-folder-open.animate-pulse');
      if (pulsingIcon) {
        pulsingIcon.classList.remove('fa-folder-open', 'text-amber-400', 'animate-pulse');
        pulsingIcon.classList.add('fa-folder', 'text-amber-500');
      }
    });
    const container = document.getElementById('workspace-tree-container');
    if (container) highlightRootTarget(container, false);
  }

  let autoExpandTimer = null;
  let autoExpandTargetPath = null;

  function clearAutoExpand() {
    if (autoExpandTimer) {
      clearTimeout(autoExpandTimer);
      autoExpandTimer = null;
    }
    autoExpandTargetPath = null;
  }

  async function handleReorderOrMove(srcPath, targetPath, targetIsFolder, targetName, targetParentPath, position) {
    if (!srcPath) return;

    const srcName = srcPath.split('/').pop();
    const srcParentPath = getParentFolderPath(srcPath);

    let newParentPath = '';
    let newPath = '';

    if (position === 'inside') {
      newParentPath = targetPath;
      newPath = newParentPath ? `${newParentPath}/${srcName}` : srcName;
    } else {
      newParentPath = targetParentPath || '';
      newPath = newParentPath ? `${newParentPath}/${srcName}` : srcName;
    }

    // Check invalid move: folder into itself or subfolder
    if (state.draggedIsFolder && position === 'inside' && (targetPath === srcPath || targetPath.startsWith(srcPath + '/'))) {
      showToast("Cannot move a folder into itself or its own subfolder", true);
      return;
    }

    try {
      // 1. If path changed, call file move backend
      if (srcPath !== newPath) {
        const res = await apiFetch('/api/files/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ old_path: srcPath, new_path: newPath })
        });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.detail || 'Failed to move item', true);
          return;
        }

        // Update active open tabs
        state.openTabs.forEach(tab => {
          if (tab.path === srcPath) {
            tab.path = newPath;
            tab.name = srcName;
          } else if (tab.path.startsWith(srcPath + '/')) {
            tab.path = newPath + tab.path.slice(srcPath.length);
          }
        });
        if (state.activeTabPath === srcPath) {
          state.activeTabPath = newPath;
        } else if (state.activeTabPath && state.activeTabPath.startsWith(srcPath + '/')) {
          state.activeTabPath = newPath + state.activeTabPath.slice(srcPath.length);
        }

        // Update expanded folders
        if (state.expandedFolders.has(srcPath)) {
          state.expandedFolders.delete(srcPath);
          state.expandedFolders.add(newPath);
        }
        if (newParentPath) {
          state.expandedFolders.add(newParentPath);
        }
      }

      // 2. Update order map for newParentPath
      if (!state.treeOrder) state.treeOrder = {};

      function getChildrenNames(parentPath) {
        if (!state.files) return [];
        if (!parentPath) return state.files.map(f => f.name);
        const parts = parentPath.split('/');
        let curr = state.files;
        for (const part of parts) {
          const found = curr.find(item => item.name === part && item.type === 'folder');
          if (found && found.children) {
            curr = found.children;
          } else {
            return [];
          }
        }
        return curr.map(f => f.name);
      }

      let orderList = state.treeOrder[newParentPath]
        ? [...state.treeOrder[newParentPath]]
        : getChildrenNames(newParentPath);

      // Remove srcName if already present
      orderList = orderList.filter(n => n !== srcName);

      if (position === 'inside') {
        orderList.push(srcName);
      } else if (position === 'before') {
        const targetIdx = orderList.indexOf(targetName);
        if (targetIdx !== -1) {
          orderList.splice(targetIdx, 0, srcName);
        } else {
          orderList.unshift(srcName);
        }
      } else if (position === 'after') {
        const targetIdx = orderList.indexOf(targetName);
        if (targetIdx !== -1) {
          orderList.splice(targetIdx + 1, 0, srcName);
        } else {
          orderList.push(srcName);
        }
      }

      state.treeOrder[newParentPath] = orderList;

      if (srcParentPath !== newParentPath && state.treeOrder[srcParentPath]) {
        state.treeOrder[srcParentPath] = state.treeOrder[srcParentPath].filter(n => n !== srcName);
      }

      // 3. Persist order map to backend
      await apiFetch('/api/workspace/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_path: newParentPath, order: orderList })
      }).catch(err => console.error('Failed to persist order:', err));

      // 4. Toast notification
      if (position === 'inside') {
        showToast(targetName ? `Moved "${srcName}" into "${targetName}"` : `Moved "${srcName}" to root`);
      } else if (position === 'before') {
        showToast(`Moved "${srcName}" before "${targetName}"`);
      } else if (position === 'after') {
        showToast(`Moved "${srcName}" after "${targetName}"`);
      }

      // 5. Reload tree with new custom order
      await loadWorkspaceTree(false);
    } catch (err) {
      console.error('Reorder/move error:', err);
      showToast(err.message || 'Failed to reorder item', true);
    }
  }

  function initWorkspaceDragAndDrop() {
    const draggables = document.querySelectorAll('[draggable="true"]');
    draggables.forEach(el => {
      el.addEventListener('dragstart', (e) => {
        if (e.target.closest('.btn-delete-file')) {
          e.preventDefault();
          return;
        }
        const path = el.getAttribute('data-drag-path');
        const isFolder = el.getAttribute('data-is-folder') === 'true';
        state.draggedPath = path;
        state.draggedIsFolder = isFolder;

        e.dataTransfer.setData('text/plain', path);
        e.dataTransfer.effectAllowed = 'move';

        setTimeout(() => {
          el.classList.add('opacity-40', 'scale-[0.98]', 'bg-blue-500/10');
        }, 0);
      });

      el.addEventListener('dragend', () => {
        el.classList.remove('opacity-40', 'scale-[0.98]', 'bg-blue-500/10');
        state.draggedPath = null;
        state.draggedIsFolder = false;
        clearAutoExpand();
        cleanupDropTargetHighlights();
      });
    });

    const treeNodes = document.querySelectorAll('.tree-node');
    treeNodes.forEach(nodeEl => {
      const targetPath = nodeEl.getAttribute('data-drag-path');
      const targetIsFolder = nodeEl.getAttribute('data-is-folder') === 'true';
      const targetName = nodeEl.getAttribute('data-node-name');
      const targetParentPath = nodeEl.getAttribute('data-parent-path') || '';

      const getDropPosition = (e) => {
        const rect = nodeEl.getBoundingClientRect();
        const relY = e.clientY - rect.top;
        const ratio = relY / rect.height;

        if (targetIsFolder) {
          if (ratio < 0.25) return 'before';
          if (ratio > 0.75) return 'after';
          return 'inside';
        } else {
          return ratio < 0.5 ? 'before' : 'after';
        }
      };

      const updateHighlight = (position) => {
        cleanupDropTargetHighlights();
        if (position === 'before') {
          nodeEl.classList.add('border-t-2', 'border-blue-500', 'shadow-sm');
        } else if (position === 'after') {
          nodeEl.classList.add('border-b-2', 'border-blue-500', 'shadow-sm');
        } else if (position === 'inside') {
          nodeEl.classList.add('ring-2', 'ring-blue-500', 'bg-blue-500/20', 'dark:bg-blue-500/30', 'text-blue-600', 'dark:text-blue-300', 'shadow-md');
        }
      };

      const triggerFolderAutoExpand = (position) => {
        if (targetIsFolder && !state.expandedFolders.has(targetPath)) {
          if (autoExpandTargetPath !== targetPath) {
            clearAutoExpand();
            autoExpandTargetPath = targetPath;

            // Visual feedback on the collapsed folder element
            nodeEl.classList.add('ring-2', 'ring-amber-400', 'bg-amber-400/20', 'dark:bg-amber-400/30', 'animate-pulse');
            const icon = nodeEl.querySelector('.fa-folder');
            if (icon) {
              icon.classList.remove('fa-folder', 'text-amber-500');
              icon.classList.add('fa-folder-open', 'text-amber-400', 'animate-pulse');
            }

            autoExpandTimer = setTimeout(() => {
              if (state.draggedPath && autoExpandTargetPath === targetPath) {
                state.expandedFolders.add(targetPath);
                clearAutoExpand();
                render();
              }
            }, 500);
          }
        } else if (autoExpandTargetPath && autoExpandTargetPath !== targetPath) {
          clearAutoExpand();
        }
      };

      nodeEl.addEventListener('dragenter', (e) => {
        if (!state.draggedPath || state.draggedPath === targetPath) return;
        if (state.draggedIsFolder && (targetPath === state.draggedPath || targetPath.startsWith(state.draggedPath + '/'))) return;
        e.preventDefault();
        e.stopPropagation();
        const position = getDropPosition(e);
        updateHighlight(position);
        triggerFolderAutoExpand(position);
      });

      nodeEl.addEventListener('dragover', (e) => {
        if (!state.draggedPath || state.draggedPath === targetPath) return;
        if (state.draggedIsFolder && (targetPath === state.draggedPath || targetPath.startsWith(state.draggedPath + '/'))) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        const position = getDropPosition(e);
        updateHighlight(position);
        triggerFolderAutoExpand(position);
      });

      nodeEl.addEventListener('dragleave', (e) => {
        const rect = nodeEl.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom) {
          if (autoExpandTargetPath === targetPath) {
            clearAutoExpand();
          }
          cleanupDropTargetHighlights();
        }
      });

      nodeEl.addEventListener('drop', (e) => {
        if (!state.draggedPath || state.draggedPath === targetPath) return;
        if (state.draggedIsFolder && (targetPath === state.draggedPath || targetPath.startsWith(state.draggedPath + '/'))) return;
        e.preventDefault();
        e.stopPropagation();

        clearAutoExpand();
        const position = getDropPosition(e);
        cleanupDropTargetHighlights();

        handleReorderOrMove(state.draggedPath, targetPath, targetIsFolder, targetName, targetParentPath, position);
      });
    });

    const treeContainer = document.getElementById('workspace-tree-container');
    if (treeContainer) {
      treeContainer.addEventListener('dragenter', (e) => {
        if (!state.draggedPath) return;
        if (e.target.closest('.tree-node')) return;
        if (isValidRootTarget(state.draggedPath)) {
          e.preventDefault();
          highlightRootTarget(treeContainer, true);
        }
      });

      treeContainer.addEventListener('dragover', (e) => {
        if (!state.draggedPath) return;
        if (e.target.closest('.tree-node')) return;
        if (isValidRootTarget(state.draggedPath)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          highlightRootTarget(treeContainer, true);
        }
      });

      treeContainer.addEventListener('dragleave', (e) => {
        const rect = treeContainer.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX >= rect.right || e.clientY < rect.top || e.clientY >= rect.bottom) {
          highlightRootTarget(treeContainer, false);
        }
      });

      treeContainer.addEventListener('drop', (e) => {
        if (!state.draggedPath) return;
        if (e.target.closest('.tree-node')) return;
        e.preventDefault();
        e.stopPropagation();
        highlightRootTarget(treeContainer, false);

        const srcPath = state.draggedPath;
        handleReorderOrMove(srcPath, '', false, '', '', 'inside');
      });
    }
  }

  function attachEvents() {
    // Header Desktop & Mobile Buttons
    const handlePullClick = () => {
      state.modals.pull = true;
      if (!state.repos || state.repos.length === 0) {
        loadGitHubRepos();
      }
      render();
    };
    document.getElementById('btn-pull')?.addEventListener('click', handlePullClick);
    document.getElementById('btn-push')?.addEventListener('click', () => { state.modals.push = true; render(); });
    document.getElementById('btn-build-image')?.addEventListener('click', () => { state.modals.build = true; render(); });
    
    const handlePushDockerClick = () => {
      if (!isBuildReadyForCurrentProject()) {
        showToast("Please build the image for this project before pushing to Docker Hub", true);
        return;
      }
      const parsed = parseRepoAndTag(
        (state.lastLocalBuild && state.lastLocalBuild.tag) || state.dockerTargetImageTagInput || state.dockerImageInput
      );
      state.dockerImageInput = parsed.repo;
      state.dockerTagInput = parsed.tag;

      state.modals.pushDocker = true;
      if (state.dockerHubRepos.length === 0) {
        loadDockerHubRepos();
      }
      render();
    };
    document.getElementById('btn-push-docker')?.addEventListener('click', handlePushDockerClick);

    document.getElementById('btn-jobs')?.addEventListener('click', () => { loadJobs(); state.modals.jobs = true; render(); });
    document.getElementById('btn-settings')?.addEventListener('click', () => { loadSettings(); state.modals.settings = true; render(); });
    document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

    // Pull Repository Modal Handlers
    document.getElementById('select-pull-repo')?.addEventListener('change', (e) => {
      const selected = e.target.options[e.target.selectedIndex];
      const url = selected?.value;
      const branch = selected?.getAttribute('data-branch') || 'main';
      if (url) {
        const urlInput = document.getElementById('pull-url');
        const branchInput = document.getElementById('pull-branch');
        if (urlInput) urlInput.value = url;
        if (branchInput) branchInput.value = branch;
        state.pullRepoUrl = url;
        state.pullBranch = branch;
      }
    });

    document.getElementById('btn-refresh-pull-repos')?.addEventListener('click', (e) => {
      e.preventDefault();
      loadGitHubRepos(true);
    });

    document.getElementById('btn-mobile-menu')?.addEventListener('click', () => {
      state.mobileMenuOpen = !state.mobileMenuOpen;
      render();
    });

    document.getElementById('btn-pull-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      handlePullClick();
    });

    document.getElementById('btn-push-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      state.modals.push = true;
      render();
    });

    document.getElementById('btn-build-image-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      state.modals.build = true;
      render();
    });

    document.getElementById('btn-push-docker-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      handlePushDockerClick();
    });

    document.getElementById('btn-jobs-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      loadJobs();
      state.modals.jobs = true;
      render();
    });

    document.getElementById('btn-settings-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      loadSettings();
      state.modals.settings = true;
      render();
    });

    document.getElementById('btn-logout-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      handleLogout();
    });

    // Mobile Bottom Tab Switcher
    document.getElementById('nav-tab-files')?.addEventListener('click', () => {
      state.mobileTab = 'files';
      render();
    });

    document.getElementById('nav-tab-code')?.addEventListener('click', () => {
      state.mobileTab = 'code';
      render();
    });

    document.getElementById('nav-tab-console')?.addEventListener('click', () => {
      state.mobileTab = 'console';
      render();
    });

    // Sidebar Buttons
    document.getElementById('btn-new-file')?.addEventListener('click', () => {
      state.modals.newFile = true;
      render();
    });
    document.getElementById('btn-new-folder')?.addEventListener('click', () => {
      state.modals.newFolder = true;
      render();
    });
    document.getElementById('btn-refresh-tree')?.addEventListener('click', () => loadWorkspaceTree(true));
    document.getElementById('btn-clear-tree')?.addEventListener('click', () => {
      state.modals.clearWorkspace = true;
      render();
    });

    // File Tree clicks
    document.querySelectorAll('[data-folder-path]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-file')) return;
        const path = el.getAttribute('data-folder-path');
        if (state.expandedFolders.has(path)) {
          state.expandedFolders.delete(path);
        } else {
          state.expandedFolders.add(path);
        }
        render();
      });
    });

    document.querySelectorAll('[data-file-path]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-file')) return;
        const path = el.getAttribute('data-file-path');
        openFile(path);
      });
    });

    document.querySelectorAll('.btn-delete-file').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const deletePath = btn.getAttribute('data-delete-path');
        const isFolder = btn.getAttribute('data-is-folder') === 'true';
        if (deletePath) {
          state.modals.deleteItem = { path: deletePath, isFolder };
          render();
        }
      });
    });

    // Workspace Drag & Drop listeners
    initWorkspaceDragAndDrop();

    // Editor Tabs
    document.querySelectorAll('[data-tab-path]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.btn-close-tab')) return;
        state.activeTabPath = el.getAttribute('data-tab-path');
        render();
      });
    });

    document.querySelectorAll('.btn-close-tab').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const path = btn.getAttribute('data-close-path');
        state.openTabs = state.openTabs.filter(t => t.path !== path);
        if (state.activeTabPath === path) {
          state.activeTabPath = state.openTabs.length ? state.openTabs[0].path : null;
        }
        render();
      });
    });

    // Code Editor Textarea & Gutter
    const codeEditor = document.getElementById('code-editor');
    if (codeEditor) {
      const gutter = document.getElementById('editor-gutter');
      if (gutter) {
        gutter.scrollTop = codeEditor.scrollTop;
      }

      codeEditor.addEventListener('scroll', () => {
        const gutterEl = document.getElementById('editor-gutter');
        if (gutterEl) {
          gutterEl.scrollTop = codeEditor.scrollTop;
        }
      });

      codeEditor.addEventListener('input', (e) => {
        const tab = state.openTabs.find(t => t.path === state.activeTabPath);
        if (tab) {
          tab.content = e.target.value;
          tab.isDirty = tab.content !== tab.originalContent;
        }
        updateLineNumbers();
      });

      codeEditor.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          const start = codeEditor.selectionStart;
          const end = codeEditor.selectionEnd;
          codeEditor.value = codeEditor.value.substring(0, start) + '  ' + codeEditor.value.substring(end);
          codeEditor.selectionStart = codeEditor.selectionEnd = start + 2;
          const tab = state.openTabs.find(t => t.path === state.activeTabPath);
          if (tab) {
            tab.content = codeEditor.value;
            tab.isDirty = tab.content !== tab.originalContent;
          }
          updateLineNumbers();
        } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
          e.preventDefault();
          saveActiveFile();
        }
      });
    }

    document.getElementById('btn-save-file')?.addEventListener('click', saveActiveFile);
    document.getElementById('btn-toggle-editor-max')?.addEventListener('click', () => {
      state.editorMaximized = !state.editorMaximized;
      if (state.editorMaximized) {
        state.terminalMaximized = false;
      }
      render();
    });

    // Image Zoom Button Event Listeners
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
      const activeTab = state.openTabs.find(t => t.path === state.activeTabPath);
      if (activeTab) {
        if (activeTab.zoomMode === 'fit') {
          activeTab.zoomMode = 'custom';
          activeTab.zoomScale = 125;
        } else {
          activeTab.zoomScale = Math.min(500, (activeTab.zoomScale || 100) + 25);
        }
        render();
      }
    });

    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      const activeTab = state.openTabs.find(t => t.path === state.activeTabPath);
      if (activeTab) {
        if (activeTab.zoomMode === 'fit') {
          activeTab.zoomMode = 'custom';
          activeTab.zoomScale = 75;
        } else {
          activeTab.zoomScale = Math.max(25, (activeTab.zoomScale || 100) - 25);
        }
        render();
      }
    });

    document.getElementById('btn-zoom-fit')?.addEventListener('click', () => {
      const activeTab = state.openTabs.find(t => t.path === state.activeTabPath);
      if (activeTab) {
        activeTab.zoomMode = 'fit';
        activeTab.zoomScale = 100;
        render();
      }
    });

    document.getElementById('btn-zoom-100')?.addEventListener('click', () => {
      const activeTab = state.openTabs.find(t => t.path === state.activeTabPath);
      if (activeTab) {
        activeTab.zoomMode = 'custom';
        activeTab.zoomScale = 100;
        render();
      }
    });

    document.getElementById('btn-zoom-reset')?.addEventListener('click', () => {
      const activeTab = state.openTabs.find(t => t.path === state.activeTabPath);
      if (activeTab) {
        activeTab.zoomMode = 'fit';
        activeTab.zoomScale = 100;
        render();
      }
    });

    // Terminal Scroll & Auto-Scroll Handler
    const term = document.getElementById('terminal-logs-body');
    const scrollAnchor = document.getElementById('terminal-scroll-anchor');
    if (term) {
      if (state.terminalAutoScroll !== false) {
        if (scrollAnchor && typeof scrollAnchor.scrollIntoView === 'function') {
          scrollAnchor.scrollIntoView({ behavior: 'smooth', block: 'end' });
        } else {
          term.scrollTop = term.scrollHeight;
        }
        state.terminalScrollTop = term.scrollTop;
      } else if (state.terminalScrollTop !== null && state.terminalScrollTop !== undefined) {
        term.scrollTop = state.terminalScrollTop;
      }

      term.addEventListener('scroll', () => {
        const isAtBottom = (term.scrollHeight - term.scrollTop - term.clientHeight) < 35;
        state.terminalAutoScroll = isAtBottom;
        state.terminalScrollTop = term.scrollTop;

        const resumeBtn = document.getElementById('btn-terminal-resume-autoscroll');
        if (resumeBtn) {
          if (!isAtBottom) {
            resumeBtn.classList.remove('hidden');
          } else {
            resumeBtn.classList.add('hidden');
          }
        }
      });
    }

    document.getElementById('btn-copy-logs')?.addEventListener('click', async () => {
      const logs = state.activeJobLogs || '';
      if (!logs) {
        showToast('Console is empty.', true);
        return;
      }
      try {
        await navigator.clipboard.writeText(logs);
        const btn = document.getElementById('btn-copy-logs');
        if (btn) {
          btn.innerHTML = '<i class="fa-solid fa-check text-emerald-400"></i>';
          setTimeout(() => {
            if (btn) btn.innerHTML = '<i class="fa-solid fa-copy"></i>';
          }, 2000);
        }
        showToast('Console logs copied to clipboard!');
      } catch (err) {
        showToast('Failed to copy logs to clipboard', true);
      }
    });

    document.getElementById('btn-terminal-resume-autoscroll')?.addEventListener('click', () => {
      state.terminalAutoScroll = true;
      state.terminalScrollTop = null;
      const termEl = document.getElementById('terminal-logs-body');
      if (termEl) {
        termEl.scrollTop = termEl.scrollHeight;
      }
      render();
    });

    document.getElementById('btn-clear-logs')?.addEventListener('click', () => {
      state.activeJobLogs = '';
      state.terminalAutoScroll = true;
      state.terminalScrollTop = null;
      render();
    });
    document.getElementById('btn-toggle-terminal-max')?.addEventListener('click', () => {
      state.terminalMaximized = !state.terminalMaximized;
      if (state.terminalMaximized) {
        state.editorMaximized = false;
      }
      render();
    });

    // Modal Close
    document.querySelectorAll('.btn-close-modal').forEach(btn => {
      btn.addEventListener('click', () => {
        Object.keys(state.modals).forEach(k => {
          if (k === 'deleteItem') {
            state.modals[k] = null;
          } else {
            state.modals[k] = false;
          }
        });
        render();
      });
    });

    // New File Form Handler
    document.getElementById('form-new-file')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('input-new-file-path');
      const cleanPath = input ? input.value.trim() : '';
      if (!cleanPath) return;

      try {
        const res = await apiFetch('/api/files/create', {
          method: 'POST',
          body: JSON.stringify({ path: cleanPath, content: '', is_folder: false })
        });
        if (res.ok) {
          state.modals.newFile = false;
          showToast(`File '${cleanPath}' created successfully.`);
          await loadWorkspaceTree();
          openFile(cleanPath);
        } else {
          const err = await res.json().catch(() => ({}));
          showToast(err.detail || 'Failed to create file', true);
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, true);
      }
    });

    // New Folder Form Handler
    document.getElementById('form-new-folder')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('input-new-folder-path');
      const cleanPath = input ? input.value.trim() : '';
      if (!cleanPath) return;

      try {
        const res = await apiFetch('/api/files/mkdir', {
          method: 'POST',
          body: JSON.stringify({ path: cleanPath, content: '', is_folder: true })
        });
        if (res.ok) {
          state.modals.newFolder = false;
          showToast(`Folder '${cleanPath}' created successfully.`);
          await loadWorkspaceTree();
        } else {
          const err = await res.json().catch(() => ({}));
          showToast(err.detail || 'Failed to create folder', true);
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, true);
      }
    });

    // Delete Item Confirmation Handler
    document.getElementById('btn-confirm-delete-item')?.addEventListener('click', async () => {
      const item = state.modals.deleteItem;
      if (!item || !item.path) return;
      const path = item.path;

      try {
        const res = await apiFetch(`/api/files/delete?path=${encodeURIComponent(path)}`, {
          method: 'DELETE'
        });
        if (res.ok) {
          const name = path.split('/').pop() || path;
          state.openTabs = state.openTabs.filter(t => t.path !== path && !t.path.startsWith(path + '/'));
          if (state.activeTabPath && (state.activeTabPath === path || state.activeTabPath.startsWith(path + '/'))) {
            state.activeTabPath = state.openTabs.length ? state.openTabs[0].path : null;
          }
          state.modals.deleteItem = null;
          showToast(`Deleted '${name}' successfully.`);
          await loadWorkspaceTree();
        } else {
          const err = await res.json().catch(() => ({}));
          showToast(err.detail || 'Deletion failed', true);
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, true);
      }
    });

    // Clear Workspace Confirmation Handler
    document.getElementById('btn-confirm-clear-workspace')?.addEventListener('click', async () => {
      try {
        const res = await apiFetch('/api/workspace/clear', { method: 'DELETE' });
        if (res.ok) {
          state.files = [];
          state.openTabs = [];
          state.activeTabPath = null;
          state.currentRepoUrl = '';
          state.pullRepoUrl = '';
          state.pullBranch = 'main';
          state.activeProject = null;
          state.repoPath = null;
          state.activeBranch = null;
          state.activeRepo = {
            name: 'No Project Loaded',
            full_name: '',
            branch: '',
            url: ''
          };
          state.dockerTargetImageTagInput = '';
          state.modals.clearWorkspace = false;
          safeLocalStorageRemove('dockforge_active_repo');
          showToast('Workspace cleared successfully.');
          await loadWorkspaceTree();
          await loadGitHubRepos();
        } else {
          const data = await res.json().catch(() => ({}));
          showToast(data.detail || 'Failed to clear workspace', true);
        }
      } catch (err) {
        showToast(err.message || 'Error clearing workspace', true);
      }
    });

    // Modal Forms
    document.getElementById('form-pull')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const urlInput = document.getElementById('pull-url');
      const branchInput = document.getElementById('pull-branch');
      const url = urlInput ? urlInput.value.trim() : '';
      const branch = branchInput ? branchInput.value.trim() || 'main' : 'main';
      const submitBtn = document.getElementById('btn-submit-pull');

      if (!url) {
        showToast('Please enter a repository URL', true);
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fa-solid fa-spinner animate-spin text-xs"></i> <span>Pulling...</span>`;
      }

      try {
        const res = await apiFetch('/api/repo/pull', {
          method: 'POST',
          body: JSON.stringify({ url, branch })
        });
        const data = await res.json();
        if (res.ok) {
          state.modals.pull = false;
          state.currentRepoUrl = url;
          state.pullRepoUrl = url;
          state.pullBranch = branch;
          state.openTabs = [];
          state.activeTabPath = null;
          showToast(data.message || 'Repository pulled successfully!');
          await loadWorkspaceTree();
          await loadGitHubRepos();
        } else {
          showToast(data.detail || 'Failed to pull repository', true);
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, true);
      } finally {
        render();
      }
    });

    document.getElementById('form-push')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const messageInput = document.getElementById('push-message');
      const branchInput = document.getElementById('push-branch');
      const message = messageInput ? messageInput.value.trim() : '';
      const branch = branchInput ? branchInput.value.trim() || 'main' : 'main';

      if (!message) {
        showToast('Please enter a commit message', true);
        return;
      }

      try {
        const res = await apiFetch('/api/git/push', {
          method: 'POST',
          body: JSON.stringify({ message, commit_message: message, branch })
        });
        const data = await res.json();
        if (res.ok) {
          state.modals.push = false;
          showToast(data.message || 'Git push initiated. Live logs streaming to Build Console.');
          if (data.job_id) {
            connectWebSocket(data.job_id);
          }
          render();
        } else {
          showToast(data.detail || 'Failed to initiate Git push', true);
          state.activeJobLogs += `\n[${new Date().toLocaleTimeString()}] [ERROR] Git Push Failed: ${data.detail || 'Unknown error'}\n`;
          render();
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, true);
      }
    });

    // Build Container Image Form Handler
    document.getElementById('form-build-image')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const targetInput = document.getElementById('build-target-image-tag');
      const targetTag = targetInput ? targetInput.value.trim() : '';

      if (!targetTag) {
        showToast('Please enter a target image tag', true);
        return;
      }

      state.dockerTargetImageTagInput = targetTag;

      let imageName = 'dockforge';
      let tag = 'latest';

      if (targetTag.includes(':')) {
        const parts = targetTag.split(':');
        imageName = parts[0];
        tag = parts[1] || 'latest';
      } else {
        imageName = targetTag;
      }

      state.dockerLocalTagInput = tag;

      try {
        const res = await apiFetch('/api/build', {
          method: 'POST',
          body: JSON.stringify({
            action: 'build',
            image_name: imageName,
            tag: tag,
            target_image_tag: targetTag,
            local_image: 'dockforge',
            push_to_hub: false
          })
        });
        if (res.ok) {
          const data = await res.json();
          state.modals.build = false;
          connectWebSocket(data.job_id);
        } else {
          const err = await res.json();
          showToast(`Build trigger failed: ${err.detail || 'Unknown error'}`, true);
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, true);
      }
    });

    // Push Docker Image to Registry Form Handlers
    document.getElementById('select-push-dockerhub-repo')?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val) {
        const input = document.getElementById('push-docker-repo');
        if (input) input.value = val;
        state.dockerImageInput = val;

        const bannerEl = document.getElementById('push-source-image-banner');
        if (bannerEl) {
          bannerEl.textContent = `${val}:${state.dockerTagInput || 'latest'}`;
        }
        const summaryEl = document.getElementById('push-summary-text');
        if (summaryEl) {
          summaryEl.textContent = `${val}:${state.dockerTagInput || 'latest'}`;
        }
        loadDockerHubTags(val);
      }
    });

    document.getElementById('push-docker-repo')?.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      state.dockerImageInput = val;
      const select = document.getElementById('select-push-dockerhub-repo');
      if (select) {
        select.value = val;
      }
      const bannerEl = document.getElementById('push-source-image-banner');
      if (bannerEl) {
        bannerEl.textContent = `${val || '...'}:${state.dockerTagInput || 'latest'}`;
      }
      const summaryEl = document.getElementById('push-summary-text');
      if (summaryEl) {
        summaryEl.textContent = `${val || '...'}:${state.dockerTagInput || 'latest'}`;
      }
    });

    document.getElementById('push-docker-tag')?.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      state.dockerTagInput = val;
      const bannerEl = document.getElementById('push-source-image-banner');
      if (bannerEl) {
        bannerEl.textContent = `${state.dockerImageInput || '...'}:${val || 'latest'}`;
      }
      const summaryEl = document.getElementById('push-summary-text');
      if (summaryEl) {
        summaryEl.textContent = `${state.dockerImageInput || '...'}:${val || 'latest'}`;
      }
    });

    document.getElementById('select-push-tag-preset')?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val) {
        const input = document.getElementById('push-docker-tag');
        if (input) input.value = val;
        state.dockerTagInput = val;

        const bannerEl = document.getElementById('push-source-image-banner');
        if (bannerEl) {
          bannerEl.textContent = `${state.dockerImageInput || '...'}:${val}`;
        }
        const summaryEl = document.getElementById('push-summary-text');
        if (summaryEl) {
          summaryEl.textContent = `${state.dockerImageInput || '...'}:${val}`;
        }
      }
    });

    document.getElementById('btn-refresh-push-dh-repos')?.addEventListener('click', () => {
      loadDockerHubRepos(true);
    });

    document.getElementById('form-push-docker')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const repoInput = document.getElementById('push-docker-repo');
      const tagInput = document.getElementById('push-docker-tag');
      const imageName = repoInput ? repoInput.value.trim() : '';
      const tag = tagInput ? tagInput.value.trim() || 'latest' : 'latest';

      if (!imageName) {
        showToast("Please enter or select a target Docker Hub repository", true);
        return;
      }

      state.dockerImageInput = imageName;
      state.dockerTagInput = tag;

      try {
        const res = await apiFetch('/api/push', {
          method: 'POST',
          body: JSON.stringify({
            action: 'push',
            image_name: imageName,
            tag: tag,
            local_image: 'dockforge'
          })
        });
        if (res.ok) {
          const data = await res.json();
          state.modals.pushDocker = false;
          connectWebSocket(data.job_id);
        } else {
          const err = await res.json();
          showToast(`Push trigger failed: ${err.detail || 'Unknown error'}`, true);
        }
      } catch (err) {
        showToast(`Error: ${err.message}`, true);
      }
    });

    document.querySelectorAll('.btn-view-job-logs').forEach(btn => {
      btn.addEventListener('click', async () => {
        const jobId = btn.getAttribute('data-job-id');
        try {
          const res = await apiFetch(`/api/jobs/${jobId}/logs`);
          if (res.ok) {
            const data = await res.json();
            state.activeJobLogs = data.logs;
            state.terminalAutoScroll = true;
            state.terminalScrollTop = null;
            state.modals.jobs = false;
            render();
          }
        } catch (e) {
          alert(`Error fetching logs: ${e.message}`);
        }
      });
    });

    document.getElementById('btn-test-gh')?.addEventListener('click', async () => {
      const token = document.getElementById('setting-gh-token').value;
      try {
        const res = await apiFetch('/api/settings/test-connection', {
          method: 'POST',
          body: JSON.stringify({ type: 'github', token })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(`GitHub Connected: ${data.message}`);
          state.settings.github_token = token;
          loadGitHubRepos();
        } else {
          alert(`GitHub Test Failed: ${data.detail}`);
        }
      } catch (e) {
        alert(`Error: ${e.message}`);
      }
    });

    document.getElementById('btn-test-dh')?.addEventListener('click', async () => {
      const username = document.getElementById('setting-dh-user').value.trim();
      const token = document.getElementById('setting-dh-token').value.trim();
      try {
        const res = await apiFetch('/api/settings/test-connection', {
          method: 'POST',
          body: JSON.stringify({ type: 'dockerhub', username, token })
        });
        const data = await res.json();
        if (res.ok) {
          showToast(`Docker Hub Connected: ${data.message}`);
          state.settings.dockerhub_username = username;
          state.settings.dockerhub_token = token;
          loadDockerHubRepos();
        } else {
          alert(`Docker Hub Test Failed: ${data.detail}`);
        }
      } catch (e) {
        alert(`Error: ${e.message}`);
      }
    });

    // Theme Toggle buttons inside Settings Modal
    document.querySelectorAll('.btn-theme-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const selectedTheme = btn.getAttribute('data-theme-val');
        applyTheme(selectedTheme);
        render();
      });
    });

    document.getElementById('form-settings')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const github_token = document.getElementById('setting-gh-token').value;
      const dockerhub_username = document.getElementById('setting-dh-user').value;
      const dockerhub_token = document.getElementById('setting-dh-token').value;
      const auto_prune_project_builds = document.getElementById('setting-auto-prune')?.checked ?? true;
      const new_username = document.getElementById('setting-acc-user')?.value.trim();
      const new_password = document.getElementById('setting-acc-pass')?.value.trim();
      const theme = state.theme;

      applyTheme(theme);

      try {
        let credsUpdated = false;
        if (new_username && new_password) {
          const credRes = await apiFetch('/api/auth/credentials', {
            method: 'POST',
            body: JSON.stringify({ username: new_username, password: new_password })
          });
          if (credRes.ok) {
            credsUpdated = true;
            state.user = new_username;
            safeLocalStorageSet('dockforge_user', new_username);
          }
        }

        const res = await apiFetch('/api/settings', {
          method: 'POST',
          body: JSON.stringify({
            github_token,
            dockerhub_username,
            dockerhub_token,
            auto_prune_project_builds,
            theme,
            new_username,
            new_password
          })
        });

        if (res.ok) {
          const data = await res.json();
          state.settings = { github_token, dockerhub_username, dockerhub_token, auto_prune_project_builds, theme };
          if (data.username) {
            state.user = data.username;
            safeLocalStorageSet('dockforge_user', data.username);
          }
          if (github_token) {
            loadGitHubRepos();
          }
          if (dockerhub_username) {
            loadDockerHubRepos();
          }
          await loadCredentials();
          state.modals.settings = false;
          showToast('Credentials updated successfully!');
          render();
        } else {
          const err = await res.json();
          alert(`Save failed: ${err.detail}`);
        }
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });
  }

  // --- GLOBAL UNHANDLED ERROR LISTENERS ---
  window.addEventListener('error', (event) => {
    console.error('[DockForge] Global window error caught:', event.error || event.message);
    if (event.error) {
      renderErrorBoundary(event.error);
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    console.warn('[DockForge] Unhandled promise rejection:', event.reason);
  });

  // Global click listener to close Active Project dropdown on outside clicks
  document.addEventListener('click', (e) => {
    if (state.activeProjectMenuOpen) {
      const container = document.getElementById('active-project-dropdown-container');
      if (container && !container.contains(e.target)) {
        state.activeProjectMenuOpen = false;
        render();
      }
    }
  });

  // --- INITIALIZATION ---
  async function init() {
    try {
      await loadCredentials();
      if (state.token) {
        await loadWorkspaceTree();
        await loadSettings();
        await loadJobs();
        await loadGitHubRepos();
      }
      syncActiveRepo();
      render();
    } catch (err) {
      console.error('[DockForge] Initialization Error:', err);
      renderErrorBoundary(err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
