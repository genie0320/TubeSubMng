// Tube Manager Dashboard Logic

const DB_VERSION = 4;

const state = {
  activeOwnerId: '',
  activeUserEmail: '',
  activeChannelTitle: ''
};

async function resolveActiveOwnerId() {
  if (state.activeOwnerId) return state;
  const stored = await chrome.storage.local.get(['activeOwnerId', 'activeUserEmail', 'activeChannelTitle']);
  if (stored.activeOwnerId) {
    state.activeOwnerId = stored.activeOwnerId;
    state.activeUserEmail = stored.activeUserEmail || '';
    state.activeChannelTitle = stored.activeChannelTitle || '';
    return state;
  }
  const res = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'GET_ACTIVE_OWNER_ID' }, resolve);
  });
  if (res && res.activeOwnerId) {
    state.activeOwnerId = res.activeOwnerId;
    state.activeUserEmail = res.email || '';
    state.activeChannelTitle = res.channelTitle || '';
    await chrome.storage.local.set({ 
      activeOwnerId: res.activeOwnerId, 
      activeUserEmail: res.email || '', 
      activeChannelTitle: res.channelTitle || '' 
    });
    return state;
  }
  state.activeOwnerId = 'default_user';
  state.activeUserEmail = '';
  state.activeChannelTitle = '';
  return state;
}

// Registry helper to record account metadata in storage
async function updateAccountLedger(channelId, email, channelTitle) {
  if (!channelId || channelId === 'default_user' || channelId === 'sample_user') return;
  const data = await chrome.storage.local.get(['account_registry']);
  const account_registry = data.account_registry || [];
  const existingIndex = account_registry.findIndex(a => a.channelId === channelId);
  const accountData = {
    channelId,
    channelTitle: channelTitle || email.split('@')[0],
    email: email || '',
    lastSyncTimestamp: Date.now()
  };
  if (existingIndex > -1) {
    if (!accountData.email && account_registry[existingIndex].email) {
      accountData.email = account_registry[existingIndex].email;
    }
    account_registry[existingIndex] = accountData;
  } else {
    account_registry.push(accountData);
  }
  await chrome.storage.local.set({ account_registry });
}

// IndexedDB Helper
async function openDB() {
  const sessionState = await resolveActiveOwnerId();
  const ownerId = sessionState.activeOwnerId;
  const dbName = `TubeManagerDB_${ownerId}`;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Flush legacy cache data to prevent corrupted schema states
      if (event.oldVersion < 4) {
        console.log("Upgrading IndexedDB schema. Flushing old stores...");
        if (db.objectStoreNames.contains('youtube_subscriptions')) {
          db.deleteObjectStore('youtube_subscriptions');
        }
        if (db.objectStoreNames.contains('youtube_channels')) {
          db.deleteObjectStore('youtube_channels');
        }
        if (db.objectStoreNames.contains('channels_master')) {
          db.deleteObjectStore('channels_master');
        }
        if (db.objectStoreNames.contains('channel_videos')) {
          db.deleteObjectStore('channel_videos');
        }
        if (db.objectStoreNames.contains('video_preview_cache')) {
          db.deleteObjectStore('video_preview_cache');
        }
      }
      
      if (!db.objectStoreNames.contains('youtube_subscriptions')) {
        db.createObjectStore('youtube_subscriptions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('channels_master')) {
        const store = db.createObjectStore('channels_master', { keyPath: 'id' });
        store.createIndex('status_flag', 'status_flag', { unique: false });
      } else {
        const store = event.currentTarget.transaction.objectStore('channels_master');
        if (!store.indexNames.contains('status_flag')) {
          store.createIndex('status_flag', 'status_flag', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains('video_preview_cache')) {
        db.createObjectStore('video_preview_cache', { keyPath: 'id' });
      }
      console.log("IndexedDB stores and status_flag index initialized.");
    };
  });
}

async function getFromStore(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([storeName], 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => {
      resolve(req.result || []);
      db.close();
    };
    req.onerror = () => {
      reject(req.error);
      db.close();
    };
  });
}

// Cursor-based IndexedDB retrieval using status_flag index for History tab
async function getUnsubscribedChannelsFromCursor() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['channels_master'], 'readonly');
    const store = tx.objectStore('channels_master');
    const list = [];
    
    let request;
    try {
      const index = store.index('status_flag');
      request = index.openCursor(IDBKeyRange.only('UNSUBSCRIBED'));
    } catch (e) {
      // Fallback if index not fully ready or during transient migration states
      console.warn("Index lookup failed, falling back to full table scan cursor", e);
      request = store.openCursor();
    }
    
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        const val = cursor.value;
        // If index lookup succeeded, all items are UNSUBSCRIBED. Otherwise check flag.
        if (val && (val.status_flag === 'UNSUBSCRIBED')) {
          list.push(val);
        }
        cursor.continue();
      } else {
        resolve(list);
        db.close();
      }
    };
    
    request.onerror = () => {
      reject(request.error);
      db.close();
    };
  });
}

// State variables
let channelsList = [];
let videosList = [];
let selectedChannelIds = new Set();
let currentTab = 'active'; // 'active', 'history' or 'migration'
let statusIntervalId = null;
let selectedMigrationCategory = '';
let pendingConfirmationChannelIds = new Set();

// [방치 일수]: Realtime neglect days calculation
function getInactivityDays(channel) {
  const dateStr = channel.last_uploaded_at || channel.lastUploadedAt;
  if (!dateStr) {
    const channelVids = videosList.filter(v => v.target_channel_id === channel.id);
    if (channelVids.length === 0) return 365;
    const timestamps = channelVids
      .map(v => new Date(v.uploaded_at).getTime())
      .filter(t => !isNaN(t));
    if (timestamps.length === 0) return 365;
    const latestUpload = Math.max(...timestamps);
    const diffTime = Date.now() - latestUpload;
    const days = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return isNaN(days) || days < 0 ? 0 : days;
  }
  const diffTime = Date.now() - new Date(dateStr).getTime();
  const days = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return isNaN(days) || days < 0 ? 0 : days;
}

// Format upload date
function getLastUploadDateStr(channel) {
  const dateStr = channel.last_uploaded_at || channel.lastUploadedAt;
  if (!dateStr) {
    const channelVids = videosList.filter(v => v.target_channel_id === channel.id);
    if (channelVids.length === 0) return '없음';
    const timestamps = channelVids
      .map(v => new Date(v.uploaded_at).getTime())
      .filter(t => !isNaN(t));
    if (timestamps.length === 0) return '없음';
    const latestUpload = Math.max(...timestamps);
    return new Date(latestUpload).toISOString().split('T')[0];
  }
  return new Date(dateStr).toISOString().split('T')[0];
}

// [구독 경과일]: Realtime subscription age in days. Parses millisecond timestamp cleanly.
function getSubscribedDays(channel) {
  const timestamp = channel.subscribed_at;
  if (!timestamp) return 1;
  
  // Works perfectly whether timestamp is a millisecond number or ISO string
  const diffTime = Date.now() - new Date(timestamp).getTime();
  const days = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return isNaN(days) || days <= 0 ? 1 : days;
}

// Laplace natural log zombie index
function getZombieIndex(channel) {
  const neglectDays = getInactivityDays(channel);
  const subs = channel.subscriber_count !== undefined ? channel.subscriber_count : (channel.subscriberCount || 0);
  const vids = channel.video_count !== undefined ? channel.video_count : (channel.videoCount || 0);
  return (vids / Math.log(subs + 2)) * neglectDays;
}

// ── isChannelUnanalyzed: guards card render from false zombie classification ──
// Returns true when the channel has NOT yet been processed by the ingestion queue.
// Condition 1: The channel exists in ingestion_queue with status !== 'success'
// Condition 2: last_uploaded_at is absent (undefined/null) — never scraped
// Both conditions are checked independently to cover fresh DB installs.
function isChannelUnanalyzed(channel) {
  const qStatus = window._ingestionQueueMap?.get(channel.id);
  if (qStatus && qStatus !== 'success') return true;
  if (channel.last_uploaded_at === undefined || channel.last_uploaded_at === null) return true;
  return false;
}

// Affinity Match
function getIdentityAffinity(channel) {
  const title = (channel.title || '').toLowerCase();
  const desc = (channel.description || '').toLowerCase();
  const cat = (channel.mappedCategory || '').toLowerCase();
  const tags = getCleanCategoryTags(channel.topicCategories).map(t => t.toLowerCase());
  
  let score = 0;
  if (cat && (title.includes(cat) || desc.includes(cat))) score += 40;
  
  tags.forEach(t => {
    if (title.includes(t)) score += 30;
    if (desc.includes(t)) score += 20;
  });
  
  if (score >= 60) return { label: '초고밀도 일치', class: 'success' };
  if (score >= 30) return { label: '상당히 일치', class: 'warning' };
  return { label: '일반 채널', class: 'category' };
}

// Categories translator
function getCleanCategoryTags(topicCategories) {
  if (!topicCategories || topicCategories.length === 0) return [];
  
  const CORE_KOREAN_MAPPING = {
    'Music': '음악',
    'Gaming': '게임',
    'Sports': '스포츠',
    'Entertainment': '엔터테인먼트',
    'Technology': '기술',
    'Lifestyle': '라이프스타일',
    'Society': '사회',
    'Knowledge': '지식',
    'Hobby': '취미',
    'Action game': '액션 게임',
    'Strategy video game': '전략 게임',
    'Role-playing video game': 'RPG 게임',
    'Simulation video game': '시뮬레이션 게임',
    'Television program': '방송/TV',
    'Film': '영화',
    'Pop music': '대중음악',
    'Electronic music': '일렉트로닉',
    'Physical fitness': '피트니스',
    'Food': '요리/음식',
    'Fashion': '패션',
    'Tourism': '여행',
    'Humour': '유머'
  };

  return topicCategories.map(url => {
    const match = url.match(/\/([^/]+)$/);
    if (!match) return null;
    let rawTag = decodeURIComponent(match[1]).replace(/_/g, ' ');
    rawTag = rawTag.replace(/\s*\(.*\)\s*/g, '').trim();
    
    if (CORE_KOREAN_MAPPING[rawTag]) {
      return CORE_KOREAN_MAPPING[rawTag];
    }
    
    return rawTag.charAt(0).toUpperCase() + rawTag.slice(1);
  }).filter(Boolean);
}

// Format subscribers
function formatSubscribers(count) {
  if (count >= 10000) {
    const man = count / 10000;
    return `구독자 ${man.toFixed(1).replace('.0', '')}만명`;
  }
  return `구독자 ${count.toLocaleString()}명`;
}

