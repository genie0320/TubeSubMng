// YouTube Guide Categories Mapping Table
const YOUTUBE_GUIDE_CATEGORIES = {
  "GC01": "영화/드라마",
  "GC02": "자동차",
  "GC03": "음악",
  "GC04": "반려동물/동물",
  "GC05": "스포츠",
  "GC06": "여행/이벤트",
  "GC07": "게임",
  "GC08": "코미디",
  "GC09": "엔터테인먼트",
  "GC10": "뉴스/정치",
  "GC11": "스타일/뷰티",
  "GC12": "교육",
  "GC13": "과학/기술",
  "GC14": "실용/노하우",
  "GC15": "비영리/사회운동"
};

// State management for per-account isolation
const state = {
  activeOwnerId: '',
  activeUserEmail: '',
  activeChannelTitle: ''
};
let memorySessionToken = null;

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
    // Preserve existing email if new is empty
    if (!accountData.email && account_registry[existingIndex].email) {
      accountData.email = account_registry[existingIndex].email;
    }
    account_registry[existingIndex] = accountData;
  } else {
    account_registry.push(accountData);
  }
  await chrome.storage.local.set({ account_registry });
}

// Resolve the logged-in User Channel ID via YouTube API or local storage fallback
async function resolveActiveOwnerId() {
  if (state.activeOwnerId) return state.activeOwnerId;
  
  const stored = await chrome.storage.local.get(['activeOwnerId', 'activeUserEmail', 'activeChannelTitle']);
  if (stored.activeOwnerId) {
    state.activeOwnerId = stored.activeOwnerId;
    state.activeUserEmail = stored.activeUserEmail || '';
    state.activeChannelTitle = stored.activeChannelTitle || '';
    return state.activeOwnerId;
  }
  
  try {
    const data = await fetchYouTubeAPI('https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true', false);
    if (data && data.items && data.items.length > 0) {
      const channelId = data.items[0].id;
      const channelTitle = data.items[0].snippet?.title || '';
      if (channelId) {
        state.activeOwnerId = channelId;
        state.activeChannelTitle = channelTitle;
        await chrome.storage.local.set({ 
          activeOwnerId: channelId, 
          activeChannelTitle: channelTitle 
        });
        // Persist current in-memory token to L2 cache now that channelId is known
        if (memorySessionToken) {
          await persistToken(memorySessionToken, channelId);
        }
        await updateAccountLedger(channelId, state.activeUserEmail, channelTitle);
        return state.activeOwnerId;
      }
    }
  } catch (err) {
    console.warn("Failed to fetch activeOwnerId from YouTube API:", err);
  }
  
  state.activeOwnerId = 'default_user';
  return state.activeOwnerId;
}

// IndexedDB Setup
const DB_VERSION = 4;

async function openDB(ownerId) {
  const targetOwnerId = ownerId || await resolveActiveOwnerId();
  const dbName = `TubeManagerDB_${targetOwnerId}`;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    
    request.onerror = () => {
      console.error("IndexedDB open error:", request.error);
      reject(request.error);
    };
    
    request.onsuccess = () => {
      resolve(request.result);
    };
    
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

// Transaction Helpers
function getAllFromStore(storeName, ownerId) {
  return openDB(ownerId).then(db => {
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
  });
}

function saveToStore(storeName, dataArray, ownerId) {
  return openDB(ownerId).then(db => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      tx.oncomplete = () => {
        resolve();
        db.close();
      };
      tx.onerror = () => {
        reject(tx.error);
        db.close();
      };
      
      for (const item of dataArray) {
        if (storeName === 'channels_master') {
          const req = store.get(item.id);
          req.onsuccess = (e) => {
            const existing = e.target.result;
            if (existing) {
              item.first_registered_at = existing.first_registered_at || Date.now();
            } else if (!item.first_registered_at) {
              item.first_registered_at = Date.now();
            }
            store.put(item);
          };
        } else {
          store.put(item);
        }
      }
    });
  });
}

// ============================================================
// [Token Persistence Cache] — 3-Layer Auth Architecture
// L1: memorySessionToken (in-process, fastest)
// L2: chrome.storage.local.active_tokens (1-hour persistent)
// L3: launchWebAuthFlow (only when L1+L2 both miss/expired)
// ============================================================

async function loadCachedToken(channelId) {
  // Resolve channelId from storage if not yet known in-process
  let targetId = channelId;
  if (!targetId || targetId === 'default_user' || targetId === 'sample_user') {
    const stored = await chrome.storage.local.get(['activeOwnerId']);
    targetId = stored.activeOwnerId || '';
  }
  if (!targetId || targetId === 'default_user' || targetId === 'sample_user') return null;
  try {
    const data = await chrome.storage.local.get(['active_tokens']);
    const tokens = data.active_tokens || {};
    const entry = tokens[targetId];
    if (entry && entry.token && Date.now() < entry.expire_at) {
      console.log(`[TokenCache] L2 hit for ${targetId} — expires in ${Math.round((entry.expire_at - Date.now()) / 60000)}m`);
      return entry.token;
    }
    return null;
  } catch (e) {
    console.warn('[TokenCache] loadCachedToken error:', e);
    return null;
  }
}

async function persistToken(token, channelId) {
  if (!channelId || channelId === 'default_user' || channelId === 'sample_user') return;
  try {
    const data = await chrome.storage.local.get(['active_tokens']);
    const tokens = data.active_tokens || {};
    tokens[channelId] = { token, expire_at: Date.now() + 3_600_000 };
    await chrome.storage.local.set({ active_tokens: tokens });
    console.log(`[TokenCache] L2 persisted for ${channelId} — valid 1hr`);
  } catch (e) {
    console.warn('[TokenCache] persistToken error:', e);
  }
}

async function evictCachedToken(channelId) {
  if (!channelId || channelId === 'default_user' || channelId === 'sample_user') return;
  try {
    const data = await chrome.storage.local.get(['active_tokens']);
    const tokens = data.active_tokens || {};
    if (tokens[channelId]) {
      delete tokens[channelId];
      await chrome.storage.local.set({ active_tokens: tokens });
      console.log(`[TokenCache] L2 evicted for ${channelId}`);
    }
  } catch (e) {
    console.warn('[TokenCache] evictCachedToken error:', e);
  }
}

