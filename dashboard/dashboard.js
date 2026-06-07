// Tube Manager Dashboard Logic

const DB_NAME = 'TubeManagerDB';
const DB_VERSION = 4;

// IndexedDB Helper
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
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
let currentTab = 'active'; // 'active' or 'history'
let statusIntervalId = null;

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
  } else {
    filtered = channelsList.filter(c => c.status_flag === 'UNSUBSCRIBED');
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
      if (e.target.classList.contains('card-select') || e.target.type === 'checkbox' || e.target.classList.contains('resubscribe-btn')) {
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
    } else {
      actionAreaHtml = `<button class="resubscribe-btn secondary-btn" style="padding: 4px 8px; font-size: 10px; font-weight: 700; border-radius: 6px; cursor: pointer;" onclick="window.open('https://www.youtube.com/channel/${ch.id}', '_blank')">유튜브에서 다시 구독하기</button>`;
    }

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
        <div>구독한 지 <strong>${subscribedDays.toLocaleString()}일째</strong></div>
        <div>마지막 업로드 : <strong>${getLastUploadDateStr(ch)}</strong></div>
        <div>${subStr} • 비디오 ${videoVal.toLocaleString()}개</div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
          <span style="font-size: 9px; color: rgba(248,249,250,0.45);">좀비지수: ${getZombieIndex(ch).toFixed(1)}</span>
          <span class="badge ${affinity.class}" style="padding: 2px 6px; font-size: 9px;">${affinity.label}</span>
        </div>
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
function openChannelModal(ch) {
  const modal = document.getElementById('channel-modal');
  
  const banner = document.getElementById('modal-banner');
  if (ch.banner) {
    banner.style.backgroundImage = `url('${ch.banner}')`;
  } else {
    banner.style.backgroundImage = `linear-gradient(135deg, rgba(230, 57, 70, 0.2), rgba(214, 34, 70, 0.1))`;
  }

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
  
  const channelVids = videosList.filter(v => v.target_channel_id === ch.id).slice(0, 3);
  if (channelVids.length > 0) {
    channelVids.forEach(v => {
      const item = document.createElement('div');
      item.className = 'modal-video-item';
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
      const dateStr = new Date(v.uploaded_at).toISOString().split('T')[0];
      
      item.innerHTML = `
        <div class="video-thumb-container" style="width: 100px; aspect-ratio: 16/9; border-radius: 6px; overflow: hidden; flex-shrink: 0; background: #000;">
          <img src="${thumbUrl}" style="width: 100%; height: 100%; object-fit: cover;" alt="${v.title}">
        </div>
        <div class="video-info-container" style="display: flex; flex-direction: column; justify-content: center; min-width: 0; flex: 1;">
          <div class="video-title" style="font-size: 12px; font-weight: 700; color: white; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; line-height: 1.3; margin-bottom: 4px;" title="${v.title}">
            ${v.title}
          </div>
          <div class="video-date" style="font-size: 10px; color: rgba(255,255,255,0.4);">
            업로드: ${dateStr}
          </div>
        </div>
      `;
      previewList.appendChild(item);
    });
  } else {
    previewList.innerHTML = '<div style="font-size: 12px; color: rgba(255,255,255,0.4); text-align: center; padding: 12px;">최근 업로드 영상 정보가 없습니다.</div>';
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
  bulkBtn.disabled = selectedChannelIds.size === 0;
  bulkBtn.textContent = `선택 채널 구독 취소 (${selectedChannelIds.size}개)`;
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

// Action 4: Step 3 Sync Trigger
document.getElementById('tm-step3-start').addEventListener('click', async () => {
  document.getElementById('tm-step3-start').style.display = 'none';
  document.getElementById('step3-progress-area').style.display = 'block';

  chrome.runtime.sendMessage({ action: 'START_STEP_3_SYNC' }, (res) => {
    if (res && res.status === 'completed') {
      checkSyncStatus();
    }
  });
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
  dashboardSyncMoreBtn.addEventListener('click', () => {
    dashboardSyncMoreBtn.disabled = true;
    dashboardSyncMoreBtn.textContent = '수집 중...';
    chrome.runtime.sendMessage({ action: 'START_STEP_3_SYNC' }, () => {
      location.reload();
    });
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
        loadDashboardData();
      } else {
        showSilentToast('구독 목록 동기화 실패: ' + (res?.error || '알 수 없는 오류'), 'linear-gradient(135deg, #e63946, #e63946)');
      }
    });
  });
}

const btnRefreshVideos = document.getElementById('btn-refresh-videos');
if (btnRefreshVideos) {
  btnRefreshVideos.addEventListener('click', () => {
    btnRefreshVideos.disabled = true;
    const oldText = btnRefreshVideos.textContent;
    btnRefreshVideos.textContent = '영상 데이터 수집 중...';
    chrome.runtime.sendMessage({ action: 'REFRESH_VIDEOS_BATCH' }, (res) => {
      btnRefreshVideos.disabled = false;
      btnRefreshVideos.textContent = oldText;
      if (res && res.status === 'completed') {
        showSilentToast(res.msg || '20개 채널 업데이트 완료', 'linear-gradient(135deg, #38B000, #38B000)');
        
        const subtitle = document.querySelector('.section-subtitle');
        if (subtitle) {
          subtitle.textContent = "20개 채널 업데이트 완료 (다음 청크 준비 완료)";
        }
        
        loadDashboardData();
      } else {
        showSilentToast('영상 수집 실패: ' + (res?.error || '알 수 없는 오류'), 'linear-gradient(135deg, #e63946, #e63946)');
      }
    });
  });
}

// Sub-Tab Switch Wiring
const activeTabBtn = document.getElementById('tab-active-subs');
const historyTabBtn = document.getElementById('tab-history-subs');

if (activeTabBtn && historyTabBtn) {
  activeTabBtn.addEventListener('click', () => {
    currentTab = 'active';
    activeTabBtn.classList.add('active');
    activeTabBtn.style.color = 'white';
    activeTabBtn.style.borderBottom = '2px solid #e63946';
    
    historyTabBtn.classList.remove('active');
    historyTabBtn.style.color = 'rgba(255,255,255,0.5)';
    historyTabBtn.style.borderBottom = 'none';
    
    document.getElementById('bulk-unsub-btn').style.display = 'block';
    document.querySelector('.select-all-wrapper').style.display = 'flex';
    
    loadDashboardData();
  });

  historyTabBtn.addEventListener('click', () => {
    currentTab = 'history';
    historyTabBtn.classList.add('active');
    historyTabBtn.style.color = 'white';
    historyTabBtn.style.borderBottom = '2px solid #e63946';
    
    activeTabBtn.classList.remove('active');
    activeTabBtn.style.color = 'rgba(255,255,255,0.5)';
    activeTabBtn.style.borderBottom = 'none';
    
    document.getElementById('bulk-unsub-btn').style.display = 'none';
    document.querySelector('.select-all-wrapper').style.display = 'none';
    
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
    loadDashboardData();
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
});

// Initial startup check
checkSyncStatus();
statusIntervalId = setInterval(checkSyncStatus, 1000);