// Cache-First Routing
async function checkSyncStatus() {
  const overlay = document.getElementById('sync-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
  if (statusIntervalId) {
    clearInterval(statusIntervalId);
    statusIntervalId = null;
  }
  await loadDashboardData();
}


// Load Dashboard Data
async function loadDashboardData() {
  try {
    // Check if flush is requested via URL search params
    if (window.location.search.includes('flush=true')) {
      console.warn("Flush parameter detected. Resetting database and storage caches...");
      const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
      window.history.replaceState({path: cleanUrl}, '', cleanUrl);
      
      try {
        await chrome.storage.local.clear();
      } catch (e) {}
      
      const delRequest = indexedDB.deleteDatabase('TubeManagerDB');
      delRequest.onsuccess = () => {
        console.log("Database deleted successfully during cache flush.");
        window.location.reload();
      };
      return;
    }

    const subscriptions = await getFromStore('youtube_subscriptions');
    const subMap = new Map(subscriptions.map(s => [s.id, s.subscribed_at || s.syncedAt]));

    const allChannels = await getFromStore('channels_master');
    videosList = await getFromStore('video_preview_cache');

    // ── Ingestion queue map: channelId → status ────────────────────────────────
    // Built here once per loadDashboardData() call; renderChannels() reads it
    // via the module-scoped window._ingestionQueueMap reference.
    try {
      const { ingestion_queue = [] } = await chrome.storage.local.get(['ingestion_queue']);
      window._ingestionQueueMap = new Map(ingestion_queue.map(q => [q.id, q.status]));
    } catch (_) {
      window._ingestionQueueMap = new Map();
    }

    const onboardingOverlay = document.getElementById('onboarding-overlay');
    const gridControls = document.querySelector('.grid-controls');
    const channelsGrid = document.getElementById('channels-grid');
    const tabsWrapper = document.querySelector('.tabs-wrapper');

    if (allChannels.length === 0) {
      if (onboardingOverlay) onboardingOverlay.style.display = 'flex';
      if (gridControls) gridControls.style.display = 'none';
      if (channelsGrid) channelsGrid.style.display = 'none';
      if (tabsWrapper) tabsWrapper.style.display = 'none';
    } else {
      if (onboardingOverlay) onboardingOverlay.style.display = 'none';
      if (gridControls) gridControls.style.display = 'flex';
      if (channelsGrid) channelsGrid.style.display = 'grid';
      if (tabsWrapper) tabsWrapper.style.display = 'flex';
    }

    await renderProfileDropdown();
    checkStaleSync();

    allChannels.forEach(c => {
      // Prioritize numeric timestamp from c.subscribed_at
      const subAtVal = c.subscribed_at || subMap.get(c.id) || c.syncedAt;
      c.subscribed_at = subAtVal ? (typeof subAtVal === 'string' || typeof subAtVal === 'object' ? new Date(subAtVal).getTime() : Number(subAtVal)) : Date.now();
      if (!c.status_flag) {
        c.status_flag = c.pending_delete ? 'PENDING' : 'SUBSCRIBED';
      }
      if (!c.first_registered_at) {
        c.first_registered_at = c.subscribed_at || Date.now();
      }
    });

    if (currentTab === 'active') {
      channelsList = allChannels;
    } else if (currentTab === 'migration') {
      const { global_migration_cart = [] } = await chrome.storage.local.get(['global_migration_cart']);
      channelsList = global_migration_cart;
    } else {
      channelsList = await getUnsubscribedChannelsFromCursor();
      channelsList.forEach(c => {
        const subAtVal = c.subscribed_at || subMap.get(c.id) || c.syncedAt;
        c.subscribed_at = subAtVal ? (typeof subAtVal === 'string' || typeof subAtVal === 'object' ? new Date(subAtVal).getTime() : Number(subAtVal)) : Date.now();
        if (!c.first_registered_at) {
          c.first_registered_at = c.subscribed_at || Date.now();
        }
      });
    }
    
    updateCategoryDropdown();
    renderMigrationChips();

    // Update statistics using allChannels
    const activeSubsList = allChannels.filter(c => c.status_flag === 'SUBSCRIBED' || c.status_flag === 'PENDING');
    document.getElementById('total-channels-stat').textContent = activeSubsList.length;
    const ghostCount = activeSubsList.filter(c => getInactivityDays(c) >= 90).length;
    document.getElementById('inactive-channels-stat').textContent = ghostCount;

    const entropyScore = activeSubsList.length > 0 ? Math.round((ghostCount / activeSubsList.length) * 100) : 0;
    const entropyElement = document.getElementById('entropy-score-stat');
    if (entropyElement) {
      entropyElement.textContent = `${entropyScore}%`;
    }

    renderChannels();
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
  }
}

function updateCategoryDropdown() {
  const filterSelect = document.getElementById('category-filter');
  if (!filterSelect) return;
  const prevCategory = filterSelect.value || "";
  
  filterSelect.innerHTML = '<option value="">전체 카테고리</option>';
  
  // Filter active channels
  const activeChannels = channelsList.filter(c => c.status_flag !== 'UNSUBSCRIBED');
  
  // Extract all topicCategories, clean them, and collect unique tags
  const categoriesSet = new Set();
  activeChannels.forEach(c => {
    const tags = getCleanCategoryTags(c.topicCategories);
    tags.forEach(t => {
      if (t) categoriesSet.add(t);
    });
  });
  
  // Sort alphabetically
  const sortedCategories = Array.from(categoriesSet).sort((a, b) => a.localeCompare(b));
  
  sortedCategories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    filterSelect.appendChild(opt);
  });
  
  // Append static "미분류" option at the absolute bottom
  const unclassifiedOpt = document.createElement('option');
  unclassifiedOpt.value = "미분류";
  unclassifiedOpt.textContent = "미분류";
  filterSelect.appendChild(unclassifiedOpt);
  
  if (Array.from(filterSelect.options).some(o => o.value === prevCategory)) {
    filterSelect.value = prevCategory;
  } else {
    filterSelect.value = "";
  }
}

