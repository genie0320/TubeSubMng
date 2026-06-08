// Tube Manager Popup Script

async function updatePopupStatus() {
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const progressContainer = document.getElementById('progress-container');
  const progressBar = document.getElementById('progress-bar');
  const progressText = document.getElementById('progress-text');

  if (!statusDot || !statusText || !progressContainer || !progressBar || !progressText) return;

  try {
    // Query storage directly for progress sync state
    const state = await chrome.storage.local.get([
      'syncStatus',
      'currentChunk',
      'totalChunks',
      'totalChannels'
    ]);

    const status = state.syncStatus || 'idle';
    const current = state.currentChunk || 0;
    const total = state.totalChunks || 0;
    const totalCh = state.totalChannels || 0;

    // Reset status dot states
    statusDot.className = 'status-dot';

    if (status === 'syncing') {
      statusDot.classList.add('syncing');
      statusText.textContent = '분석 진행 중';
      statusText.style.color = '#FFB703';

      progressContainer.style.display = 'block';
      progressText.style.display = 'block';
      
      const percent = total > 0 ? Math.round((current / total) * 100) : 0;
      progressBar.style.width = `${percent}%`;
      progressText.textContent = `진행률: ${percent}% (청크 ${current}/${total})`;
      
    } else if (status === 'completed') {
      statusDot.classList.add('completed');
      statusText.textContent = '분석 완료';
      statusText.style.color = '#38B000';

      progressContainer.style.display = 'none';
      progressText.style.display = 'block';
      progressText.textContent = `총 ${totalCh}개 채널 분석 완료`;
      
    } else if (status === 'failed') {
      statusDot.classList.add('failed');
      statusText.textContent = '분석 실패';
      statusText.style.color = '#E63946';

      progressContainer.style.display = 'none';
      progressText.style.display = 'none';
      
    } else {
      // Idle or uninitialized
      statusDot.classList.add('idle');
      statusText.textContent = '대기 중';
      statusText.style.color = '#FFFFFF';

      progressContainer.style.display = 'none';
      progressText.style.display = 'none';
    }
  } catch (err) {
    console.error('Error fetching status in popup:', err);
  }
}

// Perform initial update on load
document.addEventListener('DOMContentLoaded', () => {
  updatePopupStatus();
  
  // Set up periodic update loop while popup remains active
  const interval = setInterval(updatePopupStatus, 1000);
  
  window.addEventListener('unload', () => {
    clearInterval(interval);
  });
});
