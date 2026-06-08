// Tube Manager Trigger Button Injection Script

// ── Context-alive guard ───────────────────────────────────────────────────
// chrome.runtime.id becomes undefined the moment the extension is reloaded
// or updated while this content script is still live in the tab. Any call to
// chrome.runtime.* after that point throws "Extension context invalidated"
// synchronously. This helper centralises the check so every callsite is safe.
function isContextAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch (_) {
    return false;
  }
}

// ── Self-teardown on context loss ─────────────────────────────────────────
// When the extension reloads, the MutationObserver keeps firing on every DOM
// mutation and re-throwing the invalidated-context error on each call.
// We disconnect the observer and remove our injected button so the orphaned
// content script goes completely silent.
function teardown() {
  observer.disconnect();
  const staleBtn = document.getElementById('tube-manager-trigger-btn');
  if (staleBtn) staleBtn.remove();
}

function injectTriggerButton() {
  // Abort immediately if the extension context is no longer valid
  if (!isContextAlive()) { teardown(); return; }
  if (document.getElementById('tube-manager-trigger-btn')) return;

  const targetContainer = document.querySelector('#end') || document.querySelector('#buttons');
  if (!targetContainer) return;

  const btn = document.createElement('button');
  btn.id = 'tube-manager-trigger-btn';
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="display: block;">
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" fill="currentColor"/>
    </svg>
    <span>유령 채널 청소</span>
  `;

  // Styling trigger button with modern aesthetics
  btn.style.cssText = `
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: linear-gradient(135deg, #E63946, #D62246);
    color: #FFFFFF;
    border: none;
    border-radius: 20px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    margin-right: 16px;
    box-shadow: 0 4px 12px rgba(230, 57, 70, 0.3);
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
    font-family: inherit;
    letter-spacing: -0.2px;
  `;

  btn.addEventListener('mouseenter', () => {
    btn.style.transform = 'translateY(-1px)';
    btn.style.boxShadow = '0 6px 16px rgba(230, 57, 70, 0.45)';
    btn.style.filter = 'brightness(1.05)';
  });

  btn.addEventListener('mouseleave', () => {
    btn.style.transform = 'none';
    btn.style.boxShadow = '0 4px 12px rgba(230, 57, 70, 0.3)';
    btn.style.filter = 'none';
  });

  btn.addEventListener('click', () => {
    // Re-check context at click time — the extension may have been reloaded
    // between injection and the user actually clicking the button.
    if (!isContextAlive()) { teardown(); return; }
    try {
      chrome.runtime.sendMessage({ action: 'OPEN_DASHBOARD' }, () => {
        // Consume lastError to suppress the uncaught async error that Chrome
        // logs when the service worker is sleeping and hasn't responded yet.
        void chrome.runtime.lastError;
      });
    } catch (err) {
      // Synchronous throw — context was invalidated between the guard and the call.
      console.warn('[TubeManager] Extension context lost on click — tearing down.', err.message);
      teardown();
    }
  });

  // Safe injection
  targetContainer.insertBefore(btn, targetContainer.firstChild);
}

// ── Keep button injected through YouTube SPA route updates ────────────────
const observer = new MutationObserver(() => {
  if (!isContextAlive()) { teardown(); return; }
  injectTriggerButton();
});

observer.observe(document.body, { childList: true, subtree: true });

// ── Initial invocation ────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectTriggerButton);
} else {
  injectTriggerButton();
}