function renderMigrationChips() {
  const container = document.getElementById('migration-chips-container');
  if (!container) return;
  if (currentTab !== 'migration') {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'flex';
  container.innerHTML = '';
  
  // Extract unique mappedCategory values ONLY from migration_cart items
  const uniqueCats = new Set();
  channelsList.forEach(c => {
    if (c.mappedCategory) {
      uniqueCats.add(c.mappedCategory);
    }
  });
  
  // Add "전체" chip
  const allChip = document.createElement('div');
  allChip.className = `migration-chip ${selectedMigrationCategory === '' ? 'active' : ''}`;
  allChip.textContent = '전체';
  allChip.style.cursor = 'pointer';
  allChip.style.padding = '6px 12px';
  allChip.style.borderRadius = '20px';
  allChip.style.fontSize = '12px';
  allChip.style.fontWeight = 'bold';
  allChip.style.background = selectedMigrationCategory === '' ? 'var(--accent-gradient)' : 'rgba(255,255,255,0.05)';
  allChip.style.color = 'white';
  allChip.style.border = '1px solid rgba(255,255,255,0.1)';
  allChip.style.transition = 'all 0.2s';
  allChip.addEventListener('click', () => {
    selectedMigrationCategory = '';
    renderMigrationChips();
    renderChannels();
  });
  container.appendChild(allChip);
  
  // Add other category chips
  Array.from(uniqueCats).sort().forEach(cat => {
    const chip = document.createElement('div');
    chip.className = `migration-chip ${selectedMigrationCategory === cat ? 'active' : ''}`;
    chip.textContent = cat;
    chip.style.cursor = 'pointer';
    chip.style.padding = '6px 12px';
    chip.style.borderRadius = '20px';
    chip.style.fontSize = '12px';
    chip.style.fontWeight = 'bold';
    chip.style.background = selectedMigrationCategory === cat ? 'var(--accent-gradient)' : 'rgba(255,255,255,0.05)';
    chip.style.color = 'white';
    chip.style.border = '1px solid rgba(255,255,255,0.1)';
    chip.style.transition = 'all 0.2s';
    chip.addEventListener('click', () => {
      selectedMigrationCategory = cat;
      renderMigrationChips();
      renderChannels();
    });
    container.appendChild(chip);
  });
}

async function reconcileMigrationCart() {
  const { global_migration_cart = [] } = await chrome.storage.local.get(['global_migration_cart']);
  if (global_migration_cart.length === 0) return;
  
  const db = await openDB();
  const tx = db.transaction(['channels_master'], 'readonly');
  const store = tx.objectStore('channels_master');
  const activeChannels = await new Promise((resolve) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
  db.close();
  
  const activeIds = new Set(activeChannels.filter(c => c.status_flag === 'SUBSCRIBED').map(c => c.id));
  const updatedCart = global_migration_cart.filter(c => !activeIds.has(c.id));
  
  if (updatedCart.length !== global_migration_cart.length) {
    await chrome.storage.local.set({ global_migration_cart: updatedCart });
    showSilentToast('이전 완료된 채널이 카트에서 자동으로 제거되었습니다.', 'linear-gradient(135deg, #38B000, #38B000)');
  }
}

// ============================================================
// [Stage 3 — Hybrid Ingestion] ytInitialData + RSS two-phase scraper
// Phase 1: Fetches channel page → parses ytInitialData JSON
//   → detects Videos/Shorts/Live content presence
//   → hydrates video_preview_cache with top-3 preview entries
// Phase 2: Always fetches RSS → gets exact ISO-8601 published timestamp
// URL Router: "@handle" → /handle route; "UC…" → /channel/{id} route
// SPOF Guard: any Phase 1 failure silently falls through to RSS-only path
// ============================================================
async function syncLatestVideosRSS(ownerId, onProgress) {
  // Phase 0: read channel list — safe single-request readonly tx
  const channels = await new Promise((resolve) => {
    openDB().then(db => {
      try {
        const tx = db.transaction(['channels_master'], 'readonly');
        const req = tx.objectStore('channels_master').getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror  = () => { db.close(); resolve([]); };
      } catch (e) { console.warn('[RSS] Phase 0 error:', e); resolve([]); }
    }).catch(e => { console.warn('[RSS] openDB failed:', e); resolve([]); });
  });

  const targetChannels = channels.filter(
    c => c.status_flag === 'SUBSCRIBED' || c.status_flag === 'PENDING'
  );
  const total = targetChannels.length;
  if (total === 0) return 0;

  let done = 0;
  const CHUNK_SIZE    = 8;
  const STAGGER_MS    = 100;
  const INTER_CHUNK_MS = 150;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── URL Router ────────────────────────────────────────────────────────────
  // YouTube channel pages can be addressed by two different URL patterns.
  // Mixing them up causes HTTP 404 which kills the scrape silently.
  function buildChannelPageUrl(channel) {
    const handle = channel.handle || channel.customUrl || '';
    if (handle && handle.startsWith('@')) {
      // Custom handle route: https://www.youtube.com/@handle
      return `https://www.youtube.com/${handle}`;
    }
    // UC-prefixed channel ID route
    return `https://www.youtube.com/channel/${channel.id}`;
  }

  // ── Phase 1: ytInitialData scraper ───────────────────────────────────────
  // Returns { hasVideos, hasShorts, hasLive, previews: [{id,title,thumbnail}] }
  // NEVER throws — all exceptions resolve to { hasVideos: false, ... }
  async function scrapeYtInitialData(channel, signal) {
    const pageUrl = buildChannelPageUrl(channel);
    try {
      const pageRes = await fetch(pageUrl, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',   // anonymous — no cookie header (Q1 resolution)
        signal
      });
      if (!pageRes.ok) {
        console.warn(`[ytInitialData] HTTP ${pageRes.status} for ${channel.id} — skipping scrape`);
        return { hasVideos: false, hasShorts: false, hasLive: false, previews: [] };
      }
      const html = await pageRes.text();

      // Fault-tolerant regex — two common ytInitialData serialisation patterns
      const match =
        html.match(/window\["ytInitialData"\]\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) ||
        html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*(?:window\["ytInitialData"\]|<\/script>)/);

      if (!match) {
        console.warn(`[ytInitialData] Regex miss for ${channel.id} — falling back to RSS`);
        return { hasVideos: false, hasShorts: false, hasLive: false, previews: [] };
      }

      let ytData;
      try {
        ytData = JSON.parse(match[1]);
      } catch (jsonErr) {
        console.warn(`[ytInitialData] JSON.parse failed for ${channel.id}:`, jsonErr.message);
        return { hasVideos: false, hasShorts: false, hasLive: false, previews: [] };
      }

      // Navigate to the tabs array — path is consistent across channel types
      const tabs = ytData?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
      let hasVideos = false, hasShorts = false, hasLive = false;
      const previews = [];

      for (const tabEntry of tabs) {
        const tab = tabEntry?.tabRenderer;
        if (!tab) continue;
        const tabTitle = (tab.title || '').toLowerCase();
        const isVideos = tabTitle === 'videos' || tabTitle === '동영상';
        const isShorts = tabTitle === 'shorts';
        const isLive   = tabTitle === 'live'   || tabTitle === '라이브';

        // Extract richItemRenderer content nodes
        const contentNodes =
          tab?.content?.richGridRenderer?.contents ||
          tab?.content?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

        if (contentNodes.length > 0) {
          if (isVideos) hasVideos = true;
          if (isShorts) hasShorts = true;
          if (isLive)   hasLive   = true;
        }

        // Collect top-3 previews from Videos tab only
        if (isVideos && previews.length < 3) {
          for (const node of contentNodes) {
            if (previews.length >= 3) break;
            const vr = node?.richItemRenderer?.content?.videoRenderer;
            if (!vr?.videoId) continue;
            const thumbs = vr.thumbnail?.thumbnails || [];
            previews.push({
              id: vr.videoId,
              target_channel_id: channel.id,
              title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || '',
              thumbnail: thumbs[thumbs.length - 1]?.url || thumbs[0]?.url || '',
              syncedAt: new Date().toISOString()
            });
          }
        }
      }

      return { hasVideos, hasShorts, hasLive, previews };
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`[ytInitialData] Timeout for ${channel.id}`);
      } else {
        console.warn(`[ytInitialData] Scrape error for ${channel.id}:`, err.message);
      }
      return { hasVideos: false, hasShorts: false, hasLive: false, previews: [] };
    }
  }

  // ── Preview Cache IDB Write ───────────────────────────────────────────────
  // Callback-chain only — no await inside the transaction.
  function writeVideoPreviewCache(previewItems) {
    if (!previewItems || previewItems.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      openDB().then(db => {
        let tx;
        try {
          tx = db.transaction(['video_preview_cache'], 'readwrite');
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror    = () => { db.close(); console.warn('[PreviewCache] tx error:', tx.error); resolve(); };
          tx.onabort    = () => { db.close(); console.warn('[PreviewCache] tx aborted'); resolve(); };
          const store = tx.objectStore('video_preview_cache');
          for (const item of previewItems) {
            try { store.put(item); } catch (putErr) { console.warn('[PreviewCache] put error:', putErr); }
          }
          // tx.oncomplete fires after all puts complete
        } catch (txErr) {
          console.warn('[PreviewCache] transaction error:', txErr);
          try { db.close(); } catch (_) {}
          resolve();
        }
      }).catch(dbErr => { console.warn('[PreviewCache] openDB failed:', dbErr); resolve(); });
    });
  }

  // ── Fetch + Parse (RSS path) ──────────────────────────────────────────────
  // NEVER throws. AbortController enforces a 3-second deadline per channel.
  async function fetchRSSForChannel(channel) {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(rssUrl, { method: 'GET', cache: 'no-store', signal: controller.signal });
      if (response.status === 429) {
        console.warn('[RSS] Rate limited — backing off...', channel.id);
        return { channelId: channel.id, channelTitle: channel.title || channel.id, rateLimited: true, lastUploadedAt: null };
      }
      if (!response.ok) {
        console.warn(`[RSS] HTTP ${response.status} for ${channel.id} — fallback 0`);
        return { channelId: channel.id, channelTitle: channel.title || channel.id, rateLimited: false, lastUploadedAt: 0 };
      }
      const text = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(text, 'application/xml');
      if (doc.querySelector('parsererror')) {
        return { channelId: channel.id, channelTitle: channel.title || channel.id, rateLimited: false, lastUploadedAt: 0 };
      }
      const publishedNode = doc.querySelector('entry > published');
      if (publishedNode?.textContent) {
        const ts = new Date(publishedNode.textContent.trim()).getTime();
        return { channelId: channel.id, channelTitle: channel.title || channel.id, rateLimited: false, lastUploadedAt: isNaN(ts) ? 0 : ts };
      }
      return { channelId: channel.id, channelTitle: channel.title || channel.id, rateLimited: false, lastUploadedAt: 0 };
    } catch (err) {
      if (err.name === 'AbortError') {
        console.warn(`[RSS Timeout] Channel ${channel.id} hung over 3s. Forcing skip.`);
        return { channelId: channel.id, channelTitle: channel.title || channel.id, rateLimited: false, lastUploadedAt: 0 };
      }
      console.warn(`[RSS] fetch() exception for ${channel.id}:`, err.message || err);
      return { channelId: channel.id, channelTitle: channel.title || channel.id, rateLimited: false, lastUploadedAt: null };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Two-phase hybrid per channel ──────────────────────────────────────────
  async function processChannel(channel) {
    // Phase 1: ytInitialData scrape (3s timeout, shared with RSS timeout budget)
    const pageController = new AbortController();
    const pageTimeout    = setTimeout(() => pageController.abort(), 5000);
    let scraped;
    try {
      scraped = await scrapeYtInitialData(channel, pageController.signal);
    } finally {
      clearTimeout(pageTimeout);
    }

    // Hydrate preview cache from Phase 1 results (fire-and-forget, non-blocking)
    if (scraped.previews && scraped.previews.length > 0) {
      writeVideoPreviewCache(scraped.previews).catch(() => {});
    }

    // Phase 2: RSS always runs to get the exact timestamp
    const rssResult = await fetchRSSForChannel(channel);

    // Resolve final lastUploadedAt
    let lastUploadedAt = rssResult.lastUploadedAt;

    if ((lastUploadedAt === null || lastUploadedAt === 0) && (scraped.hasShorts || scraped.hasLive)) {
      // Channel has Shorts/Live content but no standard video RSS entry.
      // Write a heuristic "active in last 7 days" signal so Stage 4 does NOT
      // classify this channel as a zombie (false positive elimination).
      lastUploadedAt = Date.now() - 7 * 24 * 60 * 60 * 1000;
      console.warn(`[Hybrid] Shorts/Live-only channel ${channel.id} — writing heuristic ts`);
    }

    return {
      channelId: rssResult.channelId,
      channelTitle: rssResult.channelTitle,
      rateLimited: rssResult.rateLimited,
      lastUploadedAt
    };
  }

  // ── Write channels_master.last_uploaded_at ────────────────────────────────
  // Callback-chain only IDB — no await inside transaction.
  function writeLastUploadedAt(channelId, lastUploadedAt) {
    return new Promise((resolve) => {
      openDB().then(db => {
        let tx;
        try {
          tx = db.transaction(['channels_master'], 'readwrite');
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror    = () => { db.close(); console.warn('[RSS IDB] tx error:', tx.error); resolve(); };
          tx.onabort    = () => { db.close(); console.warn('[RSS IDB] tx aborted:', tx.error); resolve(); };
          const store  = tx.objectStore('channels_master');
          const getReq = store.get(channelId);
          getReq.onsuccess = () => {
            try {
              const record = getReq.result;
              if (record) {
                record.last_uploaded_at = lastUploadedAt;
                record.last_synced_at   = Date.now();
                store.put(record);
              } else {
                console.warn(`[RSS IDB] No master record for ${channelId}`);
              }
            } catch (putErr) { console.warn('[RSS IDB] put() error:', putErr); }
          };
          getReq.onerror = () => { console.warn('[RSS IDB] get() error for', channelId, getReq.error); };
        } catch (txErr) {
          console.warn('[RSS IDB] transaction open error:', txErr);
          try { db.close(); } catch (_) {}
          resolve();
        }
      }).catch(dbErr => { console.warn('[RSS IDB] openDB() failed:', dbErr); resolve(); });
    });
  }

  // ── Main ingestion loop ───────────────────────────────────────────────────
  await chrome.storage.local.set({
    syncStatus: 'STEP3_IN_PROGRESS',
    step3RssProgress: { done: 0, total },
    timestamp: new Date().toISOString()
  });

  for (let i = 0; i < total; i += CHUNK_SIZE) {
    const curState = await chrome.storage.local.get(['syncStatus']);
    if (curState.syncStatus === 'paused') {
      console.warn('[RSS] Paused by user at chunk', i);
      break;
    }

    const chunk = targetChannels.slice(i, i + CHUNK_SIZE);

    const results = await Promise.all(
      chunk.map((ch, idx) =>
        sleep(idx * STAGGER_MS).then(async () => {
          try {
            return await processChannel(ch);
          } catch (unhandled) {
            console.warn('[Hybrid] Unhandled slot exception for', ch.id, unhandled);
            return { channelId: ch.id, channelTitle: ch.title || ch.id, rateLimited: false, lastUploadedAt: null };
          }
        })
      )
    );

    // 429 global backoff
    const rateLimitedSlots = results.filter(r => r.rateLimited);
    if (rateLimitedSlots.length > 0) {
      rateLimitedSlots.forEach(r => console.warn('[RSS] Rate limited — backing off...', r.channelId));
      await chrome.storage.local.set({ syncStatus: 'STEP3_RATE_LIMITED', timestamp: new Date().toISOString() });
      await sleep(3000);
      await chrome.storage.local.set({ syncStatus: 'STEP3_IN_PROGRESS', timestamp: new Date().toISOString() });
    }

    for (const result of results) {
      try {
        if (!result.rateLimited && result.lastUploadedAt !== null) {
          await writeLastUploadedAt(result.channelId, result.lastUploadedAt);
        }
      } catch (writeErr) {
        console.warn('[RSS] writeLastUploadedAt outer catch for', result.channelId, writeErr);
      } finally {
        done++;
        console.log(`[RSS Ingestion] ${done}/${total} processed: ${result.channelTitle || result.channelId}`);
        if (onProgress) { try { onProgress(done, total); } catch (_) {} }
      }
    }

    await chrome.storage.local.set({
      syncStatus: 'STEP3_IN_PROGRESS',
      step3RssProgress: { done, total },
      timestamp: new Date().toISOString()
    });

    if (i + CHUNK_SIZE < total) await sleep(INTER_CHUNK_MS);
  }

  await chrome.storage.local.set({
    syncStatus: 'STEP3_COMPLETED',
    step3RssProgress: { done: total, total },
    timestamp: new Date().toISOString()
  });

  console.log(`[Hybrid] Stage 3 complete: ${done}/${total} channels processed`);
  return done;
}


