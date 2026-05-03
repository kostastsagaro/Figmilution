import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeDocument,
  type ClientToCompanion,
  type CompanionToClient,
  type ImageRef,
  type PlanSummary,
  formatSummary,
} from '@bridge/shared';

const CLIENT_VERSION = '0.7.0';
const CONNECT_TIMEOUT_MS = 5000;
const RECONNECT_DELAY_MS = 2000;

const COMPANION_ENDPOINTS = [
  {
    label: 'localhost',
    wsUrl: 'ws://localhost:7711/bridge',
    healthUrl: 'http://localhost:7711/health',
  },
] as const;

const statusEl = document.getElementById('status') as HTMLDivElement;
const pushBtn = document.getElementById('push-btn') as HTMLButtonElement;
const reviewPanel = document.getElementById('review-panel') as HTMLDivElement;
const reviewWarnings = document.getElementById('review-warnings') as HTMLDivElement;
const reviewSummary = document.getElementById('review-summary') as HTMLDivElement;
const acceptBtn = document.getElementById('accept-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;

function setStatus(text: string, kind: 'ok' | 'err' | 'plain' = 'plain') {
  statusEl.textContent = text;
  statusEl.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
}

let ws: WebSocket | null = null;
let assetBaseUrl: string | null = null;
let isConnected = false;
let isReviewing = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let connectTimeout: ReturnType<typeof setTimeout> | null = null;
let endpointIndex = 0;
let attemptId = 0;

function debug(message: string, details?: unknown): void {
  // eslint-disable-next-line no-console
  console.log(`[Bridge UI] ${message}`, details ?? '');
}

function warn(message: string, details?: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[Bridge UI] ${message}`, details ?? '');
}

function clearConnectTimeout(): void {
  if (connectTimeout) {
    clearTimeout(connectTimeout);
    connectTimeout = null;
  }
}

function send(msg: ClientToCompanion): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    warn('send skipped because socket is not open', {
      kind: msg.kind,
      readyState: ws?.readyState,
    });
    return false;
  }
  const payload = JSON.stringify(msg);
  debug('sending websocket message', { kind: msg.kind, bytes: payload.length });
  ws.send(payload);
  return true;
}

// ── Review panel UI helpers (M7) ──────────────────────────────────────

function showReviewPanel(summary: PlanSummary): void {
  reviewWarnings.innerHTML = '';
  for (const w of summary.highImpactWarnings) {
    const div = document.createElement('div');
    div.className = 'warning-line';
    div.textContent = `⚠ ${w}`;
    reviewWarnings.appendChild(div);
  }
  reviewSummary.textContent = formatSummary(summary).join('\n');
  reviewPanel.classList.add('visible');
  isReviewing = true;
  pushBtn.disabled = true;
}

function hideReviewPanel(): void {
  reviewPanel.classList.remove('visible');
  isReviewing = false;
  pushBtn.disabled = !isConnected;
}

acceptBtn.addEventListener('click', () => {
  setStatus('Applying sync…');
  parent.postMessage({ pluginMessage: { kind: 'acceptPlan' } }, '*');
  hideReviewPanel();
});

cancelBtn.addEventListener('click', () => {
  setStatus('Sync cancelled.');
  parent.postMessage({ pluginMessage: { kind: 'cancelPlan' } }, '*');
  hideReviewPanel();
});

// ── Asset upload / fetch (unchanged from M3) ──────────────────────────

interface UploadResult { hash: string; byteLength: number; }

async function uploadBytes(bytes: Uint8Array, format: string): Promise<UploadResult> {
  if (!assetBaseUrl) throw new Error('not connected');
  const res = await fetch(`${assetBaseUrl}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': format },
    body: bytes as any,
  });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
  return await res.json() as UploadResult;
}

async function handleAssetFetch(hash: string) {
  if (!assetBaseUrl) {
    parent.postMessage({
      pluginMessage: { kind: 'assetReply', hash, bytes: null, error: 'not connected' },
    }, '*');
    return;
  }
  try {
    const res = await fetch(`${assetBaseUrl}/assets/${hash}`);
    if (!res.ok) {
      parent.postMessage({
        pluginMessage: { kind: 'assetReply', hash, bytes: null, error: `HTTP ${res.status}` },
      }, '*');
      return;
    }
    const buf = await res.arrayBuffer();
    parent.postMessage({
      pluginMessage: { kind: 'assetReply', hash, bytes: new Uint8Array(buf) },
    }, '*');
  } catch (e) {
    parent.postMessage({
      pluginMessage: { kind: 'assetReply', hash, bytes: null, error: String(e) },
    }, '*');
  }
}

