import {
  type BridgeDocument,
} from '@bridge/shared';
import { CompanionClient } from './ws-client';

declare class CSInterface {
  evalScript(script: string, callback?: (result: string) => void): void;
}

const cs = new CSInterface();
const client = new CompanionClient();

const statusEl = document.getElementById('status') as HTMLDivElement;
const connectionDot = document.getElementById('connection-dot') as HTMLDivElement;
const pullBtn = document.getElementById('pull-btn') as HTMLButtonElement;
const pushBtn = document.getElementById('push-btn') as HTMLButtonElement;
const autoRenderToggle = document.getElementById('auto-render') as HTMLInputElement;
const pendingInfo = document.getElementById('pending-info') as HTMLDivElement;
const tooltip = document.getElementById('tooltip') as HTMLDivElement;

let isConnected = false;
let isExecuting = false;
let pendingDoc: BridgeDocument | null = null;

function setStatus(text: string, kind: 'ok' | 'err' | 'plain' = 'plain'): void {
  statusEl.textContent = text;
  statusEl.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
}

function setConnectionDot(kind: 'connected' | 'error' | 'plain'): void {
  connectionDot.className =
    kind === 'connected' ? 'connection-dot connected' :
    kind === 'error' ? 'connection-dot error' :
    'connection-dot';
}

function summarizeDocument(doc: BridgeDocument): string {
  const totalItems = doc.containers.reduce((n, c) => n + c.children.length, 0);
  const imageCount = Object.keys(doc.assets?.images ?? {}).length;
  return [
    `Incoming: ${doc.sourceApp || 'unknown'}`,
    `Containers: ${doc.containers.length}`,
    `Items: ${totalItems}`,
    `Images: ${imageCount}`,
  ].join('\n');
}

function updateControls(): void {
  pullBtn.disabled = !pendingDoc || isExecuting;
  pushBtn.disabled = !isConnected || isExecuting;
  autoRenderToggle.disabled = isExecuting;
}

function setPendingDocument(doc: BridgeDocument | null): void {
  pendingDoc = doc;
  pendingInfo.textContent = doc ? summarizeDocument(doc) : 'No incoming payload.';
  updateControls();
}

function parseEvalResult(result: string): { ok: boolean; count?: number; error?: string } {
  try {
    return JSON.parse(result) as { ok: boolean; count?: number; error?: string };
  } catch {
    return { ok: false, error: `ExtendScript returned: ${result}` };
  }
}

function renderDocument(doc: BridgeDocument): void {
  isExecuting = true;
  updateControls();
  setStatus('Rendering payload in Illustrator...');

  const scriptArg = JSON.stringify(JSON.stringify(doc));
  cs.evalScript(`bridge_render(${scriptArg})`, (result: string) => {
    isExecuting = false;
    const parsed = parseEvalResult(result);
    if (parsed.ok) {
      setPendingDocument(null);
      setStatus(`Rendered ${parsed.count ?? 0} item(s).`, 'ok');
    } else {
      setStatus(`Render error: ${parsed.error ?? 'unknown'}`, 'err');
      updateControls();
    }
  });
}

function renderPendingDocument(): void {
  if (!pendingDoc || isExecuting) return;
  renderDocument(pendingDoc);
}

function showTooltip(target: HTMLElement): void {
  const text = target.getAttribute('data-tooltip');
  if (!text) return;
  const rect = target.getBoundingClientRect();
  tooltip.textContent = text;
  tooltip.style.left = `${rect.left + rect.width / 2}px`;
  tooltip.style.top = `${Math.max(8, rect.top - 8)}px`;
  tooltip.classList.add('visible');
}

function hideTooltip(): void {
  tooltip.classList.remove('visible');
}

document.querySelectorAll<HTMLElement>('[data-tooltip]').forEach((el) => {
  el.addEventListener('mouseenter', () => showTooltip(el));
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('focus', () => showTooltip(el));
  el.addEventListener('blur', hideTooltip);
});

pullBtn.addEventListener('click', renderPendingDocument);

pushBtn.addEventListener('click', () => {
  if (!isConnected) {
    setStatus('Not connected to Bridge companion.', 'err');
    return;
  }
  if (isExecuting) return;

  isExecuting = true;
  updateControls();
  setStatus('Reading Illustrator selection...');

  cs.evalScript('bridge_readSelection()', (result: string) => {
    isExecuting = false;
    try {
      const parsed = JSON.parse(result) as { ok: boolean; document?: BridgeDocument; error?: string };
      if (!parsed.ok || !parsed.document) {
        setStatus(`Read error: ${parsed.error ?? 'nothing returned from ExtendScript'}`, 'err');
        updateControls();
        return;
      }
      const sent = client.pushDocument(parsed.document);
      const total = parsed.document.containers.reduce((n, c) => n + c.children.length, 0);
      setStatus(sent ? `Pushed ${total} item(s).` : 'Failed to send: socket not open.', sent ? 'ok' : 'err');
    } catch (e) {
      setStatus(`Push error: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
    updateControls();
  });
});

client.onStatus((status, detail) => {
  switch (status) {
    case 'connecting':
      isConnected = false;
      setConnectionDot('plain');
      setStatus('Connecting to Bridge companion...');
      break;
    case 'connected':
      isConnected = true;
      setConnectionDot('connected');
      setStatus('Connected. Ready.', 'ok');
      break;
    case 'disconnected':
      isConnected = false;
      setConnectionDot('plain');
      setStatus('Disconnected. Retrying...');
      break;
    case 'error':
      isConnected = false;
      setConnectionDot('error');
      setStatus(`Connection error: ${detail ?? 'unknown'}`, 'err');
      break;
  }
  updateControls();
});

client.onDocument((doc: BridgeDocument) => {
  if (isExecuting) {
    // eslint-disable-next-line no-console
    console.warn('[Bridge] Incoming payload ignored while Illustrator is busy.');
    return;
  }

  setPendingDocument(doc);
  if (autoRenderToggle.checked) {
    setStatus('Payload received. Auto-rendering...');
    renderDocument(doc);
  } else {
    setStatus('Payload received. Click Pull to render.');
  }
});

// bridge_render and bridge_readSelection are loaded by Illustrator at startup
// via <ScriptPath> in CSXS/manifest.xml — no $.evalFile needed here.
setPendingDocument(null);
setStatus('Waiting for connection...');
client.connect();