// Render Channels
function renderChannels() {
  const catFilter = document.getElementById('category-filter').value;
  const inactFilter = parseInt(document.getElementById('inactivity-filter').value, 10);
  const subFilter = document.getElementById('subscriber-filter').value;
  const sortVal = document.getElementById('sort-select').value;
  
  const grid = document.getElementById('channels-grid');
  grid.innerHTML = '';

  // Tab State view isolation: Filter first based on current tab state
  let filtered = [];
  if (currentTab === 'active') {
    filtered = channelsList.filter(c => c.status_flag === 'SUBSCRIBED' || c.status_flag === 'PENDING');
  } else if (currentTab === 'migration') {
    filtered = channelsList;
  } else {
    filtered = channelsList.filter(c => c.status_flag === 'UNSUBSCRIBED');
  }

  if (currentTab === 'migration' && selectedMigrationCategory !== '') {
    filtered = filtered.filter(c => c.mappedCategory === selectedMigrationCategory);
  }

  filtered = filtered.map(c => {
    return {
      ...c,
      inactivityDays: getInactivityDays(c)
    };
  });

  if (catFilter !== "") {
    if (catFilter === "미분류") {
      filtered = filtered.filter(c => {
        const tags = getCleanCategoryTags(c.topicCategories);
        return !tags || tags.length === 0;
      });
    } else {
      filtered = filtered.filter(c => {
        const tags = getCleanCategoryTags(c.topicCategories);
        return tags && tags.includes(catFilter);
      });
    }
  }

  if (inactFilter > 0) {
    filtered = filtered.filter(c => c.inactivityDays >= inactFilter);
  }

  if (subFilter !== 'all') {
    filtered = filtered.filter(c => {
      const subs = c.subscriber_count !== undefined ? c.subscriber_count : (c.subscriberCount || 0);
      if (subFilter === 'micro') return subs <= 10000;
      if (subFilter === 'medium') return subs <= 100000;
      if (subFilter === 'mega') return subs >= 1000000;
      return true;
    });
  }

  filtered.sort((a, b) => {
    if (sortVal === 'registered-asc') {
      const aReg = a.first_registered_at || a.subscribed_at || 0;
      const bReg = b.first_registered_at || b.subscribed_at || 0;
      return aReg - bReg;
    }
    if (sortVal === 'zombie-desc') return getZombieIndex(b) - getZombieIndex(a);
    if (sortVal === 'subscribed-desc') {
      const aSub = a.subscribed_at || 0;
      const bSub = b.subscribed_at || 0;
      return bSub - aSub;
    }
    if (sortVal === 'subscribed-asc') {
      const aSub = a.subscribed_at || 0;
      const bSub = b.subscribed_at || 0;
      return aSub - bSub;
    }
    if (sortVal === 'inactive-desc') return b.inactivityDays - a.inactivityDays;
    if (sortVal === 'sub-asc') {
      const aSubs = a.subscriber_count !== undefined ? a.subscriber_count : (a.subscriberCount || 0);
      const bSubs = b.subscriber_count !== undefined ? b.subscriber_count : (b.subscriberCount || 0);
      return aSubs - bSubs;
    }
    if (sortVal === 'title-asc') return a.title.localeCompare(b.title);
    const aReg = a.first_registered_at || a.subscribed_at || 0;
    const bReg = b.first_registered_at || b.subscribed_at || 0;
    return aReg - bReg;
  });

  if (filtered.length === 0) {
    grid.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: rgba(255,255,255,0.4); padding: 40px;">조건에 부합하는 채널이 없습니다.</div>';
    return;
  }

  filtered.forEach(ch => {
    const card = document.createElement('div');
    card.className = 'channel-card';
    card.setAttribute('data-id', ch.id);
    card.style.cursor = 'pointer';
    
    if (ch.status_flag === 'PENDING') {
      card.style.filter = 'blur(1.5px) opacity(0.6)';
    } else {
      card.style.filter = 'none';
    }
    
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('card-select') || e.target.type === 'checkbox' || e.target.classList.contains('resubscribe-btn') || e.target.classList.contains('migrate-sub-btn')) {
        return;
      }
      openChannelModal(ch);
    });
    
    const isChecked = selectedChannelIds.has(ch.id) ? 'checked' : '';
    const initial = ch.title ? ch.title.charAt(0) : '?';
    const subVal = ch.subscriber_count !== undefined ? ch.subscriber_count : (ch.subscriberCount || 0);
    const videoVal = ch.video_count !== undefined ? ch.video_count : (ch.videoCount || 0);
    
    const subStr = formatSubscribers(subVal);
    const subscribedDays = getSubscribedDays(ch);

    const neglectDays = ch.inactivityDays;
    let neglectHtml = '';
    if (ch.status_flag === 'PENDING') {
      neglectHtml = `<span class="neglect-tag danger" style="background:#e63946; color:white;">구독 취소 예약중 - 5초 후 집행</span>`;
    } else if (isChannelUnanalyzed(ch)) {
      // [분석 대기 중] — data not yet scraped by ingestion queue.
      // Suppress zombie badges entirely to prevent false classification.
      neglectHtml = `<span class="neglect-tag pending-analysis">분석 대기 중</span>`;
    } else if (neglectDays >= 90) {
      neglectHtml = `<span class="neglect-tag danger">잠수 ${neglectDays}일</span>`;
    } else if (neglectDays >= 30) {
      neglectHtml = `<span class="neglect-tag warning">방치 ${neglectDays}일</span>`;
    } else {
      neglectHtml = `<span class="neglect-tag success">최근 업로드</span>`;
    }

    const affinity = getIdentityAffinity(ch);

    let actionAreaHtml = '';
    if (currentTab === 'active') {
      actionAreaHtml = `<input type="checkbox" class="card-select" data-id="${ch.id}" ${isChecked}>`;
    } else if (currentTab === 'history') {
      actionAreaHtml = `<button class="resubscribe-btn secondary-btn" style="padding: 4px 8px; font-size: 10px; font-weight: 700; border-radius: 6px; cursor: pointer;" onclick="window.open('https://www.youtube.com/channel/${ch.id}', '_blank')">유튜브에서 다시 구독하기</button>`;
    } else if (currentTab === 'migration') {
      const isPendingConfirm = pendingConfirmationChannelIds.has(ch.id);
      const btnStyle = isPendingConfirm ? 'background: #FB8500 !important; color: white;' : '';
      const btnText = isPendingConfirm ? '[확인 대기]' : '[구독하기]';
      actionAreaHtml = `<button class="migrate-sub-btn action-btn" data-id="${ch.id}" style="padding: 4px 8px; font-size: 10px; font-weight: 700; border-radius: 6px; cursor: pointer; ${btnStyle}">${btnText}</button>`;
    }

    // ── Card body: mask stat rows with skeleton if unanalyzed ────────────────
    const unanalyzed = isChannelUnanalyzed(ch);
    const cardBadgeBody = unanalyzed
      ? `<div class="skeleton-row" style="width: 75%;"></div>
         <div class="skeleton-row" style="width: 55%; margin-top: 4px;"></div>
         <div class="skeleton-row" style="width: 40%; margin-top: 4px;"></div>`
      : `<div>구독한 지 <strong>${subscribedDays.toLocaleString()}일째</strong></div>
         <div>마지막 업로드 : <strong>${getLastUploadDateStr(ch)}</strong></div>
         <div>${subStr} • 비디오 ${videoVal.toLocaleString()}개</div>
         <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
           <span style="font-size: 9px; color: rgba(248,249,250,0.45);">좀비지수: ${getZombieIndex(ch).toFixed(1)}</span>
           <span class="badge ${affinity.class}" style="padding: 2px 6px; font-size: 9px;">${affinity.label}</span>
         </div>`;

    card.innerHTML = `
      <div class="card-top">
        <span class="badge category">${ch.mappedCategory || '미분류'}</span>
        <div class="card-top-right">
          ${neglectHtml}
          ${actionAreaHtml}
        </div>
      </div>
      <div class="card-header-info">
        <div class="avatar">
          ${ch.thumbnail ? `<img src="${ch.thumbnail}" alt="${ch.title}">` : initial}
        </div>
        <div class="channel-info">
          <div class="channel-name" title="${ch.title}">${ch.title}</div>
          <div class="channel-details">${ch.customUrl || ''}</div>
        </div>
      </div>
      <div class="card-badge-container" style="display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: rgba(248,249,250,0.65);">
        ${cardBadgeBody}
      </div>
    `;

    const checkbox = card.querySelector('.card-select');
    if (checkbox) {
      checkbox.addEventListener('change', (e) => {
        if (e.target.checked) {
          selectedChannelIds.add(ch.id);
        } else {
          selectedChannelIds.delete(ch.id);
        }
        updateBulkButtonState();
      });
    }

    const migrateSubBtn = card.querySelector('.migrate-sub-btn');
    if (migrateSubBtn) {
      migrateSubBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const chId = migrateSubBtn.dataset.id;
        pendingConfirmationChannelIds.add(chId);
        chrome.tabs.create({ url: `https://www.youtube.com/channel/${chId}?sub_confirmation=1` });
        renderChannels();
      });
    }

    grid.appendChild(card);
  });
}

// Silent Toast
function showSilentToast(msg, bgGradient = 'linear-gradient(135deg, #FFB703, #FB8500)') {
  const container = document.getElementById('undo-toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast-item glass-card';
  toast.style.pointerEvents = 'auto';
  toast.style.padding = '12px 20px';
  toast.style.minWidth = '340px';
  toast.style.background = 'rgba(20, 20, 24, 0.95)';
  toast.style.border = '1px solid rgba(255, 255, 255, 0.1)';
  toast.style.borderRadius = '14px';
  toast.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.5)';
  toast.style.transition = 'all 0.3s ease';

  toast.innerHTML = `
    <div style="display: flex; align-items: center; gap: 8px;">
      <div style="width: 8px; height: 8px; border-radius: 50%; background: ${bgGradient.includes('e63946') ? '#e63946' : '#FFB703'};"></div>
      <span style="font-size: 12px; font-weight: 700; color: #fff;">${msg}</span>
    </div>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Undo Toast Notification
function showUndoToast(ch) {
  const container = document.getElementById('undo-toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast-item glass-card';
  toast.style.pointerEvents = 'auto';
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.justifyContent = 'space-between';
  toast.style.padding = '12px 20px';
  toast.style.minWidth = '340px';
  toast.style.background = 'rgba(20, 20, 24, 0.9)';
  toast.style.border = '1px solid rgba(255, 255, 255, 0.1)';
  toast.style.borderRadius = '14px';
  toast.style.boxShadow = '0 10px 30px rgba(0, 0, 0, 0.5)';
  
  let timeLeft = 5;

  toast.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 2px;">
      <span style="font-size: 13px; font-weight: 700; color: #fff;">'${ch.title}' 구독 취소 예약됨</span>
      <span class="countdown-text" style="font-size: 11px; color: rgba(255,255,255,0.6);">${timeLeft}초 내에 되돌릴 수 있습니다.</span>
    </div>
    <button class="undo-btn" style="background: var(--accent-gradient); border: none; border-radius: 8px; color: white; padding: 6px 12px; font-size: 12px; font-weight: 700; cursor: pointer; transition: background 0.2s;">되돌리기</button>
  `;

  const undoBtn = toast.querySelector('.undo-btn');
  undoBtn.onclick = () => {
    // Immediately revert memory state and redraw UI
    const found = channelsList.find(c => c.id === ch.id);
    if (found) {
      found.status_flag = 'SUBSCRIBED';
      found.pending_delete = false;
    }
    renderChannels();

    chrome.runtime.sendMessage({ action: 'CANCEL_PENDING_DELETE', channelId: ch.id }, async (res) => {
      if (res && res.status === 'completed') {
        clearInterval(timer);
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 300);
        await loadDashboardData();
      } else {
        // Revert on failure
        if (found) {
          found.status_flag = 'PENDING';
          found.pending_delete = true;
        }
        renderChannels();
      }
    });
  };

  container.appendChild(toast);

  const countdownText = toast.querySelector('.countdown-text');
  const timer = setInterval(() => {
    timeLeft--;
    if (timeLeft <= 0) {
      clearInterval(timer);
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
      
      // Update memory state to UNSUBSCRIBED upon expiration and redraw UI
      const found = channelsList.find(c => c.id === ch.id);
      if (found) {
        found.status_flag = 'UNSUBSCRIBED';
        found.pending_delete = false;
      }
      renderChannels();
      loadDashboardData();
    } else {
      countdownText.textContent = `${timeLeft}초 내에 되돌릴 수 있습니다.`;
    }
  }, 1000);
}