// OAuth Token acquisition — 3-layer cache lookup
async function getAuthToken(interactive = false) {
  // L1: in-memory fast path (within same SW lifecycle)
  if (memorySessionToken) {
    return memorySessionToken;
  }

  // L2: persistent token cache (survives SW restart)
  const cachedToken = await loadCachedToken(state.activeOwnerId);
  if (cachedToken) {
    memorySessionToken = cachedToken;
    return cachedToken;
  }

  // L3: full OAuth web flow — only when both caches miss
  return new Promise((resolve, reject) => {
    const clientId = '541710232861-65gncvlhfcsdvh9seg6hpuurkmnojf19.apps.googleusercontent.com';
    const redirectUri = encodeURIComponent(chrome.identity.getRedirectURL());
    const scope = encodeURIComponent([
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' '));
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&response_type=token&redirect_uri=${redirectUri}&scope=${scope}&prompt=select_account`;

    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirectUrl) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (!redirectUrl) {
        return reject(new Error('Web authorization flow failed.'));
      }
      
      try {
        const urlObj = new URL(redirectUrl);
        const params = new URLSearchParams(urlObj.hash.substring(1));
        const token = params.get('access_token');
        if (token) {
          memorySessionToken = token;
          // Note: token is persisted to L2 inside resolveActiveOwnerId()
          // after channelId is confirmed, to avoid keying on empty string.
          
          fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { 'Authorization': `Bearer ${token}` }
          })
          .then(r => r.json())
          .then(async (userinfo) => {
            if (userinfo && userinfo.email) {
              state.activeUserEmail = userinfo.email;
              await chrome.storage.local.set({ activeUserEmail: userinfo.email });
              await updateAccountLedger(state.activeOwnerId, userinfo.email, state.activeChannelTitle);
            }
            resolve(token);
          })
          .catch((err) => {
            console.error('Failed to fetch userinfo email:', err);
            resolve(token);
          });
        } else {
          reject(new Error('Access token not found in redirection URL.'));
        }
      } catch (err) {
        reject(err);
      }
    });
  });
}

// Helper to make API calls
async function fetchYouTubeAPI(url, interactive = false) {
  let token;
  try {
    token = await getAuthToken(interactive);
  } catch (err) {
    console.error("Failed to acquire OAuth token:", err);
    throw err;
  }

  let response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      memorySessionToken = null;
      // Evict stale token from L2 persistent cache
      await evictCachedToken(state.activeOwnerId);
    }
    const errorBody = await response.text().catch(() => '');
    throw new Error(`YouTube API HTTP error! Status: ${response.status}. Body: ${errorBody}`);
  }

  return response.json();
}

// Ingest Subscriptions
async function ingestSubscriptionsFromAPI(ownerId) {
  console.log("Loading subscriptions via YouTube API...");
  let baseSubscriptions = [];
  let nextPageToken = '';
  
  await chrome.storage.local.set({
    syncStatus: 'STEP1_IN_PROGRESS',
    timestamp: new Date().toISOString()
  });

  try {
    do {
      const url = `https://www.googleapis.com/youtube/v3/subscriptions?part=snippet,contentDetails&mine=true&maxResults=50${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;
      const data = await fetchYouTubeAPI(url, true);
      
      if (data.items) {
        for (const item of data.items) {
          const id = item.snippet?.resourceId?.channelId;
          const title = item.snippet?.title || '';
          const rawPublishedAt = item.snippet?.publishedAt || '';
          // Ensure we parse to millisecond timestamp to resolve the '1 day' bug
          const subscribed_at = rawPublishedAt ? new Date(rawPublishedAt).getTime() : Date.now();
          if (id) {
            baseSubscriptions.push({
              id,
              subscriptionId: item.id,
              title,
              customUrl: '',
              subscribed_at,
              syncedAt: new Date().toISOString(),
              raw_api_payload: item
            });
          }
        }
      }
      nextPageToken = data.nextPageToken || '';
    } while (nextPageToken);

    if (baseSubscriptions.length === 0) {
      throw new Error('구독 중인 채널을 검색하지 못했습니다.');
    }

    await saveToStore('youtube_subscriptions', baseSubscriptions, ownerId);

    await chrome.storage.local.set({
      syncStatus: 'STEP1_COMPLETED',
      totalChannels: baseSubscriptions.length,
      timestamp: new Date().toISOString()
    });

    await updateAccountLedger(ownerId, state.activeUserEmail, state.activeChannelTitle);

    return baseSubscriptions.length;
  } catch (err) {
    await chrome.storage.local.set({
      syncStatus: 'STEP1_FAILED',
      error: err.message,
      timestamp: new Date().toISOString()
    });
    throw err;
  }
}

// Sync Channel Metadata
async function syncChannelMetadata(ownerId) {
  const state = await chrome.storage.local.get(['syncStatus']);
  if (state.syncStatus !== 'STEP1_COMPLETED' && state.syncStatus !== 'STEP2_IN_PROGRESS' && state.syncStatus !== 'STEP2_FAILED') {
    throw new Error('1단계(마스터 구독 목록 확보)가 완료되어야 실행 가능합니다.');
  }

  const subscriptions = await getAllFromStore('youtube_subscriptions', ownerId);
  if (subscriptions.length === 0) {
    throw new Error('구독 목록 저장소가 비어 있습니다.');
  }

  const subMap = new Map(subscriptions.map(s => [s.id, s.subscribed_at]));

  const batchSize = 50;
  const totalChannels = subscriptions.length;
  const totalChunks = Math.ceil(totalChannels / batchSize);

  const progress = await chrome.storage.local.get(['currentStep2Chunk']);
  const startChunkIdx = progress.currentStep2Chunk || 0;

  await chrome.storage.local.set({
    syncStatus: 'STEP2_IN_PROGRESS',
    totalChunks: totalChunks,
    timestamp: new Date().toISOString()
  });

  for (let i = startChunkIdx; i < totalChunks; i++) {
    const curState = await chrome.storage.local.get(['syncStatus']);
    if (curState.syncStatus === 'paused') {
      console.log("Step 2 Sync paused by user.");
      return i * batchSize;
    }
    const start = i * batchSize;
    const end = Math.min(start + batchSize, totalChannels);
    const chunkSub = subscriptions.slice(start, end);
    const chunkIds = chunkSub.map(s => s.id);

    console.log(`Step 2: Processing chunk ${i + 1}/${totalChunks}...`);

    let processedChannels = [];
    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics,topicDetails,brandingSettings,status,localizations&id=${chunkIds.join(',')}`;
    try {
      const data = await fetchYouTubeAPI(url, false);
      if (data.items) {
        processedChannels = data.items.map(item => {
          let categoryName = "미분류";
          if (item.snippet?.categoryId) {
            categoryName = YOUTUBE_GUIDE_CATEGORIES[item.snippet.categoryId] || "미분류";
          }
          return {
            id: item.id,
            title: item.snippet?.title || '',
            description: item.snippet?.description || '',
            customUrl: item.snippet?.customUrl || '',
            thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
            uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || `UU${item.id.substring(2)}`,
            view_count: parseInt(item.statistics?.viewCount || '0', 10),
            subscriber_count: parseInt(item.statistics?.subscriberCount || '0', 10),
            video_count: parseInt(item.statistics?.videoCount || '0', 10),
            mappedCategory: categoryName,
            topicCategories: item.topicDetails?.topicCategories || [],
            subscribed_at: subMap.get(item.id) || Date.now(),
            syncedAt: new Date().toISOString(),
            last_synced_at: Date.now(),
            status_flag: 'SUBSCRIBED',
            raw_api_payload: item
          };
        });
      }
    } catch (err) {
      console.error(`Step 2 Chunk ${i + 1} API Error:`, err);
      throw err;
    }

    await saveToStore('channels_master', processedChannels, ownerId);

    await chrome.storage.local.set({
      syncStatus: 'STEP2_IN_PROGRESS',
      currentStep2Chunk: i + 1,
      totalStep2Chunks: totalChunks,
      step2ProcessedCount: end,
      timestamp: new Date().toISOString()
    });
  }

  await chrome.storage.local.set({
    syncStatus: 'STEP2_COMPLETED',
    timestamp: new Date().toISOString()
  });

  return totalChannels;
}

// syncLatestVideos() has been removed.
// Stage 3 RSS ingestion now runs directly inside dashboard.js
// where DOMParser is available (full tab context, not SW).
// See syncLatestVideosRSS() in dashboard.js.

// Sync Latest Videos details — LEGACY STUB (kept for runSilentSync reference)
async function syncLatestVideos(ownerId) {
  const state = await chrome.storage.local.get(['syncStatus']);
  const isAllowedStatus = [
    'STEP2_COMPLETED',
    'STEP3_IN_PROGRESS',
    'STEP3_FAILED',
    'STEP3_PARTIAL_COMPLETED'
  ].includes(state.syncStatus);
  
  if (!isAllowedStatus) {
    throw new Error('2단계(채널 세부정보 동기화)가 완료되어야 실행 가능합니다.');
  }

  const channels = await getAllFromStore('channels_master', ownerId);
  if (channels.length === 0) {
    throw new Error('채널 상세 정보 저장소가 비어 있습니다.');
  }

  const total = channels.length;
  const progress = await chrome.storage.local.get(['currentStep3Index']);
  const startIndex = progress.currentStep3Index || 0;
  
  const limit = 50;
  const endIndex = Math.min(startIndex + limit, total);

  if (startIndex >= total) {
    await chrome.storage.local.set({
      syncStatus: 'STEP3_COMPLETED',
      timestamp: new Date().toISOString()
    });
    return 0;
  }

  await chrome.storage.local.set({
    syncStatus: 'STEP3_IN_PROGRESS',
    timestamp: new Date().toISOString()
  });

  for (let idx = startIndex; idx < endIndex; idx++) {
    const curState = await chrome.storage.local.get(['syncStatus']);
    if (curState.syncStatus === 'paused') {
      console.log("Step 3 Sync paused by user.");
      return idx - startIndex;
    }
    const ch = channels[idx];
    if (!ch) continue;

    try {
      const playlistId = ch.uploadsPlaylistId;
      console.log(`Step 3: Processing channel ${idx + 1}/${total} (${ch.title})...`);

      let videoItems = [];
      if (playlistId) {
        const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails,status&playlistId=${playlistId}&maxResults=3`;
        try {
          const data = await fetchYouTubeAPI(url, false);
          if (data.items && data.items.length > 0) {
             const rawPublished = data.items[0].snippet?.publishedAt || data.items[0].contentDetails?.videoPublishedAt || '';
             const last_uploaded_at = rawPublished ? new Date(rawPublished).getTime() : Date.now();
              
             const dbUpdate = await openDB(ownerId);
             const txCh = dbUpdate.transaction(['channels_master'], 'readwrite');
             const chStore = txCh.objectStore('channels_master');
             const chRecord = await new Promise((resolveCh) => {
               const reqCh = chStore.get(ch.id);
               reqCh.onsuccess = () => resolveCh(reqCh.result);
               reqCh.onerror = () => resolveCh(null);
             });
             if (chRecord) {
               chRecord.last_uploaded_at = last_uploaded_at;
               chRecord.last_synced_at = Date.now();
               chStore.put(chRecord);
             }
             txCh.oncomplete = () => dbUpdate.close();
             txCh.onerror = () => dbUpdate.close();

             videoItems = data.items.map(item => {
               const vRawDate = item.snippet?.publishedAt || item.contentDetails?.videoPublishedAt || '';
               const vUploadedAt = vRawDate ? new Date(vRawDate).getTime() : Date.now();
               return {
                 id: item.snippet?.resourceId?.videoId || item.id,
                 target_channel_id: ch.id,
                 title: item.snippet?.title || '',
                 uploaded_at: vUploadedAt,
                 thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
                 syncedAt: new Date().toISOString(),
                 raw_api_payload: item
               };
             });
          }
        } catch (err) {
          console.warn(`Step 3 API fetch failed for playlist ${playlistId}:`, err);
        }
      }

      if (videoItems.length > 0) {
        await saveToStore('video_preview_cache', videoItems, ownerId);
      }
      
    } catch (channelErr) {
      console.error(`Error processing channel ${ch.title} at index ${idx}:`, channelErr);
    }

    await chrome.storage.local.set({
      syncStatus: 'STEP3_IN_PROGRESS',
      currentStep3Index: idx + 1,
      totalStep3Channels: total,
      timestamp: new Date().toISOString()
    });
  }

  if (endIndex >= total) {
    await chrome.storage.local.set({
      syncStatus: 'STEP3_COMPLETED',
      timestamp: new Date().toISOString()
    });
    await updateAccountLedger(ownerId, state.activeUserEmail, state.activeChannelTitle);
  } else {
    await chrome.storage.local.set({
      syncStatus: 'STEP3_PARTIAL_COMPLETED',
      timestamp: new Date().toISOString()
    });
    await updateAccountLedger(ownerId, state.activeUserEmail, state.activeChannelTitle);
  }

  return endIndex - startIndex;
}