async function finalizePreliminaryDocument(prelim: any): Promise<BridgeDocument> {
  const assets: Record<string, ImageRef> = {};
  const inflight = new Map<string, Promise<ImageRef>>();

  function quickKey(bytes: Uint8Array): string {
    const head = Array.from(bytes.slice(0, 16)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const tail = Array.from(bytes.slice(-16)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${bytes.length}-${head}-${tail}`;
  }

  async function uploadOne(prelimImg: { bytes: Uint8Array; format: string; byteLength: number }, rendered: { width: number; height: number }): Promise<ImageRef> {
    const key = quickKey(prelimImg.bytes);
    const existing = inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const result = await uploadBytes(prelimImg.bytes, prelimImg.format);
      const ref: ImageRef = {
        hash: result.hash,
        format: prelimImg.format,
        naturalSize: { width: rendered.width, height: rendered.height },
        byteLength: result.byteLength,
      };
      assets[result.hash] = ref;
      return ref;
    })();
    inflight.set(key, p);
    return p;
  }

  async function walkContainer(container: any): Promise<void> {
    for (let i = 0; i < container.children.length; i++) {
      const child = container.children[i];
      if (child.type === 'image' && child.preliminaryImage) {
        const ref = await uploadOne(child.preliminaryImage, child.size);
        delete child.preliminaryImage;
        child.image = ref;
      }
      // TODO MERGE: M5 instance / M6 group recursion
    }
  }

  for (const c of prelim.containers) await walkContainer(c);

  return {
    schemaVersion: prelim.schemaVersion,
    sourceApp: prelim.sourceApp,
    documentBounds: prelim.documentBounds,
    containers: prelim.containers,
    library: prelim.library ?? { components: {}, colorStyles: {}, textStyles: {} },
    assets: { images: assets },
    generatedAt: prelim.generatedAt,
  };
}

// ── WS connection ────────────────────────────────────────────────────

async function logHealth(endpoint: (typeof COMPANION_ENDPOINTS)[number], currentAttemptId: number): Promise<void> {
  try {
    debug('checking companion health', { attemptId: currentAttemptId, url: endpoint.healthUrl });
    const res = await fetch(endpoint.healthUrl, { cache: 'no-store' });
    const text = await res.text();
    debug('health response', {
      attemptId: currentAttemptId,
      status: res.status,
      ok: res.ok,
      body: text.slice(0, 300),
    });
  } catch (e) {
    warn('health check failed', {
      attemptId: currentAttemptId,
      url: endpoint.healthUrl,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function scheduleReconnect(reason: string): void {
  clearConnectTimeout();
  isConnected = false;
  pushBtn.disabled = true;
  assetBaseUrl = null;

  endpointIndex = (endpointIndex + 1) % COMPANION_ENDPOINTS.length;
  const nextEndpoint = COMPANION_ENDPOINTS[endpointIndex];
  setStatus(`Disconnected (${reason}). Retrying ${nextEndpoint.label} in ${RECONNECT_DELAY_MS / 1000}s...`);
  debug('scheduled reconnect', {
    reason,
    nextUrl: nextEndpoint.wsUrl,
    delayMs: RECONNECT_DELAY_MS,
  });

  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, RECONNECT_DELAY_MS);
  }
}

function connect() {
  const endpoint = COMPANION_ENDPOINTS[endpointIndex];
  const currentAttemptId = ++attemptId;

  clearConnectTimeout();
  setStatus(`Connecting to companion...\n${endpoint.wsUrl}`);
  debug('opening websocket', {
    attemptId: currentAttemptId,
    wsUrl: endpoint.wsUrl,
  });
  void logHealth(endpoint, currentAttemptId);

  ws = new WebSocket(endpoint.wsUrl);
  const socket = ws;

  connectTimeout = setTimeout(() => {
    if (ws !== socket || isConnected) return;
    warn('websocket timed out before welcome', {
      attemptId: currentAttemptId,
      url: endpoint.wsUrl,
      readyState: socket.readyState,
    });
    setStatus(`Connection timed out waiting for welcome.\n${endpoint.wsUrl}`);
    socket.close(4000, 'Bridge UI timeout waiting for welcome');
  }, CONNECT_TIMEOUT_MS);

  ws.onopen = () => {
    debug('websocket open', { attemptId: currentAttemptId, url: endpoint.wsUrl });
    send({
      kind: 'hello',
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      role: 'figma',
      clientVersion: CLIENT_VERSION,
    });
  };

  ws.onmessage = (ev) => {
    debug('websocket message received', {
      attemptId: currentAttemptId,
      type: typeof ev.data,
      preview: String(ev.data).slice(0, 300),
    });
    let msg: CompanionToClient;
    try {
      msg = JSON.parse(String(ev.data)) as CompanionToClient;
    } catch (e) {
      warn('failed to parse websocket message as JSON', {
        attemptId: currentAttemptId,
        error: e instanceof Error ? e.message : String(e),
        raw: String(ev.data).slice(0, 500),
      });
      setStatus('Received non-JSON message from companion. See console.', 'err');
      return;
    }
    if (msg.kind === 'welcome') {
      clearConnectTimeout();
      debug('welcome received', {
        attemptId: currentAttemptId,
        connectionId: msg.connectionId,
        protocolVersion: msg.protocolVersion,
        assetBaseUrl: msg.assetBaseUrl,
      });
      assetBaseUrl = msg.assetBaseUrl;
      isConnected = true;
      pushBtn.disabled = isReviewing;
      setStatus('Connected. Ready to push or receive.', 'ok');
    } else if (msg.kind === 'document') {
      // M7: don't apply; ask sandbox to PLAN.
      if (isReviewing) {
        warn('discarding incoming push: prior plan still under review');
        return;
      }
      const total = msg.document.containers.reduce((n, c) => n + c.children.length, 0);
      const imgs = Object.keys(msg.document.assets?.images ?? {}).length;
      setStatus(`Computing plan for ${total} item(s), ${imgs} image(s)...`);
      parent.postMessage(
        { pluginMessage: { kind: 'planDocument', document: msg.document } },
        '*'
      );
    } else if (msg.kind === 'error') {
      warn('companion returned error message', msg);
      setStatus(`Companion error: ${msg.code}: ${msg.message}`, 'err');
    } else {
      warn('unknown companion message kind', msg);
      setStatus('Unknown companion message. See console.', 'err');
    }
  };

  ws.onclose = (ev) => {
    debug('websocket closed', {
      attemptId: currentAttemptId,
      url: endpoint.wsUrl,
      code: ev.code,
      reason: ev.reason,
      wasClean: ev.wasClean,
    });
    scheduleReconnect(ev.reason || `close ${ev.code}`);
  };

  ws.onerror = (ev) => {
    warn('websocket error event', {
      attemptId: currentAttemptId,
      url: endpoint.wsUrl,
      readyState: socket.readyState,
      eventType: ev.type,
    });
    setStatus(`Socket error for ${endpoint.wsUrl}. See console.`, 'err');
  };
}

// ── Sandbox messaging ────────────────────────────────────────────────

window.addEventListener('message', async (ev) => {
  const data = ev.data?.pluginMessage;
  if (!data) return;

  if (data.kind === 'planReady') {
    const summary = data.summary as PlanSummary;
    if (data.isNoOp) {
      setStatus('No changes from incoming sync.', 'ok');
      parent.postMessage({ pluginMessage: { kind: 'cancelPlan' } }, '*');
      return;
    }
    setStatus('Plan ready. Review below.');
    showReviewPanel(summary);
    return;
  }

  if (data.kind === 'planError') {
    setStatus(`Plan error: ${data.error}`, 'err');
    return;
  }

  if (data.kind === 'applyResult') {
    if (data.ok) setStatus(`Rendered ${data.count} node(s).`, 'ok');
    else setStatus(`Render error: ${data.error}`, 'err');
    return;
  }

  if (data.kind === 'fetchAsset') {
    handleAssetFetch(data.hash);
    return;
  }

  if (data.kind === 'preliminaryDocument') {
    setStatus('Uploading assets…');
    try {
      const finalDoc = await finalizePreliminaryDocument(data.document);
      const sent = send({ kind: 'pushDocument', document: finalDoc });
      if (sent) {
        const total = finalDoc.containers.reduce((n, c) => n + c.children.length, 0);
        const imgCount = Object.keys(finalDoc.assets.images).length;
        setStatus(`Pushed ${total} item(s), ${imgCount} image(s) to Illustrator.`, 'ok');
      } else {
        setStatus('Failed to send — socket not open', 'err');
      }
    } catch (e) {
      setStatus(`Push error: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
    return;
  }

  if (data.kind === 'pushError') {
    setStatus(`Error: ${data.error}`, 'err');
    return;
  }
});

pushBtn.addEventListener('click', () => {
  if (!isConnected) {
    setStatus('Not connected', 'err');
    return;
  }
  if (isReviewing) {
    setStatus('Resolve the pending review first.', 'err');
    return;
  }
  setStatus('Reading selection…');
  parent.postMessage({ pluginMessage: { kind: 'requestPush' } }, '*');
});

connect();