// Channel Details Modal
async function openChannelModal(ch) {
  const modal = document.getElementById('channel-modal');
  
  const avatar = document.getElementById('modal-avatar');
  const initial = ch.title ? ch.title.charAt(0) : '?';
  if (ch.thumbnail) {
    avatar.innerHTML = `<img src="${ch.thumbnail}" alt="${ch.title}">`;
  } else {
    avatar.textContent = initial;
  }

  const subVal = ch.subscriber_count !== undefined ? ch.subscriber_count : (ch.subscriberCount || 0);
  const videoVal = ch.video_count !== undefined ? ch.video_count : (ch.videoCount || 0);
  const viewVal = ch.view_count !== undefined ? ch.view_count : (ch.viewCount || 0);

  document.getElementById('modal-channel-name').textContent = ch.title;
  document.getElementById('modal-channel-handle').textContent = ch.customUrl || '';

  document.getElementById('modal-stat-subs').textContent = formatSubscribers(subVal);
  document.getElementById('modal-stat-videos').textContent = `${videoVal.toLocaleString()}개`;
  document.getElementById('modal-stat-views').textContent = `${viewVal.toLocaleString()}회`;

  const subscribedDays = getSubscribedDays(ch);
  document.getElementById('modal-subscribed-since-label').textContent = `구독 정보 (구독한 지 ${subscribedDays.toLocaleString()}일째)`;

  const warning = document.getElementById('modal-neglect-warning');
  const neglectDays = getInactivityDays(ch);
  if (neglectDays >= 90) {
    warning.style.color = '#e63946';
    warning.textContent = `⚠️ [경고] 최근 업로드 영상 없음 (${neglectDays}일째 잠수 중) / 마지막 업로드 : ${getLastUploadDateStr(ch)}`;
  } else {
    warning.style.color = '#38b000';
    warning.textContent = `✓ 정상 활동 중 (마지막 업로드 : ${getLastUploadDateStr(ch)} / ${neglectDays}일 경과)`;
  }

  const tagsContainer = document.getElementById('modal-tags');
  tagsContainer.innerHTML = '';
  const tags = getCleanCategoryTags(ch.topicCategories);
  if (tags.length > 0) {
    tags.forEach(t => {
      const tagSpan = document.createElement('span');
      tagSpan.className = 'modal-tag';
      tagSpan.textContent = `#${t}`;
      tagsContainer.appendChild(tagSpan);
    });
  } else {
    const tagSpan = document.createElement('span');
    tagSpan.className = 'modal-tag';
    tagSpan.textContent = `#${ch.mappedCategory || '미분류'}`;
    tagsContainer.appendChild(tagSpan);
  }

  const previewList = document.getElementById('modal-video-preview-list');
  previewList.innerHTML = '';
  
  let channelVids = [];
  try {
    const channelId = ch.id;
    const db = await openDB();
    const tx = db.transaction(['video_preview_cache'], 'readonly');
    const store = tx.objectStore('video_preview_cache');
    const allCachedVideos = await new Promise((resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
    db.close();
    
    // --- CRITICAL INFRASTRUCTURE TELEMETRY ---
    console.log("[Modal Invariant Audit] Requested ChannelId passed to modal:", channelId);
    console.log("[Modal Invariant Audit] Total rows retrieved from DB store:", allCachedVideos.length);
    if (allCachedVideos.length > 0) {
      console.log("[Modal Invariant Audit] Sample Row structure from DB:", allCachedVideos[0]);
    }
    // ----------------------------------------
    
    const targetVideos = allCachedVideos.filter(v => v.target_channel_id === channelId);
    targetVideos.sort((a, b) => (b.uploaded_at || 0) - (a.uploaded_at || 0));
    channelVids = targetVideos.slice(0, 3);
  } catch (err) {
    console.warn('[Modal] Failed to query video_preview_cache:', err);
  }

  if (channelVids.length > 0) {
    channelVids.forEach(v => {
      const item = document.createElement('div');
      item.className = 'video-item';
      item.style.display = 'flex';
      item.style.gap = '12px';
      item.style.alignItems = 'center';
      item.style.padding = '8px';
      item.style.borderRadius = '10px';
      item.style.background = 'rgba(255,255,255,0.03)';
      item.style.border = '1px solid rgba(255,255,255,0.05)';
      item.style.cursor = 'pointer';
      item.style.transition = 'background 0.2s';
      
      item.onmouseover = () => item.style.background = 'rgba(255,255,255,0.08)';
      item.onmouseout = () => item.style.background = 'rgba(255,255,255,0.03)';
      
      item.onclick = () => {
        window.open(`https://www.youtube.com/watch?v=${v.id}`, '_blank');
      };
      
      const thumbUrl = v.thumbnail || 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?auto=format&fit=crop&w=120&q=80';
      const dateStr = v.uploaded_at ? new Date(v.uploaded_at).toISOString().split('T')[0] : '알 수 없음';
      
      item.innerHTML = `
        <div class="video-thumb-container" style="width: 100px; aspect-ratio: 16/9; border-radius: 6px; overflow: hidden; flex-shrink: 0; background: #000;">
          <img src="${thumbUrl}" style="width: 100%; height: 100%; object-fit: cover;" alt="${v.title}">
        </div>
        <div class="video-info-container" style="display: flex; flex-direction: column; justify-content: center; min-width: 0; flex: 1;">
          <div class="video-title" style="font-size: 12px; font-weight: 700; color: white; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; margin-bottom: 4px;" title="${v.title}">
            ${v.title}
          </div>
          <div class="video-date" style="font-size: 10px; color: rgba(255,255,255,0.4);">
            최종 업로드: ${dateStr}
          </div>
        </div>
      `;
      previewList.appendChild(item);
    });
  } else {
    previewList.innerHTML = '<div style="font-size: 12px; color: rgba(255,255,255,0.4); text-align: center; padding: 12px;">채널의 최종 업로드 기록을 동기화 중이거나 콘텐츠가 없습니다.</div>';
  }

  document.getElementById('modal-description').textContent = ch.description || '설명이 없습니다.';

  const goBtn = document.getElementById('modal-go-to-channel');
  const channelUrl = ch.customUrl 
    ? `https://www.youtube.com/${ch.customUrl}` 
    : `https://www.youtube.com/channel/${ch.id}`;
  goBtn.href = channelUrl;

  const unsubBtn = document.getElementById('modal-unsubscribe-btn');
  
  if (ch.status_flag === 'PENDING') {
    unsubBtn.style.background = '#d62246';
    unsubBtn.textContent = '구독 취소 예약 해제';
    unsubBtn.onclick = () => {
      // Instantly revert state in memory and redraw
      const found = channelsList.find(c => c.id === ch.id);
      if (found) {
        found.status_flag = 'SUBSCRIBED';
        found.pending_delete = false;
      }
      renderChannels();

      chrome.runtime.sendMessage({ action: 'CANCEL_PENDING_DELETE', channelId: ch.id }, async (res) => {
        if (res && res.status === 'completed') {
          modal.style.display = 'none';
          await loadDashboardData();
          showSilentToast('구독 취소 예약을 취소하였습니다.', 'linear-gradient(135deg, #38B000, #38B000)');
        } else {
          // Revert back on failure
          if (found) {
            found.status_flag = 'PENDING';
            found.pending_delete = true;
          }
          renderChannels();
        }
      });
    };
  } else if (ch.status_flag === 'UNSUBSCRIBED') {
    unsubBtn.style.background = 'rgba(255,255,255,0.08)';
    unsubBtn.textContent = '이미 구독 해제된 채널';
    unsubBtn.disabled = true;
  } else {
    unsubBtn.style.background = 'var(--accent-gradient)';
    unsubBtn.textContent = '1초 만에 이 채널 구독 취소하기';
    unsubBtn.disabled = false;
    unsubBtn.onclick = () => {
      unsubBtn.disabled = true;
      unsubBtn.textContent = '구독 취소 예약됨';
      
      // Instantly switch state in memory and redraw
      const found = channelsList.find(c => c.id === ch.id);
      if (found) {
        found.status_flag = 'PENDING';
        found.pending_delete = true;
        found.pending_delete_time = Date.now();
      }
      renderChannels();
      
      chrome.runtime.sendMessage({ action: 'START_PENDING_DELETE', channelId: ch.id }, (res) => {
        if (res && res.status === 'completed') {
          showUndoToast(ch);
          modal.style.display = 'none';
          loadDashboardData();
        } else {
          // Revert back on failure
          if (found) {
            found.status_flag = 'SUBSCRIBED';
            found.pending_delete = false;
          }
          renderChannels();
          alert('구독 취소 처리에 실패했습니다.');
          unsubBtn.disabled = false;
          unsubBtn.textContent = '1초 만에 이 채널 구독 취소하기';
        }
      });
    };
  }

  document.getElementById('modal-close-btn').onclick = () => {
    modal.style.display = 'none';
  };
  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
    }
  };
  modal.style.display = 'flex';
}

function updateBulkButtonState() {
  const bulkBtn = document.getElementById('bulk-unsub-btn');
  if (bulkBtn) {
    bulkBtn.disabled = selectedChannelIds.size === 0;
    bulkBtn.textContent = `선택 채널 구독 취소 (${selectedChannelIds.size}개)`;
  }
  const migrateBtn = document.getElementById('bulk-migrate-btn');
  if (migrateBtn) {
    migrateBtn.disabled = selectedChannelIds.size === 0;
    migrateBtn.textContent = `선택 채널 이전 카트에 담기 (${selectedChannelIds.size}개)`;
  }
}

const migrateBtn = document.getElementById('bulk-migrate-btn');
if (migrateBtn) {
  migrateBtn.addEventListener('click', async () => {
    const selectedCheckboxes = Array.from(document.querySelectorAll('.card-select:checked'));
    const ids = selectedCheckboxes.map(cb => cb.dataset.id).filter(Boolean);
    if (ids.length === 0) return;
    
    const { global_migration_cart = [] } = await chrome.storage.local.get(['global_migration_cart']);
    
    let addedCount = 0;
    ids.forEach(id => {
      const ch = channelsList.find(c => c.id === id);
      if (ch && !global_migration_cart.some(item => item.id === id)) {
        global_migration_cart.push(ch);
        addedCount++;
      }
    });
    
    if (addedCount > 0) {
      await chrome.storage.local.set({ global_migration_cart });
      showSilentToast(`${addedCount}개 채널이 이전 카트에 담겼습니다.`, 'linear-gradient(135deg, #38B000, #38B000)');
    } else {
      showSilentToast('이미 카트에 존재하거나 잘못된 선택입니다.', 'linear-gradient(135deg, #FFB703, #FB8500)');
    }
    
    selectedChannelIds.clear();
    updateBulkButtonState();
    renderChannels();
  });
}

// Bulk deletion
document.getElementById('bulk-unsub-btn').addEventListener('click', async () => {
  // 1. Static Array Conversion
  const selectedCheckboxes = Array.from(document.querySelectorAll('.card-select:checked'));
  const ids = selectedCheckboxes.map(cb => cb.dataset.id).filter(Boolean);
  if (ids.length === 0) return;

  const confirmed = confirm(`선택하신 ${ids.length}개 채널의 구독 취소를 예약하시겠습니까? 5초간 대기 후 순차 처리됩니다.`);
  if (!confirmed) return;

  // 2. Decouple State Mutation from DOM Manipulation: update memory array first
  ids.forEach(id => {
    try {
      const ch = channelsList.find(c => c.id === id);
      if (ch) {
        ch.status_flag = 'PENDING';
        ch.pending_delete = true;
        ch.pending_delete_time = Date.now();
      }
    } catch (err) {
      console.error(`Error updating memory state for channel ID ${id}:`, err);
    }
  });

  // 3. Trigger database mutations (START_PENDING_DELETE) sequentially with pacing
  try {
    for (const id of ids) {
      try {
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'START_PENDING_DELETE', channelId: id }, (res) => {
            try {
              if (res && res.status === 'completed') {
                const ch = channelsList.find(c => c.id === id);
                if (ch) {
                  showUndoToast(ch);
                }
              } else {
                console.error(`Unsubscribe DB mutation failed for channel ${id}:`, res?.error || 'Unknown response error');
              }
            } catch (callbackErr) {
              console.error(`Error in bulk unsub message callback for channel ${id}:`, callbackErr);
            }
            resolve();
          });
        });
      } catch (loopErr) {
        console.error(`Error sending bulk unsubscribe message for channel ${id}:`, loopErr);
      }
      // Introduce an artificial pacing delay of 150ms between each sequential API call
      await new Promise(resolveDelay => setTimeout(resolveDelay, 150));
    }
  } catch (outerErr) {
    console.error(`Error executing bulk unsubscribe loop:`, outerErr);
  } finally {
    // 4. Single Unified Rerender Trigger
    selectedChannelIds.clear();
    updateBulkButtonState();
    renderChannels();
    
    setTimeout(() => {
      loadDashboardData();
    }, 100);
  }
});

// Category/Filter listeners
document.getElementById('category-filter').addEventListener('change', renderChannels);
document.getElementById('inactivity-filter').addEventListener('change', renderChannels);
document.getElementById('subscriber-filter').addEventListener('change', renderChannels);
document.getElementById('sort-select').addEventListener('change', renderChannels);

// Select-all
document.getElementById('select-all-checkbox').addEventListener('change', (e) => {
  const checkBoxes = document.querySelectorAll('.card-select');
  if (e.target.checked) {
    checkBoxes.forEach(box => {
      box.checked = true;
      selectedChannelIds.add(box.dataset.id);
    });
  } else {
    checkBoxes.forEach(box => {
      box.checked = false;
      selectedChannelIds.delete(box.dataset.id);
    });
  }
  updateBulkButtonState();
});

// Action 1: API Step 1 Sync
document.getElementById('tm-step1-api').addEventListener('click', () => {
  const errorMsg = document.getElementById('sync-error-msg');
  errorMsg.style.color = '#FFB703';
  errorMsg.textContent = '실시간 구독 API 호출 중...';

  chrome.runtime.sendMessage({ action: 'START_STEP_1_SYNC' }, (res) => {
    if (!res) return;
    if (res.status === 'completed') {
      errorMsg.style.color = '#38B000';
      errorMsg.textContent = '1단계 완료! 2단계로 진행해주세요.';
      checkSyncStatus();
    } else {
      errorMsg.style.color = '#E63946';
      errorMsg.textContent = `인증 오류: ${res.error}.`;
    }
  });
});