// Background Silent Update
async function runSilentSync() {
  try {
    const subscriptions = await getAllFromStore('youtube_subscriptions');
    const totalCount = subscriptions.length;
    let processedCount = 0;

    if (totalCount === 0) {
      chrome.runtime.sendMessage({ type: "SYNC_COMPLETED" });
      return;
    }

    const subMap = new Map(subscriptions.map(s => [s.id, s.subscribed_at]));

    const batchSize = 50;
    for (let i = 0; i < Math.ceil(totalCount / batchSize); i++) {
      try {
        const chunk = subscriptions.slice(i * batchSize, (i + 1) * batchSize);
        const chunkIds = chunk.map(s => s.id);
        const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics,topicDetails,brandingSettings,status,localizations&id=${chunkIds.join(',')}`;
        const data = await fetchYouTubeAPI(url, false);
        
        if (data.items) {
          const processed = data.items.map(item => {
            let categoryName = "미분류";
            if (item.snippet?.categoryId) {
              categoryName = YOUTUBE_GUIDE_CATEGORIES[item.snippet.categoryId] || "미분류";
            }
            return {
              id: item.id,
              title: item.snippet?.title || '',
              description: item.snippet?.description || '',
              customUrl: item.snippet?.customUrl || '',
              thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
              uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads || `UU${item.id.substring(2)}`,
              view_count: parseInt(item.statistics?.viewCount || '0', 10),
              subscriber_count: parseInt(item.statistics?.subscriberCount || '0', 10),
              video_count: parseInt(item.statistics?.videoCount || '0', 10),
              mappedCategory: categoryName,
              topicCategories: item.topicDetails?.topicCategories || [],
              subscribed_at: subMap.get(item.id) || Date.now(),
              syncedAt: new Date().toISOString(),
              last_synced_at: Date.now(),
              status_flag: 'SUBSCRIBED',
              raw_api_payload: item
            };
          });
          await saveToStore('channels_master', processed);
        }
        
        processedCount = Math.min((i + 1) * batchSize, totalCount);
        chrome.runtime.sendMessage({ 
          type: "SYNC_PROGRESS", 
          current: processedCount, 
          total: totalCount,
          stage: "메타데이터 수집 중" 
        });
      } catch (chunkErr) {
        console.error("Silent Sync batch error:", chunkErr);
        chrome.runtime.sendMessage({ type: "SYNC_ERROR", error: chunkErr.message });
        return;
      }
    }
    
    const channels = await getAllFromStore('channels_master');
    processedCount = 0;
    for (let idx = 0; idx < channels.length; idx++) {
      const ch = channels[idx];
      try {
        const playlistId = ch.uploadsPlaylistId;
        if (playlistId) {
          const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails,status&playlistId=${playlistId}&maxResults=3`;
          const data = await fetchYouTubeAPI(url, false);
          if (data.items && data.items.length > 0) {
            const rawPublished = data.items[0].snippet?.publishedAt || data.items[0].contentDetails?.videoPublishedAt || '';
            const last_uploaded_at = rawPublished ? new Date(rawPublished).getTime() : Date.now();
            ch.last_uploaded_at = last_uploaded_at;
            ch.last_synced_at = Date.now();
            await saveToStore('channels_master', [ch]);

            const videoItems = data.items.map(item => {
              const vRawDate = item.snippet?.publishedAt || item.contentDetails?.videoPublishedAt || '';
              const vUploadedAt = vRawDate ? new Date(vRawDate).getTime() : Date.now();
              return {
                id: item.snippet?.resourceId?.videoId || item.id,
                target_channel_id: ch.id,
                title: item.snippet?.title || '',
                uploaded_at: vUploadedAt,
                thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '',
                syncedAt: new Date().toISOString(),
                raw_api_payload: item
              };
            });
            await saveToStore('video_preview_cache', videoItems);
          }
        }
        processedCount = idx + 1;
        if (processedCount % 5 === 0 || processedCount === channels.length) {
          chrome.runtime.sendMessage({ 
            type: "SYNC_PROGRESS", 
            current: processedCount, 
            total: channels.length,
            stage: "활동 분석 중" 
          });
        }
      } catch (videoErr) {
        console.warn(`Silent Sync videos error on channel ${ch.title}:`, videoErr);
      }
    }
    
    chrome.runtime.sendMessage({ type: "SYNC_COMPLETED" });
  } catch (err) {
    console.error("Silent Sync main loop crashed:", err);
    chrome.runtime.sendMessage({ type: "SYNC_ERROR", error: err.message });
  }
}

// ==========================================
// [보류 삭제 및 복구 아키텍처] (Undo Pending Delete Queue)
// ==========================================
let activeTimers = {};

