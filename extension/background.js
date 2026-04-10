// ── Side panel port ───────────────────────────────────────────────────────
let panelPort = null;

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'sidepanel') return;
  panelPort = port;
  port.onDisconnect.addListener(() => { panelPort = null; });
});

function sendPanel(msg) {
  try { panelPort?.postMessage(msg); } catch (_) {}
}

// ── Abre side panel ao clicar no ícone ───────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Mensagens do side panel ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'startRecording') {
    attachDebugger(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === 'stopRecording') {
    detachDebugger(msg.tabId);
    sendResponse({ ok: true });
  }
  if (msg.action === 'download') {
    const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(msg.content);
    chrome.downloads.download({ url, filename: msg.filename, saveAs: true });
  }
  // Picker: injected script → background → side panel
  if (msg.action === 'picked' || msg.action === 'pickedCancel') {
    sendPanel(msg);
  }
});

// ── Debugger ──────────────────────────────────────────────────────────────
const recording = new Set();
const pending   = {};

const SKIP_TYPES = new Set([
  'image', 'font', 'stylesheet', 'script',
  'media', 'websocket', 'ping', 'eventsource', 'manifest'
  // 'other' removido: o debugger classifica alguns XHR/Fetch como 'other'
]);
const SKIP_PREFIXES = ['chrome-extension://', 'chrome://', 'data:', 'blob:'];

async function attachDebugger(tabId) {
  recording.add(tabId);
  pending[tabId] = {};
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (_) { /* já attached */ }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    sendPanel({ action: 'recordingStatus', recording: true });
  } catch (e) {
    console.error('[BG] Network.enable falhou:', e.message);
    recording.delete(tabId);
  }
}

function detachDebugger(tabId) {
  recording.delete(tabId);
  delete pending[tabId];
  try { chrome.debugger.detach({ tabId }); } catch (_) {}
  sendPanel({ action: 'recordingStatus', recording: false });
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const tabId = source.tabId;
  if (!recording.has(tabId)) return;
  if (reason === 'target_closed') { recording.delete(tabId); return; }
  pending[tabId] = {};
  setTimeout(() => attachDebugger(tabId), 300);
});

chrome.tabs.onRemoved.addListener(tabId => {
  recording.delete(tabId);
  delete pending[tabId];
});

// ── Captura de eventos de rede ────────────────────────────────────────────
chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (!recording.has(tabId)) return;

  if (method === 'Network.requestWillBeSent') {
    const { requestId, request, type, redirectResponse } = params;
    if (redirectResponse) return;
    const rtype = (type || '').toLowerCase();
    if (SKIP_TYPES.has(rtype)) return;
    const url = request.url;
    if (SKIP_PREFIXES.some(p => url.startsWith(p))) return;
    if (!pending[tabId]) pending[tabId] = {};
    pending[tabId][requestId] = {
      url: request.url, method: request.method,
      headers: request.headers || {}, postData: request.postData || null,
      type: rtype, time: new Date().toLocaleTimeString(),
    };
  }

  if (method === 'Network.responseReceived') {
    const { requestId, response, type } = params;
    const entry = pending[tabId]?.[requestId];
    if (!entry) return;
    const rtype = (type || '').toLowerCase();
    if (SKIP_TYPES.has(rtype)) { delete pending[tabId][requestId]; return; }
    entry.statusCode = response.status;
    const parsed = buildRequest(entry);
    delete pending[tabId][requestId];
    sendPanel({ action: 'newRequest', request: parsed });
  }

  if (method === 'Network.loadingFailed') {
    if (pending[tabId]) delete pending[tabId][params.requestId];
  }
});

// ── Monta objeto de requisição ────────────────────────────────────────────
function buildRequest(entry) {
  const headers = entry.headers;
  const ct      = headers['Content-Type'] || headers['content-type'] || '';
  let data = {}, contentType = 'none';

  if (entry.postData) {
    if (ct.includes('application/x-www-form-urlencoded')) {
      contentType = 'form';
      try { new URLSearchParams(entry.postData).forEach((v, k) => { data[k] = v; }); } catch (_) {}
    } else if (ct.includes('application/json')) {
      contentType = 'json';
      try { data = JSON.parse(entry.postData); } catch (_) {}
    } else {
      contentType = 'raw';
      data = { _body: entry.postData };
    }
  } else if (entry.method === 'GET') {
    contentType = 'query';
    try { new URL(entry.url).searchParams.forEach((v, k) => { data[k] = v; }); } catch (_) {}
  }

  return {
    id:          `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    url:         entry.url,
    baseUrl:     entry.url.split('?')[0],
    method:      entry.method,
    headers:     entry.headers,
    data,
    contentType,
    statusCode:  entry.statusCode || 0,
    time:        entry.time,
  };
}