// Action 1-2: Sample Ingestion Trigger
document.getElementById('tm-step1-sample').addEventListener('click', () => {
  const errorMsg = document.getElementById('sync-error-msg');
  errorMsg.style.color = '#FFB703';
  errorMsg.textContent = '샘플 데이터를 IndexedDB에 생성 중...';

  chrome.runtime.sendMessage({ action: 'START_SAMPLE_SYNC' }, (res) => {
    if (!res) return;
    if (res.status === 'completed') {
      errorMsg.style.color = '#38B000';
      errorMsg.textContent = '1단계 샘플 데이터 확보 완료!';
      checkSyncStatus();
    } else {
      errorMsg.style.color = '#E63946';
      errorMsg.textContent = `샘플 생성 실패: ${res.error}`;
    }
  });
});

// Action 3: Step 2 Sync Trigger
document.getElementById('tm-step2-start').addEventListener('click', async () => {
  document.getElementById('tm-step2-start').style.display = 'none';
  document.getElementById('step2-progress-area').style.display = 'block';

  chrome.runtime.sendMessage({ action: 'START_STEP_2_SYNC' }, (res) => {
    if (res && res.status === 'completed') {
      checkSyncStatus();
    }
  });
});

// Action 4: Step 3 RSS Sync Trigger (runs in dashboard tab — DOMParser available)
document.getElementById('tm-step3-start').addEventListener('click', async () => {
  const startBtn = document.getElementById('tm-step3-start');
  if (startBtn) startBtn.style.display = 'none';
  const step3ProgressArea = document.getElementById('step3-progress-area');
  const step3Bar = document.getElementById('step3-progress-bar');
  const step3Status = document.getElementById('step3-status');
  if (step3ProgressArea) step3ProgressArea.style.display = 'block';

  try {
    const currentState = await resolveActiveOwnerId();
    await syncLatestVideosRSS(currentState.activeOwnerId, (done, total) => {
      if (step3Bar) step3Bar.style.width = `${Math.round(done / total * 100)}%`;
      if (step3Status) step3Status.textContent = `RSS 수집 중: ${done}/${total} 채널`;
    });
    checkSyncStatus();
  } catch (err) {
    console.error('[RSS] Step 3 manual trigger failed:', err);
    const errorMsg = document.getElementById('sync-error-msg');
    if (errorMsg) {
      errorMsg.style.color = '#E63946';
      errorMsg.textContent = 'RSS 수집 실패: ' + (err.message || '알 수 없는 오류');
    }
  }
});

// Pause Action
const pauseBtns = document.querySelectorAll('.tm-pause-btn');
pauseBtns.forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    chrome.runtime.sendMessage({ action: 'PAUSE_SYNC' }, (res) => {
      checkSyncStatus();
    });
  });
});

// Reset pipeline
async function resetPipeline() {
  if (confirm('모든 데이터가 삭제되고 파이프라인이 전면 초기화됩니다. 계속하시겠습니까?')) {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        await chrome.storage.local.clear();
      } catch (e) {
        console.warn("Storage clear context failure:", e);
      }
    }
    
    // Clear IndexedDB stores physically
    try {
      const db = await openDB();
      const tx = db.transaction(['youtube_subscriptions', 'channels_master', 'video_preview_cache'], 'readwrite');
      tx.objectStore('youtube_subscriptions').clear();
      tx.objectStore('channels_master').clear();
      tx.objectStore('video_preview_cache').clear();
      await new Promise((resolve, reject) => {
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      });
      console.log("IndexedDB stores cleared successfully.");
    } catch (err) {
      console.error("Failed to clear IndexedDB stores:", err);
    }

    // Revoke auth token and reload
    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      chrome.runtime.sendMessage({ action: 'REVOKE_AUTH_TOKEN' }, () => {
        location.reload();
      });
    } else {
      location.reload();
    }
  }
}

const resetViewBtn = document.getElementById('tm-reset-pipeline-view');
if (resetViewBtn) {
  resetViewBtn.addEventListener('click', resetPipeline);
}
const resetSidebarBtn = document.getElementById('tm-reset-pipeline-sidebar');
if (resetSidebarBtn) {
  resetSidebarBtn.addEventListener('click', resetPipeline);
}

// Sync More button
const dashboardSyncMoreBtn = document.getElementById('dashboard-sync-more-btn');
if (dashboardSyncMoreBtn) {
  dashboardSyncMoreBtn.addEventListener('click', async () => {
    dashboardSyncMoreBtn.disabled = true;
    dashboardSyncMoreBtn.textContent = '수집 중...';
    try {
      const currentState = await resolveActiveOwnerId();
      await syncLatestVideosRSS(currentState.activeOwnerId);
    } catch (err) {
      console.warn('[RSS] Sync more failed:', err);
    }
    location.reload();
  });
}

// Sliding Sidebar Collapse
const sidebarToggleBtn = document.getElementById('sidebar-toggle-btn');
const sidebar = document.getElementById('sidebar');
if (sidebarToggleBtn && sidebar) {
  sidebarToggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
  });
}

// On-Demand Partitioning: Button A & B Action listeners
const btnRefreshSubs = document.getElementById('btn-refresh-subs');
if (btnRefreshSubs) {
  btnRefreshSubs.addEventListener('click', () => {
    btnRefreshSubs.disabled = true;
    const oldText = btnRefreshSubs.textContent;
    btnRefreshSubs.textContent = '구독 목록 동기화 중...';
    chrome.runtime.sendMessage({ action: 'REFRESH_SUBSCRIPTION_LIST' }, (res) => {
      btnRefreshSubs.disabled = false;
      btnRefreshSubs.textContent = oldText;
      if (res && res.status === 'completed') {
        showSilentToast('구독 목록 동기화 완료!', 'linear-gradient(135deg, #38B000, #38B000)');
        reconcileMigrationCart().then(() => {
          loadDashboardData();
        });
      } else {
        showSilentToast('구독 목록 동기화 실패: ' + (res?.error || '알 수 없는 오류'), 'linear-gradient(135deg, #e63946, #e63946)');
      }
    });
  });
}

// ============================================================
// [#btn-full-resync] — Full-channel force resync via RESET_INGESTION_QUEUE
// Supersedes the removed #btn-refresh-videos / REFRESH_VIDEOS_BATCH flow.
// ============================================================
const btnFullResync = document.getElementById('btn-full-resync');
if (btnFullResync) {
  btnFullResync.addEventListener('click', async () => {
    const confirmed = confirm('모든 구독 채널의 분석 데이터를 초기화하고 전체 재분석합니다. (기존 last_uploaded_at 유지) 계속하시겠습니까?');
    if (!confirmed) return;
    btnFullResync.disabled = true;
    btnFullResync.textContent = '대기열 등록 중...';
    chrome.runtime.sendMessage({ action: 'RESET_INGESTION_QUEUE' }, (res) => {
      if (chrome.runtime.lastError || !res) {
        btnFullResync.disabled = false;
        btnFullResync.textContent = '[전체 채널 고속 동기화]';
        showSilentToast('연결 실패 — 다시 시도해 주세요.', 'linear-gradient(135deg, #e63946, #e63946)');
        return;
      }
      if (res.status === 'queued') {
        btnFullResync.textContent = `분석 중... (${res.total}개 대기)`;
        const ingestionStatus = document.getElementById('ingestion-progress-status');
        if (ingestionStatus) {
          ingestionStatus.textContent = `전체 채널 재분석 시작됨 (${res.total}개 대기). 탭을 닫아도 안전합니다.`;
          const area = document.getElementById('ingestion-progress-area');
          if (area) area.style.display = 'block';
        }
        showSilentToast(`${res.total}개 채널 재분석 대기열 등록 완료`, 'linear-gradient(135deg, #4cc9f0, #7209b7)');
      } else {
        btnFullResync.disabled = false;
        btnFullResync.textContent = '[전체 채널 고속 동기화]';
        showSilentToast('오류: ' + (res.error || '알 수 없는 오류'), 'linear-gradient(135deg, #e63946, #e63946)');
      }
    });
  });
}

// Sub-Tab Switch Wiring
const activeTabBtn = document.getElementById('tab-active-subs');
const historyTabBtn = document.getElementById('tab-history-subs');
const migrationTabBtn = document.getElementById('tab-migration-subs');

function clearActiveTabStyles() {
  [activeTabBtn, historyTabBtn, migrationTabBtn].forEach(btn => {
    if (btn) {
      btn.classList.remove('active');
      btn.style.color = 'rgba(255,255,255,0.5)';
      btn.style.borderBottom = 'none';
    }
  });
}

function setActiveTabStyle(btn) {
  if (btn) {
    btn.classList.add('active');
    btn.style.color = 'white';
    btn.style.borderBottom = '2px solid #e63946';
  }
}

if (activeTabBtn && historyTabBtn && migrationTabBtn) {
  activeTabBtn.addEventListener('click', () => {
    currentTab = 'active';
    clearActiveTabStyles();
    setActiveTabStyle(activeTabBtn);
    
    document.getElementById('bulk-unsub-btn').style.display = 'block';
    document.getElementById('bulk-migrate-btn').style.display = 'block';
    document.querySelector('.select-all-wrapper').style.display = 'flex';
    const migPanel = document.getElementById('migration-execution-panel');
    if (migPanel) migPanel.style.display = 'none';
    
    loadDashboardData();
  });

  historyTabBtn.addEventListener('click', () => {
    currentTab = 'history';
    clearActiveTabStyles();
    setActiveTabStyle(historyTabBtn);
    
    document.getElementById('bulk-unsub-btn').style.display = 'none';
    document.getElementById('bulk-migrate-btn').style.display = 'none';
    document.querySelector('.select-all-wrapper').style.display = 'none';
    const migPanel = document.getElementById('migration-execution-panel');
    if (migPanel) migPanel.style.display = 'none';
    
    loadDashboardData();
  });

  migrationTabBtn.addEventListener('click', () => {
    currentTab = 'migration';
    clearActiveTabStyles();
    setActiveTabStyle(migrationTabBtn);
    
    document.getElementById('bulk-unsub-btn').style.display = 'none';
    document.getElementById('bulk-migrate-btn').style.display = 'none';
    document.querySelector('.select-all-wrapper').style.display = 'none';
    const migPanel = document.getElementById('migration-execution-panel');
    if (migPanel) migPanel.style.display = 'flex';
    
    loadDashboardData();
  });
}

