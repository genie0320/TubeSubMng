// Tube Manager Dashboard Injection Script

window.showTubeManagerDashboard = function() {
  if (document.getElementById('tube-manager-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'tube-manager-overlay';

  const style = document.createElement('style');
  style.id = 'tube-manager-styles';
  style.textContent = `
    #tube-manager-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      z-index: 99999;
      background: rgba(10, 10, 12, 0.75);
      backdrop-filter: blur(25px) saturate(180%);
      -webkit-backdrop-filter: blur(25px) saturate(180%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #FFFFFF;
      opacity: 0;
      transition: all 0.4s cubic-bezier(0.25, 1, 0.5, 1);
    }
    
    .tm-container {
      width: 540px;
      max-height: 90vh;
      background: rgba(25, 25, 30, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      padding: 40px;
      text-align: center;
      box-shadow: 0 30px 60px rgba(0, 0, 0, 0.5);
      transform: translateY(20px);
      transition: all 0.5s cubic-bezier(0.25, 1, 0.5, 1);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }

    .tm-container.expanded {
      width: 960px;
      height: 800px;
    }
    
    .tm-close-btn {
      position: absolute;
      top: 24px;
      right: 24px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #FFFFFF;
      border-radius: 50%;
      width: 44px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 20px;
      transition: all 0.2s ease;
    }
    
    .tm-close-btn:hover {
      background: rgba(255, 255, 255, 0.15);
      transform: rotate(90deg);
    }
    
    .tm-logo-area {
      margin-bottom: 20px;
    }
    
    .tm-logo {
      background: linear-gradient(135deg, #E63946, #D62246);
      width: 56px;
      height: 56px;
      border-radius: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 8px 20px rgba(230, 57, 70, 0.35);
      margin-bottom: 12px;
    }
    
    .tm-title {
      font-size: 22px;
      font-weight: 800;
      margin: 0 0 6px 0;
      letter-spacing: -0.5px;
    }
    
    .tm-description {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.6);
      margin-bottom: 24px;
      line-height: 1.5;
    }

    .tm-pipeline-step {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 16px;
      text-align: left;
      transition: all 0.3s ease;
    }

    .tm-pipeline-step.disabled {
      opacity: 0.35;
      pointer-events: none;
    }

    .tm-step-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .tm-step-badge {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      font-weight: 700;
      background: rgba(255, 255, 255, 0.08);
      padding: 3px 8px;
      border-radius: 6px;
      color: rgba(255, 255, 255, 0.6);
    }

    .tm-pipeline-step.active .tm-step-badge {
      background: rgba(230, 57, 70, 0.15);
      color: #E63946;
    }

    .tm-step-title {
      font-size: 15px;
      font-weight: 700;
    }

    .tm-step-status {
      font-size: 12px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.5);
    }

    .tm-divider {
      height: 1px;
      background: rgba(255, 255, 255, 0.06);
      margin: 12px 0;
    }
    
    .tm-action-btn {
      width: 100%;
      background: linear-gradient(135deg, #E63946, #D62246);
      color: #FFFFFF;
      border: none;
      border-radius: 12px;
      padding: 12px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(230, 57, 70, 0.3);
      transition: all 0.3s cubic-bezier(0.25, 1, 0.5, 1);
    }
    
    .tm-action-btn:hover {
      transform: translateY(-1px);
      box-shadow: 0 8px 20px rgba(230, 57, 70, 0.45);
      filter: brightness(1.08);
    }

    .tm-action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none;
      box-shadow: none;
    }

    .tm-secondary-btn {
      width: 100%;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #FFFFFF;
      border-radius: 12px;
      padding: 10px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .tm-secondary-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }

    .tm-drop-zone {
      border: 2px dashed rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      padding: 16px;
      text-align: center;
      cursor: pointer;
      background: rgba(255, 255, 255, 0.01);
      transition: all 0.2s ease;
    }

    .tm-drop-zone:hover {
      border-color: #E63946;
      background: rgba(230, 57, 70, 0.03);
    }

    .tm-drop-text {
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 2px;
    }

    .tm-drop-subtext {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.4);
    }
    
    .tm-progress-container {
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 3px;
      margin-top: 10px;
      overflow: hidden;
    }

    .tm-progress-bar {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #E63946, #D62246);
      border-radius: 3px;
      transition: width 0.3s ease;
    }
    
    .tm-result-message {
      margin-top: 12px;
      font-size: 13px;
      color: rgba(255, 255, 255, 0.5);
      min-height: 20px;
    }

    /* Finished Dashboard Styles */
    .tm-results-dashboard {
      display: flex;
      flex-direction: column;
      height: 100%;
      text-align: left;
    }

    .tm-results-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }

    .tm-results-summary {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.7);
    }

    .tm-results-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 20px;
      overflow-y: auto;
      padding-right: 6px;
      max-height: 540px;
    }

    .tm-channel-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      transition: all 0.2s ease;
    }

    .tm-channel-card:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.12);
      transform: translateY(-2px);
    }

    .tm-card-profile {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .tm-channel-avatar {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: #E63946;
      font-size: 20px;
      overflow: hidden;
      flex-shrink: 0;
    }

    .tm-channel-info {
      min-width: 0;
    }

    .tm-channel-title {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .tm-channel-meta {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.5);
    }

    .tm-channel-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(230, 57, 70, 0.15);
      color: #E63946;
      font-weight: 600;
      display: inline-block;
    }

    .tm-card-videos-label {
      font-size: 11px;
      font-weight: 700;
      color: rgba(255, 255, 255, 0.4);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .tm-card-videos-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .tm-card-video-item {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.6);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .tm-card-video-item::before {
      content: "•";
      color: #E63946;
    }
  `;

  document.head.appendChild(style);

  overlay.innerHTML = `
    <button class="tm-close-btn" id="tm-close" aria-label="Close">&times;</button>
    <div class="tm-container" id="tm-container">
      <div id="tm-pipeline-view" style="display: block;">
        <div class="tm-logo-area">
          <div class="tm-logo">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z" fill="#FFFFFF"/>
            </svg>
          </div>
          <h2 class="tm-title">유령 채널 정리 파이프라인</h2>
          <p class="tm-description">총 3단계의 분할 데이터 적재 구조를 통해<br>구독 목록 활동성 검사를 단계별로 실행합니다.</p>
        </div>
        
        <!-- Step 1 Layout -->
        <div class="tm-pipeline-step active" id="step-1-card">
          <div class="tm-step-header">
            <div class="tm-step-title">1단계: 구독 채널 목록 확보</div>
            <span class="tm-step-badge">마스터 데이터</span>
          </div>
          <p class="tm-channel-meta" style="margin-bottom: 12px;">구글 테이크아웃 JSON 파일을 직접 업로드하거나 실시간 구글 연동을 시작합니다.</p>
          <div id="step-1-controls">
            <button class="tm-action-btn" id="tm-step1-api" style="margin-bottom: 10px;">구글 API로 구독 채널 연동</button>
            <div class="tm-drop-zone" id="tm-step1-drop-zone">
              <div class="tm-drop-text">subscriptions.json 파일 업로드</div>
              <div class="tm-drop-subtext">드래그 앤 드롭 또는 클릭하여 선택</div>
              <input type="file" id="tm-step1-file-input" accept=".json" style="display: none;">
            </div>
            <button class="tm-secondary-btn" id="tm-step1-sample" style="margin-top: 10px;">샘플 데이터로 바로 테스트하기</button>
          </div>
          <div class="tm-step-status" id="step1-status" style="margin-top: 10px; display: none;"></div>
        </div>

        <!-- Step 2 Layout -->
        <div class="tm-pipeline-step disabled" id="step-2-card">
          <div class="tm-step-header">
            <div class="tm-step-title">2단계: 채널 세부정보 동기화</div>
            <span class="tm-step-badge">배치 수집</span>
          </div>
          <p class="tm-channel-meta" style="margin-bottom: 12px;">IndexedDB에 확보된 채널들의 지표(구독자수, 업로드 재생목록 ID, 관련 정보 등)를 50개 단위 청크로 배치 수집합니다.</p>
          <button class="tm-action-btn" id="tm-step2-start">채널 세부정보 동기화</button>
          <div id="step2-progress-area" style="display: none;">
            <div class="tm-progress-container">
              <div class="tm-progress-bar" id="step2-progress-bar"></div>
            </div>
            <div class="tm-step-status" id="step2-status" style="margin-top: 8px;">대기 중...</div>
            <button class="tm-secondary-btn tm-pause-btn" style="margin-top: 8px; font-size: 11px; padding: 6px 12px; width: auto; display: inline-block;">수집 일시중지</button>
          </div>
        </div>

        <!-- Step 3 Layout -->
        <div class="tm-pipeline-step disabled" id="step-3-card">
          <div class="tm-step-header">
            <div class="tm-step-title">3단계: 최신 활동 데이터 수집</div>
            <span class="tm-step-badge">활동 분석</span>
          </div>
          <p class="tm-channel-meta" style="margin-bottom: 12px;">동기화된 재생목록(UU~) 데이터에서 최근 5개 비디오의 업로드 타임스탬프를 읽어 최종 활동 로그를 빌드합니다.</p>
          <button class="tm-action-btn" id="tm-step3-start">최신 활동 데이터 수집</button>
          <div id="step3-progress-area" style="display: none;">
            <div class="tm-progress-container">
              <div class="tm-progress-bar" id="step3-progress-bar"></div>
            </div>
            <div class="tm-step-status" id="step3-status" style="margin-top: 8px;">대기 중...</div>
            <button class="tm-secondary-btn tm-pause-btn" style="margin-top: 8px; font-size: 11px; padding: 6px 12px; width: auto; display: inline-block;">수집 일시중지</button>
          </div>
        </div>

        <div class="tm-result-message" id="tm-pipeline-message"></div>
        <button class="tm-secondary-btn" id="tm-reset-pipeline-view" style="margin-top: 16px; background: rgba(230, 57, 70, 0.1); border-color: rgba(230, 57, 70, 0.3); color: #E63946;">파이프라인 전체 초기화</button>
      </div>
      
      <div id="tm-results-view" style="display: none; height: 100%;"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  requestAnimationFrame(() => {
    overlay.style.opacity = '1';
    document.getElementById('tm-container').style.transform = 'translateY(0)';
  });

  // IndexedDB helpers in page context
  function getFromStore(storeName) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('TubeManagerDB', 4);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        try {
          const transaction = db.transaction([storeName], 'readonly');
          const store = transaction.objectStore(storeName);
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        } catch (err) {
          resolve([]);
        }
      };
    });
  }

  // Safe messaging wrapper to gracefully handle context invalidation
  function safeSendMessage(message, callback) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
      const statusMsg = document.getElementById('tm-pipeline-message');
      if (statusMsg) {
        statusMsg.style.color = '#E63946';
        statusMsg.textContent = '확장 프로그램이 새로고침되었습니다. 변경 사항을 적용하려면 YouTube 페이지를 새로고침(F5)해주세요.';
      }
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) {
          console.warn("Message delivery error:", chrome.runtime.lastError.message);
        }
        if (callback) callback(res);
      });
    } catch (e) {
      console.error("Failed to send message:", e);
      const statusMsg = document.getElementById('tm-pipeline-message');
      if (statusMsg) {
        statusMsg.style.color = '#E63946';
        statusMsg.textContent = '확장 프로그램이 새로고침되었습니다. 변경 사항을 적용하려면 YouTube 페이지를 새로고침(F5)해주세요.';
      }
    }
  }

  // Update overlay based on cached step states in chrome.storage.local
  async function restorePipelineStates() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
      clearInterval(pollInterval);
      const statusMsg = document.getElementById('tm-pipeline-message');
      if (statusMsg) {
        statusMsg.style.color = '#E63946';
        statusMsg.textContent = '확장 프로그램이 새로고침되었습니다. 변경 사항을 적용하려면 YouTube 페이지를 새로고침(F5)해주세요.';
      }
      return;
    }
    
    try {
      const state = await chrome.storage.local.get([
        'syncStatus',
        'pausedFrom',
        'totalChannels',
        'currentStep2Chunk',
        'totalStep2Chunks',
        'currentStep3Index',
        'totalStep3Channels'
      ]);

      const status = state.syncStatus || 'idle';
      const total = state.totalChannels || 0;
      const pausedFrom = state.pausedFrom || '';

      const step1Card = document.getElementById('step-1-card');
      const step2Card = document.getElementById('step-2-card');
      const step3Card = document.getElementById('step-3-card');
      
      const s1Status = document.getElementById('step1-status');
      const s1Controls = document.getElementById('step-1-controls');

      if (status.startsWith('STEP1_COMPLETED') || status === 'STEP2_IN_PROGRESS' || status === 'STEP2_COMPLETED' || status.startsWith('STEP3') || (status === 'paused' && (pausedFrom.startsWith('STEP2') || pausedFrom.startsWith('STEP3')))) {
        step1Card.classList.remove('active');
        s1Controls.style.display = 'none';
        s1Status.style.display = 'block';
        s1Status.style.color = '#38B000';
        s1Status.textContent = `✓ 1단계 완료: 구독 채널 ${total}개 확보`;

        // Enable Step 2
        step2Card.classList.remove('disabled');
        step2Card.classList.add('active');
      }

      if (status === 'STEP2_IN_PROGRESS') {
        const progressArea = document.getElementById('step2-progress-area');
        const progressBar = document.getElementById('step2-progress-bar');
        const progressText = document.getElementById('step2-status');
        const startBtn = document.getElementById('tm-step2-start');
        
        startBtn.style.display = 'none';
        progressArea.style.display = 'block';
        
        const chunk = state.currentStep2Chunk || 0;
        const totalChunks = state.totalStep2Chunks || 0;
        const percent = totalChunks > 0 ? Math.round((chunk / totalChunks) * 100) : 0;
        
        progressBar.style.width = `${percent}%`;
        progressText.style.color = '#FFFFFF';
        progressText.textContent = `상세 수집 중... ${percent}% (${chunk}/${totalChunks} 청크 완료)`;

        const pauseBtn = document.querySelector('#step-2-card .tm-pause-btn');
        if (pauseBtn) {
          pauseBtn.style.display = 'inline-block';
          pauseBtn.textContent = '수집 일시중지';
        }
      }

      if (status === 'paused' && pausedFrom === 'STEP2_IN_PROGRESS') {
        const progressArea = document.getElementById('step2-progress-area');
        const progressBar = document.getElementById('step2-progress-bar');
        const progressText = document.getElementById('step2-status');
        const startBtn = document.getElementById('tm-step2-start');
        
        startBtn.style.display = 'block';
        startBtn.textContent = '동기화 재개';
        progressArea.style.display = 'block';
        
        const chunk = state.currentStep2Chunk || 0;
        const totalChunks = state.totalStep2Chunks || 0;
        const percent = totalChunks > 0 ? Math.round((chunk / totalChunks) * 100) : 0;
        
        progressBar.style.width = `${percent}%`;
        progressText.style.color = '#FFB703';
        progressText.textContent = `일시중지됨 (${percent}%, ${chunk}/${totalChunks} 청크)`;

        const pauseBtn = document.querySelector('#step-2-card .tm-pause-btn');
        if (pauseBtn) pauseBtn.style.display = 'none';
      }

      if (status === 'STEP2_COMPLETED' || status.startsWith('STEP3') || (status === 'paused' && pausedFrom.startsWith('STEP3'))) {
        step2Card.classList.remove('active', 'disabled');
        document.getElementById('tm-step2-start').style.display = 'none';
        const progressArea = document.getElementById('step2-progress-area');
        progressArea.style.display = 'block';
        document.getElementById('step2-progress-bar').style.width = '100%';
        document.getElementById('step2-status').style.color = '#38B000';
        document.getElementById('step2-status').textContent = `✓ 2단계 완료: 메타데이터 배치 적재 완료`;

        // Enable Step 3
        step3Card.classList.remove('disabled');
        step3Card.classList.add('active');
      }

      if (status === 'STEP3_IN_PROGRESS') {
        const progressArea = document.getElementById('step3-progress-area');
        const progressBar = document.getElementById('step3-progress-bar');
        const progressText = document.getElementById('step3-status');
        const startBtn = document.getElementById('tm-step3-start');
        
        startBtn.style.display = 'none';
        progressArea.style.display = 'block';
        
        const idx = state.currentStep3Index || 0;
        const totalCh = state.totalStep3Channels || 0;
        const percent = totalCh > 0 ? Math.round((idx / totalCh) * 100) : 0;
        
        progressBar.style.width = `${percent}%`;
        progressText.style.color = '#FFFFFF';
        progressText.textContent = `영상 분석 중... ${percent}% (${idx}/${totalCh} 채널 완료)`;

        const pauseBtn = document.querySelector('#step-3-card .tm-pause-btn');
        if (pauseBtn) {
          pauseBtn.style.display = 'inline-block';
          pauseBtn.textContent = '수집 일시중지';
        }
      }

      if (status === 'paused' && pausedFrom === 'STEP3_IN_PROGRESS') {
        const progressArea = document.getElementById('step3-progress-area');
        const progressBar = document.getElementById('step3-progress-bar');
        const progressText = document.getElementById('step3-status');
        const startBtn = document.getElementById('tm-step3-start');
        
        startBtn.style.display = 'block';
        startBtn.textContent = '수집 재개';
        progressArea.style.display = 'block';
        
        const idx = state.currentStep3Index || 0;
        const totalCh = state.totalStep3Channels || 0;
        const percent = totalCh > 0 ? Math.round((idx / totalCh) * 100) : 0;
        
        progressBar.style.width = `${percent}%`;
        progressText.style.color = '#FFB703';
        progressText.textContent = `일시중지됨 (${percent}%, ${idx}/${totalCh} 채널)`;

        const pauseBtn = document.querySelector('#step-3-card .tm-pause-btn');
        if (pauseBtn) pauseBtn.style.display = 'none';
      }

      if (status === 'STEP3_COMPLETED' || status === 'STEP3_PARTIAL_COMPLETED') {
        const channels = await getFromStore('channels_master');
        const isSample = channels.length > 0 && channels.every(c => c.id.startsWith('UC_sample_'));
        if (!isSample) {
          renderCompletedDashboard();
        }
      }
    } catch (e) {
      console.warn("Context looks invalidated, stopping poller:", e);
      clearInterval(pollInterval);
      const statusMsg = document.getElementById('tm-pipeline-message');
      if (statusMsg) {
        statusMsg.style.color = '#E63946';
        statusMsg.textContent = '확장 프로그램이 새로고침되었습니다. 변경 사항을 적용하려면 YouTube 페이지를 새로고침(F5)해주세요.';
      }
    }
  }

  // Poll state parameters while operations run in background
  let pollInterval = setInterval(restorePipelineStates, 1000);

  const cleanupAndClose = () => {
    clearInterval(pollInterval);
    overlay.style.opacity = '0';
    document.getElementById('tm-container').style.transform = 'translateY(20px)';
    overlay.addEventListener('transitionend', () => {
      overlay.remove();
      style.remove();
    }, { once: true });
  };

  document.getElementById('tm-close').addEventListener('click', cleanupAndClose);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanupAndClose();
  });

  const resetPipelineFunc = async () => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      try {
        await chrome.storage.local.clear();
      } catch (e) {
        console.warn("Storage clear context failure:", e);
      }
    }
    
    // Clear IndexedDB stores physically
    try {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('TubeManagerDB', 4);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          try {
            const tx = db.transaction(['youtube_subscriptions', 'channels_master', 'video_preview_cache'], 'readwrite');
            tx.objectStore('youtube_subscriptions').clear();
            tx.objectStore('channels_master').clear();
            tx.objectStore('video_preview_cache').clear();
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              reject(tx.error);
            };
          } catch (e) {
            db.close();
            resolve();
          }
        };
      });
      console.log("IndexedDB stores cleared successfully.");
    } catch (err) {
      console.error("Failed to clear IndexedDB stores:", err);
    }

    if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
      chrome.runtime.sendMessage({ action: 'REVOKE_AUTH_TOKEN' }, () => {
        location.reload();
      });
    } else {
      location.reload();
    }
  };

  document.getElementById('tm-reset-pipeline-view').addEventListener('click', resetPipelineFunc);

  // Action 1: API Step 1 Sync
  document.getElementById('tm-step1-api').addEventListener('click', () => {
    const statusMsg = document.getElementById('tm-pipeline-message');
    statusMsg.style.color = '#FFB703';
    statusMsg.textContent = '실시간 구독 API 호출 중...';

    safeSendMessage({ action: 'START_STEP_1_SYNC' }, (res) => {
      if (!res) return;
      if (res.status === 'completed') {
        statusMsg.style.color = '#38B000';
        statusMsg.textContent = '1단계 완료! 2단계로 진행해주세요.';
        restorePipelineStates();
      } else {
        statusMsg.style.color = '#E63946';
        statusMsg.textContent = `인증 오류: ${res.error}. 테이크아웃 JSON 파일을 직접 업로드해 우회해주십시오.`;
      }
    });
  });

  // Action 1-2: Sample Ingestion Trigger
  document.getElementById('tm-step1-sample').addEventListener('click', () => {
    const statusMsg = document.getElementById('tm-pipeline-message');
    statusMsg.style.color = '#FFB703';
    statusMsg.textContent = '샘플 데이터를 IndexedDB에 생성 중...';

    safeSendMessage({ action: 'START_SAMPLE_SYNC' }, (res) => {
      if (!res) return;
      if (res.status === 'completed') {
        statusMsg.style.color = '#38B000';
        statusMsg.textContent = '1단계 샘플 데이터 확보 완료! 2단계로 진행해주세요.';
        restorePipelineStates();
      } else {
        statusMsg.style.color = '#E63946';
        statusMsg.textContent = `샘플 생성 실패: ${res.error}`;
      }
    });
  });

  // Action 2: Drag/Drop JSON Upload Ingest
  const dropZone = document.getElementById('tm-step1-drop-zone');
  const fileInput = document.getElementById('tm-step1-file-input');
  
  dropZone.addEventListener('click', () => fileInput.click());

  const processTakeoutJSON = (file) => {
    if (!file) return;
    const statusMsg = document.getElementById('tm-pipeline-message');
    statusMsg.style.color = '#FFB703';
    statusMsg.textContent = 'JSON 텍스트 스트림을 백그라운드로 전달 중...';

    const reader = new FileReader();
    reader.onload = (event) => {
      safeSendMessage({
        action: 'IMPORT_TAKEOUT_JSON',
        jsonText: event.target.result
      }, (res) => {
        if (res && res.status === 'completed') {
          statusMsg.style.color = '#38B000';
          statusMsg.textContent = '테이크아웃 업로드 완료! 2단계를 실행하십시오.';
          restorePipelineStates();
        } else if (res) {
          statusMsg.style.color = '#E63946';
          statusMsg.textContent = `업로드 실패: ${res.error}`;
        }
      });
    };
    reader.readAsText(file);
  };

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) processTakeoutJSON(e.target.files[0]);
  });

  // Action 3: Step 2 Sync Trigger
  document.getElementById('tm-step2-start').addEventListener('click', () => {
    document.getElementById('tm-step2-start').style.display = 'none';
    document.getElementById('step-2-card').classList.add('active');
    document.getElementById('step2-progress-area').style.display = 'block';

    safeSendMessage({ action: 'START_STEP_2_SYNC' }, (res) => {
      if (res && res.status === 'completed') {
        restorePipelineStates();
      }
    });
  });

  // Action 4: Step 3 Sync Trigger
  document.getElementById('tm-step3-start').addEventListener('click', () => {
    document.getElementById('tm-step3-start').style.display = 'none';
    document.getElementById('step-3-card').classList.add('active');
    document.getElementById('step3-progress-area').style.display = 'block';

    safeSendMessage({ action: 'START_STEP_3_SYNC' }, (res) => {
      if (res && res.status === 'completed') {
        restorePipelineStates();
      }
    });
  });

  // Pause Action event wire-up
  const pauseBtns = overlay.querySelectorAll('.tm-pause-btn');
  pauseBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      safeSendMessage({ action: 'PAUSE_SYNC' }, (res) => {
        restorePipelineStates();
      });
    });
  });

  // Render finalized channel dashboard loading items from IndexedDB stores
  async function renderCompletedDashboard() {
    clearInterval(pollInterval);
    const container = document.getElementById('tm-container');
    const pipelineView = document.getElementById('tm-pipeline-view');
    const resultsView = document.getElementById('tm-results-view');

    pipelineView.style.display = 'none';
    resultsView.style.display = 'block';
    container.classList.add('expanded');

    // Fetch details and video activity logs
    const channels = await getFromStore('channels_master');
    const videos = await getFromStore('video_preview_cache');

    const state = await chrome.storage.local.get(['syncStatus', 'currentStep3Index', 'totalChannels']);
    const status = state.syncStatus || 'idle';
    const currentIdx = state.currentStep3Index || 0;
    const totalCount = state.totalChannels || channels.length;

    let syncMoreButtonHtml = '';
    let summaryText = `IndexedDB에 총 <span class="tm-highlight">${channels.length}개</span> 채널 메타데이터 및 비디오 분석 완료`;

    if (status === 'STEP3_PARTIAL_COMPLETED') {
      summaryText = `영상 분석 진행률: <span class="tm-highlight">${currentIdx} / ${totalCount}개 채널</span> 완료 (나머지 대기 중)`;
      syncMoreButtonHtml = `<button class="tm-action-btn" id="tm-sync-more" style="width: auto; padding: 10px 20px; background: linear-gradient(135deg, #FFB703, #FB8500); margin-right: 10px; box-shadow: 0 4px 15px rgba(251, 133, 0, 0.3);">나머지 50개 추가 분석</button>`;
    }

    // Group videos by channel ID
    const videosByChannel = {};
    for (const v of videos) {
      if (!videosByChannel[v.channelId]) videosByChannel[v.channelId] = [];
      if (videosByChannel[v.channelId].length < 5) {
        videosByChannel[v.channelId].push(v);
      }
    }

    resultsView.innerHTML = `
      <div class="tm-results-dashboard">
        <div class="tm-results-header">
          <div>
            <h2 class="tm-title" style="text-align: left; margin-bottom: 4px;">구독 채널 활동성 보고서</h2>
            <div class="tm-results-summary">
              ${summaryText}
            </div>
          </div>
          <div style="display: flex; align-items: center;">
            ${syncMoreButtonHtml}
            <button class="tm-action-btn" id="tm-reset-pipeline" style="width: auto; padding: 10px 20px;">파이프라인 재설정</button>
          </div>
        </div>
        
        <div class="tm-results-grid">
          ${channels.map(ch => {
            const chVids = videosByChannel[ch.id] || [];
            const initial = ch.title ? ch.title.charAt(0) : '?';
            return `
              <div class="tm-channel-card">
                <div class="tm-card-profile">
                  <div class="tm-channel-avatar">
                    ${ch.thumbnail ? `<img src="${ch.thumbnail}" alt="${ch.title}" style="width:100%;height:100%;object-fit:cover;">` : initial}
                  </div>
                  <div class="tm-channel-info">
                    <div class="tm-channel-title" title="${ch.title}">${ch.title}</div>
                    <div class="tm-channel-meta">${ch.mappedCategory || '테이크아웃 업로드'}</div>
                  </div>
                </div>
                
                <div class="tm-card-videos-label">최근 활동 영상</div>
                <div class="tm-card-videos-list">
                  ${chVids.length > 0 ? chVids.map(v => `
                    <div class="tm-card-video-item" title="${v.title}">${v.title}</div>
                  `).join('') : '<div class="tm-channel-meta">활동 로그 없음</div>'}
                </div>
                <div>
                  <span class="tm-channel-badge">유령 채널 후보</span>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;

    if (document.getElementById('tm-sync-more')) {
      document.getElementById('tm-sync-more').addEventListener('click', () => {
        const moreBtn = document.getElementById('tm-sync-more');
        moreBtn.disabled = true;
        moreBtn.textContent = '수집 중...';
        
        safeSendMessage({ action: 'START_STEP_3_SYNC' }, (res) => {
          location.reload();
        });
      });
    }

    document.getElementById('tm-reset-pipeline').addEventListener('click', async () => {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        try {
          await chrome.storage.local.clear();
        } catch (e) {
          console.warn("Storage clear context failure:", e);
        }
      }
      
      // Perform database deletion to wipe clean
      const delRequest = indexedDB.deleteDatabase('TubeManagerDB');
      delRequest.onsuccess = () => {
        console.log("Database deleted successfully during reset.");
        location.reload();
      };
      delRequest.onerror = () => {
        console.error("Failed to delete database during reset.");
        location.reload();
      };
    });
  }

  // Restore state on launch
  restorePipelineStates();
};