async function executeActualDelete(channelId) {
  if (activeTimers[channelId]) {
    clearTimeout(activeTimers[channelId]);
    delete activeTimers[channelId];
  }
  if (chrome.alarms) {
    chrome.alarms.clear("delete_channel_" + channelId);
  }

  console.log(`Executing actual subscription delete for channel: ${channelId}`);
  try {
    let subscriptionId = '';
    const db = await openDB();
    const subTx = db.transaction(['youtube_subscriptions'], 'readonly');
    const subStore = subTx.objectStore('youtube_subscriptions');
    const subRecord = await new Promise((res) => {
      const req = subStore.get(channelId);
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    });
    if (subRecord && subRecord.subscriptionId) {
      subscriptionId = subRecord.subscriptionId;
    }
    db.close();

    let apiSuccess = false;

    if (channelId.startsWith('UC_sample_')) {
      apiSuccess = true;
      console.log(`Sample subscription mock deleted: ${channelId}`);
    } else if (subscriptionId) {
      try {
        const token = await getAuthToken(false);
        const response = await fetch(`https://www.googleapis.com/youtube/v3/subscriptions?id=${subscriptionId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        if (response.status === 204 || response.status === 404) {
          apiSuccess = true;
          console.log(`YouTube API DELETE subscription success (status ${response.status}): ${subscriptionId}`);
        } else {
          console.error(`YouTube API DELETE failure. Status: ${response.status}`);
        }
      } catch (apiErr) {
        console.error("YouTube API DELETE endpoint failed:", apiErr);
      }
    }

    if (apiSuccess) {
      // 100% NO PHYSICAL DELETION RULE. We put updated status_flag and do NOT delete records.
      const dbUpdate = await openDB();
      const tx = dbUpdate.transaction(['channels_master'], 'readwrite');
      
      const channelsStore = tx.objectStore('channels_master');
      const channelRecord = await new Promise((res) => {
        const req = channelsStore.get(channelId);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
      });
      
      if (channelRecord) {
        channelRecord.status_flag = 'UNSUBSCRIBED';
        delete channelRecord.pending_delete;
        delete channelRecord.pending_delete_time;
        channelsStore.put(channelRecord);
      }
      
      tx.oncomplete = () => {
        dbUpdate.close();
        console.log(`IndexedDB status_flag updated to UNSUBSCRIBED for: ${channelId}`);
        chrome.runtime.sendMessage({ action: 'DELETION_FINALIZED', channelId, status: 'UNSUBSCRIBED' });
      };
      tx.onerror = () => {
        dbUpdate.close();
      };
    } else {
      const dbUpdate = await openDB();
      const tx = dbUpdate.transaction(['channels_master'], 'readwrite');
      const channelsStore = tx.objectStore('channels_master');
      const channelRecord = await new Promise((res) => {
        const req = channelsStore.get(channelId);
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
      });
      if (channelRecord) {
        channelRecord.status_flag = 'SUBSCRIBED';
        delete channelRecord.pending_delete;
        delete channelRecord.pending_delete_time;
        channelsStore.put(channelRecord);
      }
      tx.oncomplete = () => dbUpdate.close();
      tx.onerror = () => dbUpdate.close();
      console.warn(`Deletion failed. Reverted channel ${channelId} to SUBSCRIBED.`);
      chrome.runtime.sendMessage({ action: 'DELETION_FINALIZED', channelId, status: 'SUBSCRIBED' });
    }
  } catch (err) {
    console.error("Critical error in actual deletion logic:", err);
  }
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name.startsWith("delete_channel_")) {
      const channelId = alarm.name.replace("delete_channel_", "");
      executeActualDelete(channelId);
    }
  });
}

async function cleanExpiredPendingDeletions() {
  try {
    const db = await openDB();
    if (!db.objectStoreNames.contains('youtube_channels')) {
      db.close();
      return;
    }
    const tx = db.transaction(['youtube_channels'], 'readonly');
    const store = tx.objectStore('youtube_channels');
    const channels = await new Promise((res, rej) => {
      const req = store.getAll();
      req.onsuccess = () => res(req.result || []);
      req.onerror = () => rej(req.error);
    });
    db.close();

    for (const ch of channels) {
      if (ch.status_flag === 'PENDING' || ch.pending_delete) {
        const elapsed = Date.now() - (ch.pending_delete_time || 0);
        if (elapsed >= 5000) {
          await executeActualDelete(ch.id);
        } else {
          const remainingSec = (5000 - elapsed) / 1000;
          if (chrome.alarms) {
            chrome.alarms.create("delete_channel_" + ch.id, { delayInMinutes: remainingSec / 60 });
          }
          
          if (activeTimers[ch.id]) clearTimeout(activeTimers[ch.id]);
          activeTimers[ch.id] = setTimeout(() => {
            executeActualDelete(ch.id);
          }, 5000 - elapsed);
        }
      }
    }
  } catch (err) {
    console.error("Startup pending deletion cleaner crashed:", err);
  }
}

chrome.runtime.onStartup.addListener(cleanExpiredPendingDeletions);
cleanExpiredPendingDeletions();

// ============================================================
// [Migration State Machine] — Persistent Background Queue
// Decouples migration execution from the dashboard tab lifecycle.
// chrome.alarms watchdog re-wakes the SW if Chrome kills it mid-run.
// Queue stored in chrome.storage.local.migration_queue.
// Schema: Array<{ id, title, status: 'pending'|'success'|'failed'|'skipped', ownerId }>
// ============================================================

async function processMigrationQueue() {
  const { migration_queue = [] } = await chrome.storage.local.get(['migration_queue']);
  const hasPending = migration_queue.some(item => item.status === 'pending');
  if (!hasPending) {
    // All done — cancel the watchdog alarm
    chrome.alarms.clear('MIGRATION_QUEUE_WATCHDOG');
    return;
  }

  for (let i = 0; i < migration_queue.length; i++) {
    const item = migration_queue[i];
    if (item.status !== 'pending') continue;

    try {
      const token = await getAuthToken(false);
      const response = await fetch(
        'https://www.googleapis.com/youtube/v3/subscriptions?part=snippet',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            snippet: {
              resourceId: { kind: 'youtube#channel', channelId: item.id }
            }
          })
        }
      );

      if (response.status === 403) {
        // Quota boundary — mark all remaining pending as failed, stop loop
        console.warn('[MigrationQueue] HTTP 403 quota limit hit. Halting queue.');
        for (let j = i; j < migration_queue.length; j++) {
          if (migration_queue[j].status === 'pending') {
            migration_queue[j].status = 'failed';
          }
        }
        await chrome.storage.local.set({ migration_queue });
        chrome.alarms.clear('MIGRATION_QUEUE_WATCHDOG');
        try { chrome.runtime.sendMessage({ type: 'MIGRATION_QUOTA_EXCEEDED' }); } catch (_) {}
        try {
          chrome.runtime.sendMessage({ type: 'MIGRATION_QUEUE_UPDATE', queue: migration_queue });
        } catch (_) {}
        return;
      } else if (response.status === 409) {
        migration_queue[i].status = 'skipped';
      } else if (response.ok) {
        migration_queue[i].status = 'success';
      } else {
        const body = await response.text().catch(() => '');
        console.warn(`[MigrationQueue] Status ${response.status} for ${item.id}:`, body);
        migration_queue[i].status = 'failed';
      }
    } catch (itemErr) {
      console.warn(`[MigrationQueue] Exception for ${item.id}:`, itemErr);
      migration_queue[i].status = 'failed';
    }

    // Persist updated status after every item
    await chrome.storage.local.set({ migration_queue });

    // Broadcast live progress to dashboard if it is open
    const done  = migration_queue.filter(q => q.status !== 'pending').length;
    const total = migration_queue.length;
    const successCount = migration_queue.filter(q => q.status === 'success').length;
    try {
      chrome.runtime.sendMessage({
        type: 'MIGRATION_QUEUE_UPDATE',
        queue: migration_queue,
        done, total, successCount,
        currentTitle: item.title || item.id
      });
    } catch (_) {}

    // Strict 1500ms throttle between each POST
    if (i < migration_queue.length - 1) {
      const remaining = migration_queue.slice(i + 1).some(q => q.status === 'pending');
      if (remaining) await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Loop complete — cancel watchdog alarm
  chrome.alarms.clear('MIGRATION_QUEUE_WATCHDOG');
  console.log('[MigrationQueue] Queue exhausted.');
  try {
    const finalQueue = migration_queue;
    chrome.runtime.sendMessage({ type: 'MIGRATION_QUEUE_UPDATE', queue: finalQueue, done: finalQueue.length, total: finalQueue.length, successCount: finalQueue.filter(q => q.status === 'success').length });
  } catch (_) {}
}

// ============================================================
// [Ingestion Queue State Machine] — Persistent Background Scraper
// Zero-API-quota hybrid scraper: ytInitialData regex + RSS entry regex.
// Runs entirely in SW (no DOMParser). Survives tab close via chrome.alarms.
// Storage key: chrome.storage.local.ingestion_queue
// Schema: Array<{ id, handle, title, status: 'pending'|'processing'|'success'|'failed' }>
// ============================================================

async function processIngestionQueue() {
  let { ingestion_queue = [] } = await chrome.storage.local.get(['ingestion_queue']);

  // ── 1. Boot-time sanitizer: reset stuck 'processing' rows to 'pending' ──────
  const stuckItems = ingestion_queue.filter(item => item.status === 'processing');
  stuckItems.forEach(item => item.status = 'pending');
  if (stuckItems.length > 0) {
    await chrome.storage.local.set({ ingestion_queue });
    console.log(`[Ingestion] Sanitized ${stuckItems.length} stuck 'processing' rows back to 'pending'.`);
  }

  const pendingItems = ingestion_queue.filter(i => i.status === 'pending');
  if (pendingItems.length === 0) {
    console.log('[Ingestion] Queue empty — clearing watchdog alarm.');
    chrome.alarms.clear('INGESTION_QUEUE_WATCHDOG');
    return;
  }

  // ── 2. Configuration Invariants ──────────────────────────────────────────
  const CHUNK_SIZE = 8;
  const STAGGER_MS = 150;
  const INTER_CHUNK_MS = 200;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ownerId = state.activeOwnerId;

  // ── 3. SW-Safe RSS Matcher & Parser (Single-pass XML regex ingestion) ──
  async function fetchChannelRssData(channelId, signal) {
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const result = { lastUploadedAt: 0, videoPreviews: [] };
    try {
      const resp = await fetch(url, { cache: 'no-store', signal });
      if (!resp.ok) return result;
      const text = await resp.text();

      // 1. Resolve authoritative timestamp of the absolute latest video entry
      const entryMatch = text.match(/<entry>[\s\S]*?<published>([^<]+)<\/published>/);
      if (entryMatch) {
        const ts = new Date(entryMatch[1]).getTime();
        if (!isNaN(ts)) result.lastUploadedAt = ts;
      }

      // 2. Extract top-3 video blocks sequentially for Cache Hydration
      const entryBlockRegex = /<entry>([\s\S]*?)<\/entry>/g;
      let entryMatchBlock;
      let count = 0;

      while ((entryMatchBlock = entryBlockRegex.exec(text)) !== null && count < 3) {
        const blockContent = entryMatchBlock[1];
        const idMatch = blockContent.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
        const titleMatch = blockContent.match(/<title>([^<]+)<\/title>/);
        const thumbMatch = blockContent.match(/<media:thumbnail\s+url="([^"]+)"/);
        const dateMatch = blockContent.match(/<published>([^<]+)<\/published>/);

        if (idMatch && titleMatch) {
          const vDate = dateMatch ? new Date(dateMatch[1]).getTime() : Date.now();
          result.videoPreviews.push({
            id: idMatch[1],
            target_channel_id: channelId,
            title: titleMatch[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
            uploaded_at: isNaN(vDate) ? Date.now() : vDate,
            thumbnail: thumbMatch ? thumbMatch[1] : `https://i.ytimg.com/vi/${idMatch[1]}/hqdefault.jpg`
          });
          count++;
        }
      }
      return result;
    } catch (err) {
      console.error("[RSS Engine Error]", err);
      return result;
    }
  }

  console.log(`[Ingestion Engine] Starting batch processing for ${pendingItems.length} pending channels.`);

  // ── 4. Throttled Concurrency Ingestion Loop ──────────────────────────────
  for (let i = 0; i < pendingItems.length; i += CHUNK_SIZE) {
    // Re-verify active runtime state sync
    const curQueueState = await chrome.storage.local.get(['ingestion_queue']);
    const freshQueue = curQueueState.ingestion_queue || ingestion_queue;
    
    const chunk = pendingItems.slice(i, i + CHUNK_SIZE);
    
    // Atomically lock chunk rows to 'processing'
    chunk.forEach(item => {
      const target = freshQueue.find(q => q.id === item.id);
      if (target) target.status = 'processing';
    });
    await chrome.storage.local.set({ ingestion_queue: freshQueue });

    // Execute parallel fetch slots with a stagger launch delay
    await Promise.all(chunk.map(async (item, slotIdx) => {
      await sleep(slotIdx * STAGGER_MS);
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s Network parachute
      
      let resolvedTimestamp = 0;
      let videoPreviews = [];

      try {
        // Phase 1: Authoritative RSS Data Map Ingest
        const rssData = await fetchChannelRssData(item.id, controller.signal);

        // Phase 2: Invariants Resolution
        resolvedTimestamp = rssData.lastUploadedAt;
        videoPreviews = rssData.videoPreviews;

        // Phase 3: Synchronous Callback-Chain IDB Invariants Execution
        const db = await openDB(ownerId);
        const tx = db.transaction(['channels_master'], 'readwrite');
        const store = tx.objectStore('channels_master');
        
        await new Promise((resResolve) => {
          const getReq = store.get(item.id);
          getReq.onsuccess = () => {
            const record = getReq.result;
            if (record) {
              record.last_uploaded_at = resolvedTimestamp;
              record.last_synced_at = Date.now();
              store.put(record);
            }
            resResolve();
          };
          getReq.onerror = () => resResolve();
        });
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();

        // Hydrate the preview store cache to eliminate modal emptiness
        if (videoPreviews.length > 0) {
          await saveToStore('video_preview_cache', videoPreviews, ownerId);
        }

        const targetItem = freshQueue.find(q => q.id === item.id);
        if (targetItem) targetItem.status = 'success';

      } catch (err) {
        console.error(`[Ingestion Engine] Failed processing for channel ${item.title}:`, err);
        const targetItem = freshQueue.find(q => q.id === item.id);
        if (targetItem) targetItem.status = 'failed';
      } finally {
        clearTimeout(timeoutId);
      }
    }));

    // Save batch milestones back to storage
    await chrome.storage.local.set({ ingestion_queue: freshQueue });

    // Reactive progress messaging to open UI panels
    const processedCount = freshQueue.filter(q => q.status !== 'pending' && q.status !== 'processing').length;
    try {
      chrome.runtime.sendMessage({
        type: 'INGESTION_QUEUE_UPDATE',
        done: processedCount,
        total: freshQueue.length,
        pending: freshQueue.filter(q => q.status === 'pending').length,
        currentTitle: chunk[chunk.length - 1]?.title || '',
        queue: freshQueue
      });
    } catch (_) {}

    // Multi-batch cooldown delay to mimic relaxed user pacing
    if (i + CHUNK_SIZE < pendingItems.length) {
      await sleep(INTER_CHUNK_MS);
    }
  }

  // Queue complete — clear alarm + final broadcast
  try { await chrome.alarms.clear('INGESTION_QUEUE_WATCHDOG'); } catch (_) {}
  const finalQueue   = ingestion_queue;
  const successCount = finalQueue.filter(q => q.status === 'success').length;
  const failedCount  = finalQueue.filter(q => q.status === 'failed').length;
  console.log(`[Ingestion] Complete: ${successCount} success, ${failedCount} failed / ${finalQueue.length} total`);
  try {
    chrome.runtime.sendMessage({
      type:    'INGESTION_QUEUE_UPDATE',
      queue:   finalQueue,
      done:    finalQueue.length,
      total:   finalQueue.length,
      pending: 0,
      successCount,
      failedCount,
      currentTitle: ''
    });
  } catch (_) {}
}