// Message Listeners
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'DELETION_FINALIZED') {
    const found = channelsList.find(c => c.id === message.channelId);
    if (found) {
      found.status_flag = message.status || 'UNSUBSCRIBED';
      found.pending_delete = false;
      if (found.status_flag === 'SUBSCRIBED') {
        delete found.pending_delete_time;
      }
    }
    renderChannels();
    loadDashboardData();
  }
  
  if (message.type === 'SYNC_PROGRESS') {
    if (manualSyncBtn) {
      manualSyncBtn.textContent = `동기화 중... (${message.current}/${message.total})`;
    }
    const titleSubtitle = document.querySelector('.section-subtitle');
    if (titleSubtitle) {
      titleSubtitle.innerHTML = `실시간 동기화 상태: <strong>${message.stage || '분석 중'} (${message.current} / ${message.total} 완료)</strong>`;
    }
  }
  
  if (message.type === 'SYNC_COMPLETED' || message.action === 'SILENT_SYNC_COMPLETED') {
    if (manualSyncBtn) {
      manualSyncBtn.disabled = false;
      manualSyncBtn.textContent = '최신 정보로 지금 업데이트';
    }
    const titleSubtitle = document.querySelector('.section-subtitle');
    if (titleSubtitle) {
      titleSubtitle.textContent = '선택된 필터에 따라 유령 의심 채널을 판별하고 정렬합니다.';
    }
    showSilentToast('동기화가 완료되었습니다. 화면 데이터를 갱신합니다.', 'linear-gradient(135deg, #38B000, #38B000)');
    reconcileMigrationCart().then(() => {
      loadDashboardData();
    });
  }
  
  if (message.type === 'SYNC_ERROR' || message.action === 'SILENT_SYNC_FAILED') {
    if (manualSyncBtn) {
      manualSyncBtn.disabled = false;
      manualSyncBtn.textContent = '최신 정보로 지금 업데이트';
    }
    const titleSubtitle = document.querySelector('.section-subtitle');
    if (titleSubtitle) {
      titleSubtitle.textContent = '동기화가 도중에 실패하였습니다.';
    }
    showSilentToast(`동기화 중단: 쿼터 초과 또는 네트워크 오류 (${message.error || '네트워크 장애'})`, 'linear-gradient(135deg, #e63946, #e63946)');
  }

  // Migration queue live updates (async state machine broadcasts)
  if (message.type === 'MIGRATION_QUEUE_UPDATE') {
    const queue        = message.queue || [];
    const pendingCount = queue.filter(q => q.status === 'pending').length;
    const successCount = queue.filter(q => q.status === 'success').length;
    const failedCount  = queue.filter(q => q.status === 'failed').length;
    const skippedCount = queue.filter(q => q.status === 'skipped').length;
    const total        = queue.length;
    const done         = total - pendingCount;

    const migrationStatus = document.getElementById('migration-run-status');
    if (migrationStatus) {
      if (pendingCount > 0) {
        migrationStatus.textContent = `이전 실행 중: ${done}/${total} — 현재: ${message.currentTitle || ''} | 완료: ${successCount} 스킵: ${skippedCount} 실패: ${failedCount}`;
      } else {
        migrationStatus.textContent = `이전 완료: 구독 ${successCount}개 / 스킵 ${skippedCount}개 / 실패 ${failedCount}개`;
      }
    }

    const btnRun = document.getElementById('btn-run-migration');
    if (btnRun) {
      if (pendingCount > 0) {
        btnRun.textContent = `이전 실행 중... (${done}/${total})`;
        btnRun.disabled = true;
      } else {
        btnRun.textContent = '[구독 이전 실행]';
        btnRun.disabled = false;
        if (successCount > 0) {
          showSilentToast(`${successCount}개 채널 구독 완료!`, 'linear-gradient(135deg, #38B000, #38B000)');
          reconcileMigrationCart().then(() => loadDashboardData());
        }
      }
    }
  }

  // ── Ingestion queue live updates ───────────────────────────────────────────────────
  if (message.type === 'INGESTION_QUEUE_UPDATE') {
    const queue        = message.queue || [];
    const pendingCount = message.pending ?? queue.filter(q => q.status === 'pending').length;
    const successCount = message.successCount ?? queue.filter(q => q.status === 'success').length;
    const failedCount  = message.failedCount  ?? queue.filter(q => q.status === 'failed').length;
    const total        = message.total  ?? queue.length;
    const done         = message.done   ?? (total - pendingCount);

    // Update progress strip
    const area   = document.getElementById('ingestion-progress-area');
    const status = document.getElementById('ingestion-progress-status');
    const fill   = document.getElementById('ingestion-progress-bar-fill');

    if (area && pendingCount > 0) {
      area.style.display = 'block';
    } else if (area && pendingCount === 0) {
      // Hide strip after 3 seconds on completion
      setTimeout(() => { area.style.display = 'none'; }, 3000);
    }
    if (status) {
      status.textContent = pendingCount > 0
        ? `백그라운드 분석 중: ${done}/${total} — ${message.currentTitle || ''}  (성공 ${successCount} / 실패 ${failedCount})`
        : `분석 완료: 성공 ${successCount}개 / 실패 ${failedCount}개 / 전체 ${total}개`;
    }
    if (fill && total > 0) {
      fill.style.width = `${Math.round(done / total * 100)}%`;
    }

    // Rebuild _ingestionQueueMap with the freshest queue snapshot
    if (queue.length > 0) {
      window._ingestionQueueMap = new Map(queue.map(q => [q.id, q.status]));
      renderChannels();  // re-render cards to flip skeletons to real data
    }

    // On completion: full data reload to pick up updated last_uploaded_at
    if (pendingCount === 0 && total > 0) {
      // reset btn-full-resync
      const btnFR = document.getElementById('btn-full-resync');
      if (btnFR) { btnFR.textContent = '[전체 채널 고속 동기화]'; btnFR.disabled = false; }
      loadDashboardData();
    }
  }

  // Migration quota exceeded — show modal
  if (message.type === 'MIGRATION_QUOTA_EXCEEDED') {
    showMigrationQuotaModal();
    const btnRun = document.getElementById('btn-run-migration');
    if (btnRun) { btnRun.textContent = '할당량 초과 — 내일 재시도'; btnRun.disabled = false; }
  }
});

// Onboarding 3-step sync wrappers
function runStep1Onboarding(ownerId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'START_STEP_1_SYNC', ownerId }, (res) => {
      if (res && res.status === 'completed') resolve(res);
      else reject(new Error(res?.error || '1단계 동기화 실패'));
    });
  });
}
function runStep2Onboarding(ownerId) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action: 'START_STEP_2_SYNC', ownerId }, (res) => {
      if (res && res.status === 'completed') resolve(res);
      else reject(new Error(res?.error || '2단계 동기화 실패'));
    });
  });
}
// [runStep3RssOnboarding removed] — Stage 3 now fires START_INGESTION_QUEUE to background

// Atomic Dropdown Renderer & Default Guard
async function renderProfileDropdown() {
  const select = document.getElementById('select-active-profile');
  if (!select) return;
  
  const data = await chrome.storage.local.get(['account_registry']);
  const registry = data.account_registry || [];
  
  select.innerHTML = '';
  
  registry.forEach(item => {
    const option = document.createElement('option');
    option.value = item.channelId;
    option.textContent = `${item.email} / ${item.channelTitle}`;
    select.appendChild(option);
  });
  
  // Programmatically append the mandatory final hardcoded option link at the absolute bottom
  const addOption = document.createElement('option');
  addOption.value = 'add_new';
  addOption.textContent = '새로운 계정 또는 채널 추가';
  select.appendChild(addOption);
  
  // Complete Active State Selection Match
  if (state.activeOwnerId && [...select.options].some(o => o.value === state.activeOwnerId)) {
    select.value = state.activeOwnerId;
  } else if (select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

// Smart Calendar-Day Sync Evaluation
async function checkStaleSync() {
  const btnA = document.getElementById('btn-refresh-subs');
  if (!btnA) return;
  const data = await chrome.storage.local.get(['account_registry']);
  const registry = data.account_registry || [];
  const currentAccount = registry.find(a => a.channelId === state.activeOwnerId);
  if (currentAccount && currentAccount.lastSyncTimestamp) {
    const isStale = new Date(currentAccount.lastSyncTimestamp).toDateString() !== new Date().toDateString();
    if (isStale) {
      btnA.classList.add('refresh-suggested');
    } else {
      btnA.classList.remove('refresh-suggested');
    }
  } else {
    btnA.classList.remove('refresh-suggested');
  }
}

// Migration Quota exceeded modal
function showMigrationQuotaModal() {
  let existing = document.getElementById('migration-quota-modal');
  if (existing) return;
  const overlay = document.createElement('div');
  overlay.id = 'migration-quota-modal';
  overlay.style.cssText = [
    'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999',
    'background:rgba(10,10,12,0.85)',
    'backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px)',
    'display:flex;align-items:center;justify-content:center'
  ].join(';');
  overlay.innerHTML = `
    <div style="background:rgba(20,20,24,0.95);border:1px solid rgba(255,183,3,0.3);border-radius:24px;padding:40px 36px;max-width:440px;text-align:center;box-shadow:0 30px 60px rgba(0,0,0,0.6);">
      <div style="font-size:44px;margin-bottom:16px;">&#x26A0;&#xFE0F;</div>
      <h3 style="font-size:18px;font-weight:800;color:#FFB703;margin-bottom:12px;">일일 API 할당량 초과</h3>
      <p style="font-size:13px;color:rgba(255,255,255,0.75);line-height:1.7;margin-bottom:24px;">구독 이전 실행 중 Google API 일일 할당량 한계에 도달했습니다.<br>진행이 안전하게 중단되었으며, 성공한 구독은 유지됩니다.<br><br><strong style="color:#FFB703;">내일 오후 4시 (KST) 이후 재시도해 주세요.</strong></p>
      <button id="migration-quota-close" style="background:linear-gradient(135deg,#FFB703,#FB8500);border:none;border-radius:10px;color:white;padding:12px 32px;font-size:14px;font-weight:700;cursor:pointer;">확인</button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('migration-quota-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
}

// Wire change event listener to #select-active-profile dropdown switcher
const selectActiveProfile = document.getElementById('select-active-profile');
if (selectActiveProfile) {
  selectActiveProfile.addEventListener('change', async (e) => {
    const val = e.target.value;
    if (val === 'add_new') {
      chrome.runtime.sendMessage({ action: 'TRIGGER_NEW_AUTH' }, (res) => {
        if (res && res.status === 'completed') {
          window.location.reload();
        } else {
          alert('인증 실패: ' + (res?.error || '알 수 없는 오류'));
          renderProfileDropdown();
        }
      });
    } else {
      // SWITCH_ACTIVE_ACCOUNT — zero-popup account switch via L2 token cache
      const data = await chrome.storage.local.get(['account_registry']);
      const registry = data.account_registry || [];
      const account = registry.find(a => a.channelId === val);
      if (account) {
        state.activeOwnerId = account.channelId;
        state.activeUserEmail = account.email || '';
        state.activeChannelTitle = account.channelTitle || '';

        const res = await new Promise(resolve => {
          chrome.runtime.sendMessage({
            action: 'SWITCH_ACTIVE_ACCOUNT',
            channelId: account.channelId,
            email: account.email || '',
            channelTitle: account.channelTitle || ''
          }, resolve);
        });

        if (statusIntervalId) {
          clearInterval(statusIntervalId);
          statusIntervalId = null;
        }

        const onboardingOverlay = document.getElementById('onboarding-overlay');
        if (onboardingOverlay) onboardingOverlay.style.display = 'none';

        if (res && res.status === 'cached') {
          // L2 token hit — instant account switch with no Google popup
          await loadDashboardData();
        } else {
          // L2 miss — trigger fresh OAuth flow
          chrome.runtime.sendMessage({ action: 'TRIGGER_NEW_AUTH' }, (authRes) => {
            if (authRes && authRes.status === 'completed') {
              window.location.reload();
            } else {
              alert('인증 실패: ' + (authRes?.error || '알 수 없는 오류'));
              renderProfileDropdown();
            }
          });
        }
      }
    }
  });
}

// ============================================================
// [Migration Cart: btn-run-migration] — Fire-and-forget queue enqueue
// The new async state machine returns {status:'queued'} immediately.
// Progress arrives via MIGRATION_QUEUE_UPDATE broadcast messages.
// The dashboard tab can be safely closed mid-migration.
// ============================================================
const btnRunMigration = document.getElementById('btn-run-migration');
if (btnRunMigration) {
  btnRunMigration.addEventListener('click', async () => {
    const { global_migration_cart = [] } = await chrome.storage.local.get(['global_migration_cart']);
    if (global_migration_cart.length === 0) {
      showSilentToast('이전 카트가 비어 있습니다.', 'linear-gradient(135deg, #FFB703, #FB8500)');
      return;
    }
    const confirmed = confirm(`카트의 ${global_migration_cart.length}개 채널을 순차적으로 구독합니다. (1.5초 간격) 탭을 닫아도 백그라운드에서 계속 실행됩니다. 계속하시겠습니까?`);
    if (!confirmed) return;

    btnRunMigration.disabled = true;
    btnRunMigration.textContent = '이전 대기열 등록 중...';
    const migrationStatus = document.getElementById('migration-run-status');

    // Fire-and-forget: background returns immediately after enqueuing
    chrome.runtime.sendMessage(
      { action: 'EXECUTE_MIGRATION_CART', ownerId: state.activeOwnerId },
      (res) => {
        if (chrome.runtime.lastError) {
          btnRunMigration.disabled = false;
          btnRunMigration.textContent = '[구독 이전 실행]';
          showSilentToast('백그라운드 연결 실패 — 다시 시도해 주세요.', 'linear-gradient(135deg, #e63946, #e63946)');
          return;
        }
        if (!res) {
          btnRunMigration.disabled = false;
          btnRunMigration.textContent = '[구독 이전 실행]';
          showSilentToast('응답 없음 — 확장 프로그램을 재시작해 주세요.', 'linear-gradient(135deg, #e63946, #e63946)');
          return;
        }
        if (res.status === 'queued') {
          // Update button to reflect in-progress state; completion is pushed via MIGRATION_QUEUE_UPDATE
          btnRunMigration.textContent = `이전 실행 중... (0/${res.total})`;
          if (migrationStatus) {
            migrationStatus.textContent = `이전 작업이 백그라운드에서 시작되었습니다 (${res.total}개 대기). 탭을 닫아도 안전합니다.`;
          }
        } else {
          btnRunMigration.disabled = false;
          btnRunMigration.textContent = '[구독 이전 실행]';
          showSilentToast('오류 발생: ' + (res.error || '알 수 없는 오류'), 'linear-gradient(135deg, #e63946, #e63946)');
        }
      }
    );
  });
}

// Real-Time Storage Propagation Observer
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (changes.account_registry) {
    renderProfileDropdown();
  }
});

// Onboarding trigger pipeline orchestration
const btnStartOnboarding = document.getElementById('btn-start-onboarding');
if (btnStartOnboarding) {
  btnStartOnboarding.addEventListener('click', async () => {
    btnStartOnboarding.disabled = true;
    try {
      const currentResolved = await resolveActiveOwnerId();
      const sessionOwnerId = currentResolved.activeOwnerId;

      btnStartOnboarding.textContent = "1단계: 구독 목록 수집 중...";
      const step1Res = await runStep1Onboarding(sessionOwnerId);
      const subCount = step1Res?.total || 0;
      
      if (subCount === 0) {
        btnStartOnboarding.disabled = false;
        btnStartOnboarding.textContent = "[초기 분석 파이프라인 시작]";
        alert("구독 채널 수집 결과가 0개입니다. 구글 로그인(OAuth) 과정에서 'YouTube 구독 항목 조회' 권한을 체크하셨는지 확인해 주시고, 할당량 소소 여부 및 현재 채널의 구독 목록이 비어있는지 확인 후 다시 시도해 주세요.");
        return;
      }
      
      btnStartOnboarding.textContent = "2단계: 채널 프로필 매핑 중...";
      await runStep2Onboarding(sessionOwnerId);
      
      btnStartOnboarding.textContent = "3단계: 백그라운드 분석 대기열 등록 중...";

      // Stage 3: Fire-and-forget ingestion queue.
      // background.js populates ingestion_queue from channels_master and starts
      // processIngestionQueue() immediately. Returns {status:'queued'} in ~100ms
      // so the onboarding overlay can unblock without blocking the user.
      await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { action: 'START_INGESTION_QUEUE', ownerId: sessionOwnerId },
          (res) => {
            if (chrome.runtime.lastError || !res) {
              console.warn('[Onboarding] START_INGESTION_QUEUE: no response, proceeding anyway.');
              resolve();
              return;
            }
            const total = res.total || 0;
            btnStartOnboarding.textContent = total > 0
              ? `3단계: ${total}개 채널 백그라운드 분석 시작됨 — 탭을 닫아도 계속 실행됩니다.`
              : "3단계: 분석 대상 채널 없음 (이미 모두 분석 완료)";
            // Show ingestion progress strip
            const ingestionArea = document.getElementById('ingestion-progress-area');
            if (ingestionArea && total > 0) {
              ingestionArea.style.display = 'block';
              const s = document.getElementById('ingestion-progress-status');
              if (s) s.textContent = `백그라운드 분석 시작 (${total}개 채널 대기)...`;
            }
            resolve();
          }
        );
      });
      
      // Load clean layout and reload dashboard data
      await loadDashboardData();
    } catch (err) {
      btnStartOnboarding.disabled = false;
      const errMsg = err.message || '';
      if (errMsg.includes('403') || errMsg.toLowerCase().includes('quota')) {
        btnStartOnboarding.textContent = "일일 할당량 소모 완료 (오후 4시 리셋)";
      } else {
        btnStartOnboarding.textContent = "[초기 분석 파이프라인 시작]";
      }
      alert("동기화 실패: " + err.message);
    }
  });
}

// Session Reset Button action
const btnSessionReset = document.getElementById('btn-session-reset');
if (btnSessionReset) {
  btnSessionReset.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'RESET_SESSION' }, () => {
      window.location.reload();
    });
  });
}


// ============================================================
// [Track C — Snapshot Ledger] Export & Import handlers
// Export: Blob + <a download> — no chrome.downloads permission required.
// Import: FileReader + confirm dialog + IDB clear + restore.
// Both operations preserve all existing CSS classes and Korean UI text.
// ============================================================

// ── Export handler ────────────────────────────────────────────
const btnLedgerExport = document.getElementById('btn-ledger-export');
if (btnLedgerExport) {
  btnLedgerExport.addEventListener('click', async () => {
    try {
      btnLedgerExport.disabled = true;
      btnLedgerExport.textContent = '백업 중...';

      // 1. Read channels_master from IDB
      const channelsMasterData = await new Promise((resolve) => {
        openDB(state.activeOwnerId).then(db => {
          const tx    = db.transaction(['channels_master'], 'readonly');
          const store = tx.objectStore('channels_master');
          const req   = store.getAll();
          req.onsuccess = () => { db.close(); resolve(req.result || []); };
          req.onerror   = () => { db.close(); resolve([]); };
        }).catch(() => resolve([]));
      });

      // 2. Read global_migration_cart from chrome.storage
      const { global_migration_cart = [] } = await chrome.storage.local.get(['global_migration_cart']);

      // 3. Assemble snapshot
      const snapshot = {
        schema_version: 1,
        exported_at: new Date().toISOString(),
        owner_id: state.activeOwnerId || '',
        channels_master: channelsMasterData,
        global_migration_cart
      };

      // 4. Serialize + download
      const json = JSON.stringify(snapshot, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `tubemanager_snapshot_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);

      showSilentToast(`백업 완료 (${channelsMasterData.length}개 채널)`, 'linear-gradient(135deg, #38B000, #38B000)');
    } catch (err) {
      console.error('[Ledger Export] Failed:', err);
      showSilentToast('백업 실패: ' + err.message, 'linear-gradient(135deg, #e63946, #e63946)');
    } finally {
      btnLedgerExport.disabled = false;
      btnLedgerExport.textContent = '[데이터 백업 (.json)]';
    }
  });
}

