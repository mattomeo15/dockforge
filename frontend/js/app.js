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
    currentWs: null,
    modals: {
      pull: false,
      push: false,
      build: false,
      jobs: false,
      settings: false
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
    dockerImageInput: 'my-username/my-service',
    dockerTagInput: 'latest',
    expandedFolders: new Set(['']),
    editorMaximized: false,
    terminalMaximized: false,
    mobileTab: 'code',
    mobileMenuOpen: false,
    currentCredentials: null
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
      handleLogout();
      throw new Error('Session expired. Please log in again.');
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
  async function loadWorkspaceTree() {
    if (!state.token) return;
    try {
      const res = await apiFetch('/api/workspace/tree');
      if (res.ok) {
        state.files = await res.json();
        render();
      }
    } catch (e) {
      console.error('Failed to load file tree:', e);
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
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
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
    const itemName = prompt(`Enter new ${isFolder ? 'folder' : 'file'} path relative to workspace root (e.g. src/app.py):`);
    if (!itemName || !itemName.trim()) return;

    try {
      const res = await apiFetch('/api/workspace/file', {
        method: 'POST',
        body: JSON.stringify({ path: itemName.trim(), content: '', is_folder: isFolder })
      });
      if (res.ok) {
        await loadWorkspaceTree();
        if (!isFolder) {
          openFile(itemName.trim());
        }
      } else {
        const err = await res.json();
        alert(`Creation failed: ${err.detail}`);
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  }

  async function deleteFile(filePath) {
    if (!confirm(`Are you sure you want to delete '${filePath}'?`)) return;

    try {
      const res = await apiFetch(`/api/workspace/file?path=${encodeURIComponent(filePath)}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        state.openTabs = state.openTabs.filter(t => t.path !== filePath);
        if (state.activeTabPath === filePath) {
          state.activeTabPath = state.openTabs.length ? state.openTabs[0].path : null;
        }
        await loadWorkspaceTree();
      } else {
        const err = await res.json();
        alert(`Deletion failed: ${err.detail}`);
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  }

  // --- WEBSOCKET LOG STREAMING ---
  function connectWebSocket(jobId) {
    if (state.currentWs) {
      state.currentWs.close();
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/build/${jobId}`;

    state.activeJobLogs = `[${new Date().toLocaleTimeString()}] Connecting to DockForge build stream (${jobId})...\n`;
    render();

    const ws = new WebSocket(wsUrl);
    state.currentWs = ws;

    ws.onmessage = (event) => {
      state.activeJobLogs += event.data;
      const term = document.getElementById('terminal-logs-body');
      if (term) {
        term.scrollTop = term.scrollHeight;
      }
      render();
    };

    ws.onclose = () => {
      state.activeJobLogs += `\n[${new Date().toLocaleTimeString()}] Stream closed. Job execution complete.\n`;
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
          <div class="${isMobileFiles ? 'flex' : 'hidden'} md:flex w-full md:w-64 h-full shrink-0 flex-col overflow-hidden">
            ${renderSidebar()}
          </div>

          <!-- Code Editor Panel -->
          <main class="${isMobileCode ? 'flex' : 'hidden'} md:flex flex-1 flex-col min-w-0 min-h-0 w-full h-full dark:bg-slate-950 bg-white dark:text-slate-100 text-slate-800 overflow-hidden">
            ${renderEditorTabs()}
            ${!state.terminalMaximized ? renderEditorBody() : ''}
            ${!state.editorMaximized ? `<div class="hidden md:flex flex-col border-t dark:border-slate-800 border-slate-200 shrink-0">${renderTerminalLogs()}</div>` : ''}
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

  function renderHeader() {
    return `
      <header class="relative z-30 flex flex-col shrink-0 border-b dark:bg-slate-900 bg-white dark:border-slate-800 border-slate-200 shadow-sm transition-colors">
        <div class="h-14 px-4 flex items-center justify-between">
          <div class="flex items-center space-x-3 truncate">
            <div class="flex items-center space-x-2 shrink-0">
              <img src="/frontend/public/logo.png" alt="DockForge Logo" class="h-7 w-7 object-contain" onerror="this.onerror=null; this.src='/public/logo.png';" />
              <span class="font-bold text-base md:text-lg dark:text-white text-slate-900 tracking-wide">DockForge</span>
            </div>
          </div>

          <!-- Desktop Navigation Actions -->
          <div class="hidden md:flex items-center space-x-2 shrink-0">
            <button id="btn-pull" class="px-3 py-1.5 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-200 text-slate-700 rounded-lg dark:border-slate-700 border-slate-300 flex items-center space-x-1.5 transition">
              <i class="fa-solid fa-download text-blue-500"></i>
              <span>Pull Repo</span>
            </button>

            <button id="btn-push" class="px-3 py-1.5 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-200 text-slate-700 rounded-lg dark:border-slate-700 border-slate-300 flex items-center space-x-1.5 transition">
              <i class="fa-solid fa-code-commit text-emerald-500"></i>
              <span>Push Git</span>
            </button>

            <button id="btn-build" class="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow-sm flex items-center space-x-1.5 transition">
              <i class="fa-solid fa-cube"></i>
              <span>Build Docker</span>
            </button>

            <button id="btn-jobs" class="px-3 py-1.5 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-200 text-slate-700 rounded-lg dark:border-slate-700 border-slate-300 flex items-center space-x-1.5 transition">
              <i class="fa-solid fa-list-check text-purple-500"></i>
              <span>Jobs</span>
            </button>

            <button id="btn-settings" class="px-3 py-1.5 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-200 text-slate-700 rounded-lg dark:border-slate-700 border-slate-300 flex items-center space-x-1.5 transition">
              <i class="fa-solid fa-gear text-amber-500"></i>
              <span>Settings</span>
            </button>

            <div class="h-4 w-px dark:bg-slate-800 bg-slate-200 mx-1"></div>

            <button id="btn-logout" class="p-2 text-red-500 hover:text-red-600 rounded-lg dark:hover:bg-slate-800 hover:bg-slate-200 transition" title="Sign Out">
              <i class="fa-solid fa-right-from-bracket"></i>
            </button>
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
            <button id="btn-pull-mobile" class="p-2.5 rounded-lg dark:bg-slate-800 bg-white border dark:border-slate-700 border-slate-300 dark:text-slate-200 text-slate-800 flex items-center space-x-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition active:scale-95">
              <i class="fa-solid fa-download text-blue-500 text-sm"></i>
              <span class="font-medium">Pull Repo</span>
            </button>

            <button id="btn-push-mobile" class="p-2.5 rounded-lg dark:bg-slate-800 bg-white border dark:border-slate-700 border-slate-300 dark:text-slate-200 text-slate-800 flex items-center space-x-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition active:scale-95">
              <i class="fa-solid fa-code-commit text-emerald-500 text-sm"></i>
              <span class="font-medium">Push Git</span>
            </button>

            <button id="btn-build-mobile" class="p-2.5 rounded-lg bg-blue-600 text-white flex items-center space-x-2 shadow-sm hover:bg-blue-500 transition active:scale-95">
              <i class="fa-solid fa-cube text-sm"></i>
              <span class="font-medium">Build Docker</span>
            </button>

            <button id="btn-jobs-mobile" class="p-2.5 rounded-lg dark:bg-slate-800 bg-white border dark:border-slate-700 border-slate-300 dark:text-slate-200 text-slate-800 flex items-center space-x-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition active:scale-95">
              <i class="fa-solid fa-list-check text-purple-500 text-sm"></i>
              <span class="font-medium">Jobs</span>
            </button>

            <button id="btn-settings-mobile" class="p-2.5 rounded-lg dark:bg-slate-800 bg-white border dark:border-slate-700 border-slate-300 dark:text-slate-200 text-slate-800 flex items-center space-x-2 hover:bg-slate-200 dark:hover:bg-slate-700 transition active:scale-95">
              <i class="fa-solid fa-gear text-amber-500 text-sm"></i>
              <span class="font-medium">Settings</span>
            </button>

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
          </div>
        </div>
        <div class="flex-1 overflow-y-auto p-2 text-xs space-y-0.5 webkit-overflow-scrolling-touch">
          ${renderTreeNodes(state.files)}
        </div>
      </aside>
    `;
  }

  function renderTreeNodes(nodes, depth = 0) {
    if (!nodes || nodes.length === 0) {
      if (depth === 0) {
        return `<div class="p-4 text-center dark:text-slate-500 text-slate-400">Workspace is empty.<br>Pull a repo or create files.</div>`;
      }
      return '';
    }

    return nodes.map(node => {
      const isFolder = node.type === 'folder';
      const isExpanded = state.expandedFolders.has(node.path);
      const paddingLeft = `${depth * 12 + 8}px`;

      if (isFolder) {
        return `
          <div>
            <div class="flex items-center justify-between px-2 py-1.5 rounded dark:hover:bg-slate-800 hover:bg-slate-200 dark:text-slate-300 text-slate-700 dark:hover:text-white hover:text-slate-900 cursor-pointer group"
                 style="padding-left: ${paddingLeft}" data-folder-path="${node.path}">
              <div class="flex items-center space-x-1.5 truncate">
                <i class="fa-solid ${isExpanded ? 'fa-folder-open text-amber-400' : 'fa-folder text-amber-500'}"></i>
                <span class="truncate font-medium">${node.name}</span>
              </div>
            </div>
            ${isExpanded ? renderTreeNodes(node.children, depth + 1) : ''}
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
        <div class="flex items-center justify-between px-2 py-1.5 rounded dark:hover:bg-slate-800 hover:bg-slate-200 cursor-pointer group ${isActive ? 'bg-blue-600/20 text-blue-600 dark:text-blue-400 font-semibold' : 'dark:text-slate-400 text-slate-600 dark:hover:text-slate-200 hover:text-slate-900'}"
             style="padding-left: ${paddingLeft}" data-file-path="${node.path}">
          <div class="flex items-center space-x-2 truncate">
            <i class="fa-solid ${icon}"></i>
            <span class="truncate">${node.name}</span>
          </div>
          <button class="btn-delete-file opacity-0 group-hover:opacity-100 p-1 hover:text-red-500 transition" data-delete-path="${node.path}" title="Delete File">
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
    const containerClass = isFull
      ? 'flex-1 w-full h-full bg-slate-900 flex flex-col min-h-0'
      : 'h-56 md:h-64 bg-slate-900 border-t border-slate-800 flex flex-col shrink-0';

    return `
      <div class="${containerClass}">
        <div class="h-8 px-4 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400 bg-slate-900 shrink-0 select-none">
          <div class="flex items-center space-x-2">
            <i class="fa-solid fa-terminal text-blue-400"></i>
            <span class="font-semibold uppercase tracking-wider text-slate-300">Build Console & Log Stream</span>
          </div>
          <div class="flex items-center space-x-2">
            <button id="btn-clear-logs" class="p-1 hover:text-white transition" title="Clear Console">
              <i class="fa-solid fa-trash-can"></i>
            </button>
            <button id="btn-toggle-terminal-max" class="p-1 hover:text-white transition hidden md:inline-block" title="${state.terminalMaximized ? 'Restore View' : 'Maximize Console'}">
              <i class="fa-solid ${state.terminalMaximized ? 'fa-compress' : 'fa-expand'} text-xs"></i>
            </button>
          </div>
        </div>
        <pre id="terminal-logs-body" class="flex-1 p-4 overflow-y-auto font-mono text-xs text-emerald-400 bg-slate-950 whitespace-pre-wrap leading-relaxed select-text webkit-overflow-scrolling-touch">${escapeHtml(state.activeJobLogs || 'Ready. Click "Build Docker" to compile image and stream logs.')}</pre>
      </div>
    `;
  }

  function renderModals() {
    return `
      ${state.modals.pull ? renderPullModal() : ''}
      ${state.modals.push ? renderPushModal() : ''}
      ${state.modals.build ? renderBuildModal() : ''}
      ${state.modals.jobs ? renderJobsModal() : ''}
      ${state.modals.settings ? renderSettingsModal() : ''}
    `;
  }

  function renderPullModal() {
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
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Repository URL</label>
              <input type="url" id="pull-url" required placeholder="https://github.com/username/repository.git"
                     class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Branch</label>
              <input type="text" id="pull-branch" value="main" required
                     class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none" />
            </div>
            <p class="text-[11px] dark:text-slate-400 text-slate-500">Private repositories automatically utilize your saved GitHub PAT from Settings.</p>
            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="submit" class="px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg flex items-center space-x-1.5">
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
              <button type="submit" class="px-4 py-2 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg">
                <span>Commit & Push</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderBuildModal() {
    return `
      <div class="fixed inset-0 z-50 flex items-center justify-center dark:bg-slate-950/80 bg-slate-900/50 backdrop-blur-sm p-4">
        <div class="w-full max-w-lg dark:bg-slate-900 bg-white border dark:border-slate-800 border-slate-200 rounded-xl p-6 shadow-2xl dark:text-slate-100 text-slate-800">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold dark:text-white text-slate-900 flex items-center space-x-2">
              <i class="fa-solid fa-cube text-blue-500"></i>
              <span>Build & Push Docker Image</span>
            </h3>
            <button class="btn-close-modal dark:text-slate-400 text-slate-500 hover:dark:text-white hover:text-slate-900"><i class="fa-solid fa-xmark"></i></button>
          </div>
          <form id="form-build" class="space-y-4">
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Docker Image Name</label>
              <input type="text" id="build-image" value="${escapeHtml(state.dockerImageInput)}" required placeholder="username/repository"
                     class="w-full px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none" />
            </div>
            <div>
              <label class="block text-xs font-semibold dark:text-slate-300 text-slate-700 uppercase tracking-wider mb-2">Tag</label>
              <div class="flex space-x-2">
                <input type="text" id="build-tag" value="${escapeHtml(state.dockerTagInput)}" required
                       class="flex-1 px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none" />
                <select id="select-tag-preset" class="px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs">
                  ${state.tagsList.map(t => `<option value="${t}">${t}</option>`).join('')}
                </select>
              </div>
            </div>
            <p class="text-[11px] dark:text-slate-400 text-slate-500">Triggers a host Docker build and publishes image directly to Docker Hub with live log streaming.</p>
            <div class="flex justify-end space-x-2 pt-2">
              <button type="button" class="btn-close-modal px-4 py-2 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-300 text-slate-700 rounded-lg">Cancel</button>
              <button type="submit" class="px-4 py-2 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg">
                <span>Start Build Job</span>
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
                  <th class="py-2.5 px-3">Image Target</th>
                  <th class="py-2.5 px-3">Status</th>
                  <th class="py-2.5 px-3">Started</th>
                  <th class="py-2.5 px-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y dark:divide-slate-800/50 divide-slate-200">
                ${state.jobs.length === 0 ? `<tr><td colspan="5" class="py-4 text-center dark:text-slate-500 text-slate-400">No build jobs recorded yet.</td></tr>` : ''}
                ${state.jobs.map(j => `
                  <tr class="dark:hover:bg-slate-800/50 hover:bg-slate-100">
                    <td class="py-2.5 px-3 font-mono dark:text-slate-300 text-slate-600">${j.id}</td>
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
                <input type="text" id="setting-dh-user" value="${escapeHtml(state.settings.dockerhub_username || '')}" placeholder="Username"
                       class="flex-1 px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none min-w-0" />
                <input type="password" id="setting-dh-token" value="${escapeHtml(state.settings.dockerhub_token || '')}" placeholder="Access Token / Password"
                       class="flex-1 px-3 py-2 dark:bg-slate-800 bg-slate-50 border dark:border-slate-700 border-slate-300 rounded-lg dark:text-white text-slate-900 text-xs focus:ring-2 focus:ring-amber-500 focus:outline-none min-w-0" />
                <button type="button" id="btn-test-dh" class="w-36 h-9 px-3 text-xs font-medium dark:bg-slate-800 bg-slate-100 hover:dark:bg-slate-700 hover:bg-slate-200 dark:text-slate-200 text-slate-700 border dark:border-slate-700 border-slate-300 rounded-lg transition shrink-0 flex items-center justify-center space-x-1.5">
                  <i class="fa-solid fa-vial text-amber-500"></i>
                  <span>Test Docker Hub</span>
                </button>
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

  function attachEvents() {
    // Header Desktop & Mobile Buttons
    document.getElementById('btn-pull')?.addEventListener('click', () => { state.modals.pull = true; render(); });
    document.getElementById('btn-push')?.addEventListener('click', () => { state.modals.push = true; render(); });
    document.getElementById('btn-build')?.addEventListener('click', () => { state.modals.build = true; render(); });
    document.getElementById('btn-jobs')?.addEventListener('click', () => { loadJobs(); state.modals.jobs = true; render(); });
    document.getElementById('btn-settings')?.addEventListener('click', () => { loadSettings(); state.modals.settings = true; render(); });
    document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

    // Mobile Header Drawer Actions
    document.getElementById('btn-mobile-menu')?.addEventListener('click', () => {
      state.mobileMenuOpen = !state.mobileMenuOpen;
      render();
    });

    document.getElementById('btn-pull-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      state.modals.pull = true;
      render();
    });

    document.getElementById('btn-push-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      state.modals.push = true;
      render();
    });

    document.getElementById('btn-build-mobile')?.addEventListener('click', () => {
      state.mobileMenuOpen = false;
      state.modals.build = true;
      render();
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
    document.getElementById('btn-new-file')?.addEventListener('click', () => createNewItem(false));
    document.getElementById('btn-new-folder')?.addEventListener('click', () => createNewItem(true));
    document.getElementById('btn-refresh-tree')?.addEventListener('click', loadWorkspaceTree);

    // File Tree clicks
    document.querySelectorAll('[data-folder-path]').forEach(el => {
      el.addEventListener('click', () => {
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
        e.stopPropagation();
        deleteFile(btn.getAttribute('data-delete-path'));
      });
    });

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

    document.getElementById('btn-clear-logs')?.addEventListener('click', () => {
      state.activeJobLogs = '';
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
        Object.keys(state.modals).forEach(k => state.modals[k] = false);
        render();
      });
    });

    // Modal Forms
    document.getElementById('form-pull')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('pull-url').value;
      const branch = document.getElementById('pull-branch').value;

      try {
        const res = await apiFetch('/api/repo/pull', {
          method: 'POST',
          body: JSON.stringify({ url, branch })
        });
        if (res.ok) {
          state.modals.pull = false;
          await loadWorkspaceTree();
          alert('Repository pulled successfully!');
        } else {
          const err = await res.json();
          alert(`Pull failed: ${err.detail}`);
        }
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });

    document.getElementById('form-push')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const commit_message = document.getElementById('push-message').value;
      const branch = document.getElementById('push-branch').value;

      try {
        const res = await apiFetch('/api/repo/push', {
          method: 'POST',
          body: JSON.stringify({ commit_message, branch })
        });
        if (res.ok) {
          const data = await res.json();
          state.modals.push = false;
          alert(data.message || 'Pushed successfully!');
        } else {
          const err = await res.json();
          alert(`Push failed: ${err.detail}`);
        }
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    });

    document.getElementById('btn-fetch-tags')?.addEventListener('click', async () => {
      const img = document.getElementById('build-image').value.trim();
      if (!img) return;
      try {
        const res = await apiFetch('/api/dockerhub/tags', {
          method: 'POST',
          body: JSON.stringify({ image_name: img })
        });
        if (res.ok) {
          const data = await res.json();
          state.tagsList = data.tags || ['latest'];
          render();
        }
      } catch (e) {
        console.error(e);
      }
    });

    document.getElementById('select-tag-preset')?.addEventListener('change', (e) => {
      document.getElementById('build-tag').value = e.target.value;
      state.dockerTagInput = e.target.value;
    });

    document.getElementById('form-build')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const image_name = document.getElementById('build-image').value;
      const tag = document.getElementById('build-tag').value;

      try {
        const res = await apiFetch('/api/jobs/build', {
          method: 'POST',
          body: JSON.stringify({ image_name, tag })
        });
        if (res.ok) {
          const data = await res.json();
          state.modals.build = false;
          connectWebSocket(data.job_id);
        } else {
          const err = await res.json();
          alert(`Build trigger failed: ${err.detail}`);
        }
      } catch (err) {
        alert(`Error: ${err.message}`);
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
        if (res.ok) alert(`GitHub Connection Success: ${data.message}`);
        else alert(`GitHub Test Failed: ${data.detail}`);
      } catch (e) {
        alert(`Error: ${e.message}`);
      }
    });

    document.getElementById('btn-test-dh')?.addEventListener('click', async () => {
      const username = document.getElementById('setting-dh-user').value;
      const token = document.getElementById('setting-dh-token').value;
      try {
        const res = await apiFetch('/api/settings/test-connection', {
          method: 'POST',
          body: JSON.stringify({ type: 'dockerhub', username, token })
        });
        const data = await res.json();
        if (res.ok) alert(`Docker Hub Connection Success: ${data.message}`);
        else alert(`Docker Hub Test Failed: ${data.detail}`);
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
            theme,
            new_username,
            new_password
          })
        });

        if (res.ok) {
          const data = await res.json();
          state.settings = { github_token, dockerhub_username, dockerhub_token, theme };
          if (data.username) {
            state.user = data.username;
            safeLocalStorageSet('dockforge_user', data.username);
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

  // --- INITIALIZATION ---
  async function init() {
    try {
      await loadCredentials();
      if (state.token) {
        await loadWorkspaceTree();
        await loadSettings();
        await loadJobs();
      }
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