// ── Alarm Watchdog: re-wakes SW if Chrome kills it mid-migration or mid-ingestion ──
// Registered at top level so it survives SW restarts.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'MIGRATION_QUEUE_WATCHDOG') {
    console.log('[MigrationQueue] Watchdog alarm fired — checking queue state...');
    await processMigrationQueue();
  }
  if (alarm.name === 'INGESTION_QUEUE_WATCHDOG') {
    console.log('[Ingestion] Watchdog alarm fired — resuming ingestion queue...');
    await processIngestionQueue();
  }
});

// Messaging Routing
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'GET_ACTIVE_OWNER_ID') {
    resolveActiveOwnerId().then(ownerId => {
      sendResponse({ 
        activeOwnerId: ownerId, 
        email: state.activeUserEmail,
        channelTitle: state.activeChannelTitle
      });
    });
    return true;
  }

  if (message.action === 'START_STEP_1_SYNC') {
    const ownerId = message.ownerId;
    (async () => {
      try {
        const count = await ingestSubscriptionsFromAPI(ownerId);
        sendResponse({ status: 'completed', total: count });
      } catch (error) {
        sendResponse({ status: 'failed', error: error.message });
      }
    })();
    return true;
  }

  if (message.action === 'START_STEP_2_SYNC') {
    const ownerId = message.ownerId;
    (async () => {
      try {
        const total = await syncChannelMetadata(ownerId);
        sendResponse({ status: 'completed', total: total });
      } catch (error) {
        sendResponse({ status: 'failed', error: error.message });
      }
    })();
    return true;
  }

  // START_STEP_3_SYNC is deprecated — Stage 3 RSS now runs in dashboard.js
  // Kept as a safe no-op stub for any legacy callers during transition.
  if (message.action === 'START_STEP_3_SYNC') {
    sendResponse({ status: 'completed', total: 0 });
    return true;
  }
  
  if (message.action === 'START_PENDING_DELETE') {
    const channelId = message.channelId;
    (async () => {
      try {
        const db = await openDB();
        let tx = db.transaction(['channels_master'], 'readwrite');
        let store = tx.objectStore('channels_master');
        let ch = await new Promise((res, rej) => {
          const req = store.get(channelId);
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        if (ch) {
          ch.status_flag = 'PENDING';
          ch.pending_delete = true;
          ch.pending_delete_time = Date.now();
          await new Promise((res, rej) => {
            const req = store.put(ch);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
          });
        }
        db.close();

        if (chrome.alarms) {
          chrome.alarms.create("delete_channel_" + channelId, { delayInMinutes: 5 / 60 });
        }
        if (activeTimers[channelId]) clearTimeout(activeTimers[channelId]);
        activeTimers[channelId] = setTimeout(() => {
          executeActualDelete(channelId);
        }, 5000);

        sendResponse({ status: 'completed' });
      } catch (err) {
        sendResponse({ status: 'failed', error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'CANCEL_PENDING_DELETE') {
    const channelId = message.channelId;
    (async () => {
      try {
        const db = await openDB();
        let tx = db.transaction(['channels_master'], 'readwrite');
        let store = tx.objectStore('channels_master');
        let ch = await new Promise((res, rej) => {
          const req = store.get(channelId);
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        if (ch) {
          ch.status_flag = 'SUBSCRIBED';
          delete ch.pending_delete;
          delete ch.pending_delete_time;
          await new Promise((res, rej) => {
            const req = store.put(ch);
            req.onsuccess = () => res();
            req.onerror = () => rej(req.error);
          });
        }
        db.close();

        if (chrome.alarms) {
          chrome.alarms.clear("delete_channel_" + channelId);
        }
        if (activeTimers[channelId]) {
          clearTimeout(activeTimers[channelId]);
          delete activeTimers[channelId];
        }

        sendResponse({ status: 'completed' });
      } catch (err) {
        sendResponse({ status: 'failed', error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'TRIGGER_SILENT_SYNC') {
    runSilentSync();
    sendResponse({ status: 'started' });
    return true;
  }

  if (message.action === 'REVOKE_AUTH_TOKEN') {
    (async () => {
      try {
        const token = await getAuthToken(false).catch(() => null);
        if (token) {
          await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`).catch(() => {});
        }
        sendResponse({ status: 'completed' });
      } catch (err) {
        sendResponse({ status: 'failed', error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'RESET_SESSION') {
    const ownerIdToEvict = state.activeOwnerId;
    memorySessionToken = null;
    state.activeOwnerId = '';
    state.activeUserEmail = '';
    state.activeChannelTitle = '';
    (async () => {
      // Evict only this account's token from L2 — other accounts' tokens survive
      await evictCachedToken(ownerIdToEvict);
      chrome.storage.local.remove(['activeOwnerId', 'activeUserEmail', 'activeChannelTitle'], () => {
        sendResponse({ status: 'completed' });
      });
    })();
    return true;
  }

  if (message.action === 'TRIGGER_NEW_AUTH') {
    const ownerIdToEvict = state.activeOwnerId;
    memorySessionToken = null;
    state.activeOwnerId = '';
    state.activeUserEmail = '';
    state.activeChannelTitle = '';
    (async () => {
      try {
        await chrome.storage.local.remove(['activeOwnerId', 'activeUserEmail', 'activeChannelTitle']);
        // Evict stale token from L2 before re-auth
        await evictCachedToken(ownerIdToEvict);
        const token = await getAuthToken(true);
        const ownerId = await resolveActiveOwnerId();
        sendResponse({ status: 'completed', activeOwnerId: ownerId });
      } catch (err) {
        sendResponse({ status: 'failed', error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'START_SAMPLE_SYNC') {
    (async () => {
      try {
        state.activeOwnerId = 'sample_user';
        await chrome.storage.local.set({ activeOwnerId: 'sample_user' });
        const db = await openDB();
        
        const sampleSubs = [
          { id: 'UC_sample_tech1', subscriptionId: 'sub_tech1', title: 'Tech Review Planet', subscribed_at: new Date('2021-01-15T12:00:00Z').getTime(), syncedAt: new Date().toISOString() },
          { id: 'UC_sample_music2', subscriptionId: 'sub_music2', title: 'Acoustic Vibe Session', subscribed_at: new Date('2019-06-20T12:00:00Z').getTime(), syncedAt: new Date().toISOString() },
          { id: 'UC_sample_game3', subscriptionId: 'sub_game3', title: 'Retro Gaming Club', subscribed_at: new Date('2023-11-02T12:00:00Z').getTime(), syncedAt: new Date().toISOString() },
          { id: 'UC_sample_cook4', subscriptionId: 'sub_cook4', title: 'Daily Chef Recipe', subscribed_at: new Date('2022-03-10T12:00:00Z').getTime(), syncedAt: new Date().toISOString() },
          { id: 'UC_sample_zombie5', subscriptionId: 'sub_zombie5', title: 'Abandoned Vlogs', subscribed_at: new Date('2015-08-05T12:00:00Z').getTime(), syncedAt: new Date().toISOString() },
          { id: 'UC_sample_zombie6', subscriptionId: 'sub_zombie6', title: 'Inactive Tech News', subscribed_at: new Date('2018-02-12T12:00:00Z').getTime(), syncedAt: new Date().toISOString() }
        ];
        
        const sampleChannels = [
          {
            id: 'UC_sample_tech1',
            title: 'Tech Review Planet',
            description: 'Latest technology reviews, specs, and tutorials.',
            customUrl: '@techreviewplanet',
            thumbnail: 'https://images.unsplash.com/photo-1519389950473-47ba0277781c?auto=format&fit=crop&w=150&q=80',
            uploadsPlaylistId: 'UU_sample_tech1',
            view_count: 1500000,
            subscriber_count: 250000,
            video_count: 420,
            mappedCategory: '과학/기술',
            topicCategories: ['https://en.wikipedia.org/wiki/Technology', 'https://en.wikipedia.org/wiki/Knowledge'],
            subscribed_at: new Date('2021-01-15T12:00:00Z').getTime(),
            syncedAt: new Date().toISOString(),
            last_uploaded_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).getTime(),
            last_synced_at: Date.now(),
            status_flag: 'SUBSCRIBED',
            first_registered_at: new Date('2021-01-15T12:00:00Z').getTime()
          },
          {
            id: 'UC_sample_music2',
            title: 'Acoustic Vibe Session',
            description: 'Chill acoustic covers and original songs.',
            customUrl: '@acousticvibes',
            thumbnail: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=150&q=80',
            uploadsPlaylistId: 'UU_sample_music2',
            view_count: 8900000,
            subscriber_count: 1200000,
            video_count: 150,
            mappedCategory: '음악',
            topicCategories: ['https://en.wikipedia.org/wiki/Music', 'https://en.wikipedia.org/wiki/Pop_music'],
            subscribed_at: new Date('2019-06-20T12:00:00Z').getTime(),
            syncedAt: new Date().toISOString(),
            last_uploaded_at: new Date(Date.now() - 12 * 24 * 3600 * 1000).getTime(),
            last_synced_at: Date.now(),
            status_flag: 'SUBSCRIBED',
            first_registered_at: new Date('2019-06-20T12:00:00Z').getTime()
          },
          {
            id: 'UC_sample_game3',
            title: 'Retro Gaming Club',
            description: 'Gameplay walkthroughs and reviews of classic 80s/90s games.',
            customUrl: '@retrogamingclub',
            thumbnail: 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?auto=format&fit=crop&w=150&q=80',
            uploadsPlaylistId: 'UU_sample_game3',
            view_count: 45000,
            subscriber_count: 3500,
            video_count: 75,
            mappedCategory: '게임',
            topicCategories: ['https://en.wikipedia.org/wiki/Gaming', 'https://en.wikipedia.org/wiki/Action_game'],
            subscribed_at: new Date('2023-11-02T12:00:00Z').getTime(),
            syncedAt: new Date().toISOString(),
            last_uploaded_at: new Date(Date.now() - 95 * 24 * 3600 * 1000).getTime(),
            last_synced_at: Date.now(),
            status_flag: 'SUBSCRIBED',
            first_registered_at: new Date('2023-11-02T12:00:00Z').getTime()
          },
          {
            id: 'UC_sample_cook4',
            title: 'Daily Chef Recipe',
            description: 'Quick and easy home cooking recipes.',
            customUrl: '@dailychefrecipe',
            thumbnail: 'https://images.unsplash.com/photo-1556910103-1c02745aae4d?auto=format&fit=crop&w=150&q=80',
            uploadsPlaylistId: 'UU_sample_cook4',
            view_count: 320000,
            subscriber_count: 48000,
            video_count: 110,
            mappedCategory: '실용/노하우',
            topicCategories: ['https://en.wikipedia.org/wiki/Food', 'https://en.wikipedia.org/wiki/Lifestyle'],
            subscribed_at: new Date('2022-03-10T12:00:00Z').getTime(),
            syncedAt: new Date().toISOString(),
            last_uploaded_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).getTime(),
            last_synced_at: Date.now(),
            status_flag: 'SUBSCRIBED',
            first_registered_at: new Date('2022-03-10T12:00:00Z').getTime()
          },
          {
            id: 'UC_sample_zombie5',
            title: 'Abandoned Vlogs',
            description: 'Vlogging in various places around the world.',
            customUrl: '@abandonedvlogs',
            thumbnail: 'https://images.unsplash.com/photo-1501504905252-473c47e087f8?auto=format&fit=crop&w=150&q=80',
            uploadsPlaylistId: 'UU_sample_zombie5',
            view_count: 12000,
            subscriber_count: 1500,
            video_count: 22,
            mappedCategory: '여행/이벤트',
            topicCategories: ['https://en.wikipedia.org/wiki/Tourism', 'https://en.wikipedia.org/wiki/Lifestyle'],
            subscribed_at: new Date('2015-08-05T12:00:00Z').getTime(),
            syncedAt: new Date().toISOString(),
            last_uploaded_at: new Date(Date.now() - 420 * 24 * 3600 * 1000).getTime(),
            last_synced_at: Date.now(),
            status_flag: 'SUBSCRIBED',
            first_registered_at: new Date('2015-08-05T12:00:00Z').getTime()
          },
          {
            id: 'UC_sample_zombie6',
            title: 'Inactive Tech News',
            description: 'Old tech show archives.',
            customUrl: '@inactivetechnews',
            thumbnail: 'https://images.unsplash.com/photo-1498050108023-c5249f4df085?auto=format&fit=crop&w=150&q=80',
            uploadsPlaylistId: 'UU_sample_zombie6',
            view_count: 89000,
            subscriber_count: 95000,
            video_count: 850,
            mappedCategory: '과학/기술',
            topicCategories: ['https://en.wikipedia.org/wiki/Technology'],
            subscribed_at: new Date('2018-02-12T12:00:00Z').getTime(),
            syncedAt: new Date().toISOString(),
            last_uploaded_at: new Date(Date.now() - 650 * 24 * 3600 * 1000).getTime(),
            last_synced_at: Date.now(),
            status_flag: 'SUBSCRIBED',
            first_registered_at: new Date('2018-02-12T12:00:00Z').getTime()
          }
        ];
        
        const sampleVideos = [
          { id: 'vid_tech_1', target_channel_id: 'UC_sample_tech1', title: 'Top 5 Tech Gadgets in 2026', uploaded_at: new Date(Date.now() - 5 * 24 * 3600 * 1000).getTime(), thumbnail: 'https://images.unsplash.com/photo-1526738549149-8e07eca6c147?auto=format&fit=crop&w=120&q=80', syncedAt: new Date().toISOString() },
          { id: 'vid_tech_2', target_channel_id: 'UC_sample_tech1', title: 'Is this the best laptop of the year?', uploaded_at: new Date(Date.now() - 15 * 24 * 3600 * 1000).getTime(), thumbnail: 'https://images.unsplash.com/photo-1496181130204-7552cc14b1b0?auto=format&fit=crop&w=120&q=80', syncedAt: new Date().toISOString() },
          { id: 'vid_music_1', target_channel_id: 'UC_sample_music2', title: 'Acoustic Guitar Cover of Popular Pop Hits', uploaded_at: new Date(Date.now() - 12 * 24 * 3600 * 1000).getTime(), thumbnail: 'https://images.unsplash.com/photo-1510915361894-db8b60106cb1?auto=format&fit=crop&w=120&q=80', syncedAt: new Date().toISOString() },
          { id: 'vid_game_1', target_channel_id: 'UC_sample_game3', title: 'Super Mario Bros Speedrun Attempt', uploaded_at: new Date(Date.now() - 95 * 24 * 3600 * 1000).getTime(), thumbnail: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?auto=format&fit=crop&w=120&q=80', syncedAt: new Date().toISOString() },
          { id: 'vid_cook_1', target_channel_id: 'UC_sample_cook4', title: 'Perfect Carbonara in 15 Minutes', uploaded_at: new Date(Date.now() - 2 * 24 * 3600 * 1000).getTime(), thumbnail: 'https://images.unsplash.com/photo-1612874742237-6526221588e3?auto=format&fit=crop&w=120&q=80', syncedAt: new Date().toISOString() },
          { id: 'vid_zombie_1', target_channel_id: 'UC_sample_zombie5', title: 'Vlogging in Abandoned Castle', uploaded_at: new Date(Date.now() - 420 * 24 * 3600 * 1000).getTime(), thumbnail: 'https://images.unsplash.com/photo-1524397058842-7604e9027aa0?auto=format&fit=crop&w=120&q=80', syncedAt: new Date().toISOString() },
          { id: 'vid_zombie_2', target_channel_id: 'UC_sample_zombie6', title: 'Classic Tech Show Archive Ep 54', uploaded_at: new Date(Date.now() - 650 * 24 * 3600 * 1000).getTime(), thumbnail: 'https://images.unsplash.com/photo-1547082299-de196ea013d6?auto=format&fit=crop&w=120&q=80', syncedAt: new Date().toISOString() }
        ];

        const subTx = db.transaction(['youtube_subscriptions'], 'readwrite');
        const subStore = subTx.objectStore('youtube_subscriptions');
        for (const item of sampleSubs) subStore.put(item);
        
        const chTx = db.transaction(['channels_master'], 'readwrite');
        const chStore = chTx.objectStore('channels_master');
        for (const item of sampleChannels) chStore.put(item);
        
        const vidTx = db.transaction(['video_preview_cache'], 'readwrite');
        const vidStore = vidTx.objectStore('video_preview_cache');
        for (const item of sampleVideos) vidStore.put(item);

        db.close();

        await chrome.storage.local.set({
          syncStatus: 'STEP3_COMPLETED',
          totalChannels: sampleSubs.length,
          currentStep2Chunk: 1,
          totalStep2Chunks: 1,
          step2ProcessedCount: sampleSubs.length,
          currentStep3Index: sampleSubs.length,
          totalStep3Channels: sampleSubs.length,
          timestamp: new Date().toISOString()
        });

        sendResponse({ status: 'completed' });
      } catch (err) {
        console.error("Failed to sync sample data:", err);
        sendResponse({ status: 'failed', error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
    sendResponse({ status: 'completed' });
    return true;
  }

  if (message.action === 'REFRESH_SUBSCRIPTION_LIST') {
    (async () => {
      try {
        await reconcileSubscriptions();
        sendResponse({ status: 'completed' });
      } catch (error) {
        sendResponse({ status: 'failed', error: error.message });
      }
    })();
    return true;
  }
  
  // [REFRESH_VIDEOS_BATCH removed] — superseded by background ingestion queue

  if (message.action === 'START_INGESTION_QUEUE') {
    // Fire-and-forget: populate ingestion_queue from channels_master and start.
    // Returns {status:'queued', total} immediately so the dashboard can unblock.
    (async () => {
      try {
        const db = await openDB();
        const tx = db.transaction(['channels_master'], 'readonly');
        const allChannels = await new Promise((res) => {
          const req = tx.objectStore('channels_master').getAll();
          req.onsuccess = () => res(req.result || []);
          req.onerror   = () => res([]);
        });
        db.close();

        const targets = allChannels.filter(c =>
          (c.status_flag === 'SUBSCRIBED' || c.status_flag === 'PENDING') &&
          (!c.last_uploaded_at)
        );

        const ingestion_queue = targets.map(c => ({
          id:     c.id,
          handle: c.customUrl || c.handle || '',
          title:  c.title || c.id,
          status: 'pending'
        }));

        await chrome.storage.local.set({ ingestion_queue });
        chrome.alarms.create('INGESTION_QUEUE_WATCHDOG', { periodInMinutes: 1 });
        processIngestionQueue(); // intentionally not awaited
        sendResponse({ status: 'queued', total: ingestion_queue.length });
      } catch (err) {
        console.error('[Ingestion] START_INGESTION_QUEUE error:', err);
        sendResponse({ status: 'error', error: err.message });
      }
    })();
    return true;
  }

  if (message.action === 'RESET_INGESTION_QUEUE') {
    // Force-re-queue ALL subscribed channels regardless of existing last_uploaded_at.
    (async () => {
      try {
        const db = await openDB();
        const tx = db.transaction(['channels_master'], 'readonly');
        const allChannels = await new Promise((res) => {
          const req = tx.objectStore('channels_master').getAll();
          req.onsuccess = () => res(req.result || []);
          req.onerror   = () => res([]);
        });
        db.close();

        const ingestion_queue = allChannels
          .filter(c => c.status_flag === 'SUBSCRIBED' || c.status_flag === 'PENDING')
          .map(c => ({
            id:     c.id,
            handle: c.customUrl || c.handle || '',
            title:  c.title || c.id,
            status: 'pending'
          }));

        await chrome.storage.local.set({ ingestion_queue });
        chrome.alarms.create('INGESTION_QUEUE_WATCHDOG', { periodInMinutes: 1 });
        processIngestionQueue(); // intentionally not awaited
        sendResponse({ status: 'queued', total: ingestion_queue.length });
      } catch (err) {
        sendResponse({ status: 'error', error: err.message });
      }
    })();
    return true;
  }
  
  // ============================================================
  // [SWITCH_ACTIVE_ACCOUNT] — Zero-popup profile switcher
  // Checks L2 token cache for target account. If fresh, warms
  // L1 and updates SW state without showing Google account picker.
  // ============================================================
  if (message.action === 'SWITCH_ACTIVE_ACCOUNT') {
    const { channelId, email, channelTitle } = message;
    (async () => {
      try {
        const cachedToken = await loadCachedToken(channelId);
        if (cachedToken) {
          // L2 hit — switch account silently with no OAuth popup
          memorySessionToken = cachedToken;
          state.activeOwnerId = channelId;
          state.activeUserEmail = email || '';
          state.activeChannelTitle = channelTitle || '';
          await chrome.storage.local.set({
            activeOwnerId: channelId,
            activeUserEmail: email || '',
            activeChannelTitle: channelTitle || ''
          });
          sendResponse({ status: 'cached' });
        } else {
          // L2 miss — need fresh OAuth flow
          memorySessionToken = null;
          state.activeOwnerId = channelId;
          state.activeUserEmail = email || '';
          state.activeChannelTitle = channelTitle || '';
          await chrome.storage.local.set({
            activeOwnerId: channelId,
            activeUserEmail: email || '',
            activeChannelTitle: channelTitle || ''
          });
          sendResponse({ status: 'needs_auth' });
        }
      } catch (err) {
        sendResponse({ status: 'needs_auth' });
      }
    })();
    return true;
  }

  // ============================================================
  // [EXECUTE_MIGRATION_CART] — Async queue enqueue (replaces blocking loop)
  // Copies global_migration_cart into migration_queue with status:'pending',
  // launches processMigrationQueue() in the background, and returns immediately.
  // The dashboard tab can be safely closed during the entire migration run.
  // ============================================================
  if (message.action === 'EXECUTE_MIGRATION_CART') {
    const { ownerId } = message;
    (async () => {
      try {
        const data = await chrome.storage.local.get(['global_migration_cart']);
        const cart = data.global_migration_cart || [];

        if (cart.length === 0) {
          sendResponse({ status: 'queued', total: 0 });
          return;
        }

        // Filter out channels already SUBSCRIBED in the active account DB
        const db = await openDB(ownerId);
        const tx = db.transaction(['channels_master'], 'readonly');
        const store = tx.objectStore('channels_master');
        const allChannels = await new Promise((res) => {
          const req = store.getAll();
          req.onsuccess = () => res(req.result || []);
          req.onerror  = () => res([]);
        });
        db.close();

        const subscribedIds = new Set(
          allChannels.filter(c => c.status_flag === 'SUBSCRIBED').map(c => c.id)
        );
        const pendingItems = cart.filter(item => !subscribedIds.has(item.id));

        // Build the persistent queue — any existing queue is overwritten
        const migration_queue = pendingItems.map(item => ({
          id: item.id,
          title: item.title || item.id,
          status: 'pending',
          ownerId: ownerId || ''
        }));

        await chrome.storage.local.set({ migration_queue });

        // Arm the 1-minute watchdog alarm so Chrome SW sleep cannot stall the queue
        chrome.alarms.create('MIGRATION_QUEUE_WATCHDOG', { periodInMinutes: 1 });

        // Return to dashboard immediately — do NOT await the loop
        sendResponse({ status: 'queued', total: pendingItems.length });

        // Launch queue processor asynchronously
        processMigrationQueue();

      } catch (err) {
        console.error('[MigrationQueue] Enqueue error:', err);
        sendResponse({ status: 'failed', error: err.message });
      }
    })();
    return true;
  }

  // Resume an already-queued migration (e.g. dashboard reopen, manual retry)
  if (message.action === 'START_QUEUE_PROCESS') {
    (async () => {
      const { migration_queue = [] } = await chrome.storage.local.get(['migration_queue']);
      if (migration_queue.some(q => q.status === 'pending')) {
        chrome.alarms.create('MIGRATION_QUEUE_WATCHDOG', { periodInMinutes: 1 });
        processMigrationQueue();
        sendResponse({ status: 'started', total: migration_queue.length });
      } else {
        sendResponse({ status: 'idle' });
      }
    })();
    return true;
  }

  if (message.action === 'GET_SYNC_STATUS') {
    chrome.storage.local.get([
      'syncStatus', 
      'pausedFrom',
      'totalChannels',
      'currentStep2Chunk', 
      'totalStep2Chunks', 
      'step2ProcessedCount',
      'currentStep3Index', 
      'totalStep3Channels',
      'timestamp', 
      'error'
    ], (res) => {
      sendResponse(res);
    });
    return true;
  }
});

async function fetchAllSubscriptionsFromAPI() {
  let apiSubscriptions = [];
  let nextPageToken = '';
  do {
    const url = `https://www.googleapis.com/youtube/v3/subscriptions?part=snippet,contentDetails&mine=true&maxResults=50${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;
    const data = await fetchYouTubeAPI(url, false);
    if (data.items) {
      for (const item of data.items) {
        const id = item.snippet?.resourceId?.channelId;
        if (id) {
          apiSubscriptions.push(item);
        }
      }
    }
    nextPageToken = data.nextPageToken || '';
  } while (nextPageToken);
  return apiSubscriptions;
}

async function reconcileSubscriptions() {
  const apiItems = await fetchAllSubscriptionsFromAPI();
  const apiIds = new Set(apiItems.map(item => item.snippet?.resourceId?.channelId).filter(Boolean));
  
  const db = await openDB();
  const tx = db.transaction(['channels_master'], 'readwrite');
  const store = tx.objectStore('channels_master');
  const localChannels = await new Promise((res, reject) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror = () => reject(req.error);
  });
  
  const localMap = new Map(localChannels.map(c => [c.id, c]));
  
  for (const item of apiItems) {
    const chId = item.snippet?.resourceId?.channelId;
    if (!chId) continue;
    const title = item.snippet?.title || '';
    const thumbnail = item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || '';
    const subscribedAt = item.snippet?.publishedAt ? new Date(item.snippet.publishedAt).getTime() : Date.now();
    
    if (!localMap.has(chId)) {
      const newChan = {
        id: chId,
        title: title,
        description: item.snippet?.description || '',
        customUrl: '',
        thumbnail: thumbnail,
        uploadsPlaylistId: `UU${chId.substring(2)}`,
        view_count: 0,
        subscriber_count: 0,
        video_count: 0,
        mappedCategory: '미분류',
        topicCategories: [],
        subscribed_at: subscribedAt,
        syncedAt: new Date().toISOString(),
        last_synced_at: Date.now(),
        status_flag: 'SUBSCRIBED',
        first_registered_at: Date.now(),
        raw_api_payload: item
      };
      store.put(newChan);
    } else {
      const local = localMap.get(chId);
      if (!local.first_registered_at) {
        local.first_registered_at = Date.now();
      }
      if (local.status_flag === 'UNSUBSCRIBED') {
        local.status_flag = 'SUBSCRIBED';
        local.last_synced_at = Date.now();
      }
      local.raw_api_payload = item;
      store.put(local);
    }
  }
  
  for (const local of localChannels) {
    if ((local.status_flag === 'SUBSCRIBED' || local.status_flag === 'PENDING') && !apiIds.has(local.id)) {
      local.status_flag = 'UNSUBSCRIBED';
      local.last_synced_at = Date.now();
      store.put(local);
    }
  }
  
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  
  db.close();
  await updateAccountLedger(state.activeOwnerId, state.activeUserEmail, state.activeChannelTitle);
}

// [refreshVideosForTop20 removed] — superseded by processIngestionQueue()