// ── Import handler ────────────────────────────────────────────
const btnLedgerImport = document.getElementById('btn-ledger-import');
const ledgerImportInput = document.getElementById('ledger-import-input');

if (btnLedgerImport && ledgerImportInput) {
  btnLedgerImport.addEventListener('click', () => {
    ledgerImportInput.value = ''; // reset so same file can be re-selected
    ledgerImportInput.click();
  });

  ledgerImportInput.addEventListener('change', () => {
    const file = ledgerImportInput.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const raw = e.target.result;
        let snapshot;
        try {
          snapshot = JSON.parse(raw);
        } catch (parseErr) {
          showSilentToast('JSON 파싱 실패 — 올바른 백업 파일인지 확인해 주세요.', 'linear-gradient(135deg, #e63946, #e63946)');
          return;
        }

        // Validate schema
        if (snapshot.schema_version !== 1 || !Array.isArray(snapshot.channels_master)) {
          showSilentToast('올바르지 않은 백업 형식입니다.', 'linear-gradient(135deg, #e63946, #e63946)');
          return;
        }

        const confirmed = confirm(
          `이 작업은 현재 DB의 모든 데이터(${snapshot.channels_master.length}개 채널)를 ` +
          `백업 파일(${new Date(snapshot.exported_at).toLocaleString()})으로 \n` +
          `\ub36e어쓀니다. 계속하시겠습니까?`
        );
        if (!confirmed) return;

        btnLedgerImport.disabled = true;
        btnLedgerImport.textContent = '복구 중...';

        // Clear + restore channels_master
        await new Promise((resolve, reject) => {
          openDB(state.activeOwnerId).then(db => {
            const tx    = db.transaction(['channels_master'], 'readwrite');
            const store = tx.objectStore('channels_master');
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror    = () => { db.close(); reject(tx.error); };
            tx.onabort    = () => { db.close(); reject(new Error('tx aborted')); };
            const clearReq = store.clear();
            clearReq.onsuccess = () => {
              for (const item of snapshot.channels_master) {
                try { store.put(item); } catch (_) {}
              }
            };
          }).catch(reject);
        });

        // Restore global_migration_cart
        await chrome.storage.local.set({
          global_migration_cart: snapshot.global_migration_cart || []
        });

        showSilentToast(`복구 완료 (${snapshot.channels_master.length}개 채널 복원)`, 'linear-gradient(135deg, #38B000, #38B000)');
        await loadDashboardData();
      } catch (err) {
        console.error('[Ledger Import] Failed:', err);
        showSilentToast('복구 실패: ' + err.message, 'linear-gradient(135deg, #e63946, #e63946)');
      } finally {
        btnLedgerImport.disabled = false;
        btnLedgerImport.textContent = '[데이터 복구]';
      }
    };
    reader.onerror = () => {
      showSilentToast('파일 읽기 실패 — 다시 시도해 주세요.', 'linear-gradient(135deg, #e63946, #e63946)');
    };
    reader.readAsText(file);
  });
}

// Block dashboard initialization via an await lock until state.activeOwnerId resolves
async function initDashboard() {
  await resolveActiveOwnerId();
  await renderProfileDropdown();
  checkSyncStatus();
  statusIntervalId = setInterval(checkSyncStatus, 1000);

  // ── Queue status resume: restore migration UI state if a queue is already running ──
  // Covers the case where the user reopens the dashboard tab mid-migration.
  try {
    const { migration_queue = [] } = await chrome.storage.local.get(['migration_queue']);
    const pendingCount = migration_queue.filter(q => q.status === 'pending').length;
    if (pendingCount > 0) {
      const successCount = migration_queue.filter(q => q.status === 'success').length;
      const total        = migration_queue.length;
      const done         = total - pendingCount;

      const migrationStatus = document.getElementById('migration-run-status');
      if (migrationStatus) {
        migrationStatus.textContent = `이전 작업 백그라운드 진행 중: ${done}/${total} 완료, ${pendingCount}개 대기 중...`;
      }
      const btnRun = document.getElementById('btn-run-migration');
      if (btnRun) {
        btnRun.textContent = `이전 실행 중... (${done}/${total})`;
        btnRun.disabled = true;
      }

      // Kick the background worker in case it missed the alarm
      chrome.runtime.sendMessage({ action: 'START_QUEUE_PROCESS' }, () => {
        if (chrome.runtime.lastError) {} // SW may already be processing
      });
    }
  } catch (_) {}

  // \u2500\u2500 Ingestion queue resume: restore progress strip if ingestion still running \u2500\u2500
  try {
    const { ingestion_queue = [] } = await chrome.storage.local.get(['ingestion_queue']);
    const pendingCount = ingestion_queue.filter(q => q.status === 'pending' || q.status === 'processing').length;
    if (pendingCount > 0) {
      const total = ingestion_queue.length;
      const done  = total - pendingCount;
      const area  = document.getElementById('ingestion-progress-area');
      const statusEl = document.getElementById('ingestion-progress-status');
      const fill  = document.getElementById('ingestion-progress-bar-fill');
      if (area)     area.style.display = 'block';
      if (statusEl) statusEl.textContent = `백그라운드 분석 진행 중: ${done}/${total} 완료, ${pendingCount}개 대기...`;
      if (fill && total > 0) fill.style.width = `${Math.round(done / total * 100)}%`;
      const btnFR = document.getElementById('btn-full-resync');
      if (btnFR) { btnFR.textContent = `분석 중... (${done}/${total})`; btnFR.disabled = true; }

      // Kick SW in case alarm was missed
      chrome.runtime.sendMessage({ action: 'START_INGESTION_QUEUE', ownerId: state.activeOwnerId }, () => {
        if (chrome.runtime.lastError) {} // SW may already be processing
      });
    }
  } catch (_) {}
}
initDashboard();
