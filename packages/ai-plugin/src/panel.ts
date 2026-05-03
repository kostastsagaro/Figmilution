/**
 * panel.ts — CEP panel UI for the Bridge Illustrator plugin.
 *
 * Architecture
 * ────────────
 * This file runs inside Chromium (CEF), embedded by Illustrator's CEP host.
 * It handles two directions:
 *
 *   Inbound  (Figma → Illustrator)
 *   ──────────────────────────────
 *   1. WebSocket (CompanionClient) receives a BridgeDocument from the
 *      companion server (pushed by the Figma plugin).
 *   2. The user reviews a summary and clicks Accept.
 *   3. panel.ts calls cs.evalScript('bridge_render(jsonStr)', cb) which
 *      executes bridge.jsx inside Illustrator's ExtendScript engine.
 *   4. bridge.jsx draws the document onto the active Illustrator canvas.
 *
 *   Outbound (Illustrator → Figma)
 *   ──────────────────────────────
 *   1. User clicks "Push selection to Figma".
 *   2. panel.ts calls cs.evalScript('bridge_readSelection()', cb).
 *   3. bridge.jsx reads the current Illustrator selection and returns a
 *      BridgeDocument JSON string.
 *   4. panel.ts parses it and sends it over the WebSocket to the companion.
 *
 * CEP bridge
 * ──────────
 * CSInterface is loaded by panel.html as a plain <script> before panel.js.
 * It wraps window.__adobe_cep__.evalScript(), which is the only channel into
 * the Illustrator ExtendScript engine.  All values cross the boundary as
 * JSON strings (evalScript is string-in / string-out).
 */

import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeDocument,
} from '@bridge/shared';
import { CompanionClient } from './ws-client';

// ── CEP bridge type declaration ───────────────────────────────────────────────
// CSInterface is loaded as a plain <script> before panel.js in panel.html.
// We declare it here so TypeScript knows the shape without a full type package.

declare class CSInterface {
  evalScript(script: string, callback?: (result: string) => void): void;
  getSystemPath(pathType: number): string;
}

// ── State ─────────────────────────────────────────────────────────────────────

const cs     = new CSInterface();
const client = new CompanionClient();

const statusEl      = document.getElementById('status')         as HTMLDivElement;
const pushBtn       = document.getElementById('push-btn')       as HTMLButtonElement;
const reviewPanel   = document.getElementById('review-panel')   as HTMLDivElement;
const reviewWarnings= document.getElementById('review-warnings') as HTMLDivElement;
const reviewSummary = document.getElementById('review-summary') as HTMLDivElement;
const acceptBtn     = document.getElementById('accept-btn')     as HTMLButtonElement;
const cancelBtn     = document.getElementById('cancel-btn')     as HTMLButtonElement;

let isConnected  = false;
let isReviewing  = false;
let isExecuting  = false;
let pendingDoc: BridgeDocument | null = null;

// ── UI helpers ────────────────────────────────────────────────────────────────

function setStatus(text: string, kind: 'ok' | 'err' | 'plain' = 'plain'): void {
  statusEl.textContent = text;
  statusEl.className   = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
}

function updateButtons(): void {
  pushBtn.disabled = !isConnected || isReviewing || isExecuting;
}

// ── Review panel ──────────────────────────────────────────────────────────────

function showReviewPanel(doc: BridgeDocument): void {
  const totalItems = doc.containers.reduce((n, c) => n + c.children.length, 0);
  const images     = Object.keys(doc.assets?.images ?? {}).length;

  reviewWarnings.innerHTML = '';                // no warnings in CEP mode
  reviewSummary.textContent = [
    `Source:     ${doc.sourceApp ?? 'unknown'}`,
    `Containers: ${doc.containers.length}`,
    `Items:      ${totalItems}`,
    `Images:     ${images}  (placeholders rendered)`,
  ].join('\n');

  reviewPanel.classList.add('visible');
  isReviewing = true;
  updateButtons();
}

function hideReviewPanel(): void {
  reviewPanel.classList.remove('visible');
  isReviewing = false;
  updateButtons();
}

// ── Accept / Cancel ───────────────────────────────────────────────────────────

acceptBtn.addEventListener('click', () => {
  if (!pendingDoc) return;
  const doc = pendingDoc;
  pendingDoc = null;
  hideReviewPanel();

  isExecuting = true;
  updateButtons();
  setStatus('Rendering in Illustrator…');

  // Double-stringify so the JSON string arrives as a quoted string literal
  // inside the evalScript call:  bridge_render("{\"containers\":[...]}")
  const scriptArg = JSON.stringify(JSON.stringify(doc));
  cs.evalScript(`bridge_render(${scriptArg})`, (result: string) => {
    isExecuting = false;
    updateButtons();
    try {
      const r = JSON.parse(result) as { ok: boolean; count?: number; error?: string };
      if (r.ok) setStatus(`Rendered ${r.count ?? 0} item(s) in Illustrator.`, 'ok');
      else      setStatus(`Render error: ${r.error}`, 'err');
    } catch {
      // evalScript returns "undefined" if ExtendScript had no return value
      setStatus(`ExtendScript returned: ${result}`, 'err');
    }
  });
});

cancelBtn.addEventListener('click', () => {
  pendingDoc = null;
  hideReviewPanel();
  setStatus('Sync cancelled.');
});

// ── WebSocket status routing ──────────────────────────────────────────────────

client.onStatus((status, detail) => {
  switch (status) {
    case 'connecting':
      setStatus('Connecting to Bridge companion…');
      isConnected = false;
      break;
    case 'connected':
      setStatus('Connected. Ready to push or receive.', 'ok');
      isConnected = true;
      break;
    case 'disconnected':
      setStatus('Disconnected. Retrying…');
      isConnected = false;
      break;
    case 'error':
      setStatus(`Connection error: ${detail ?? 'unknown'}`, 'err');
      break;
  }
  updateButtons();
});

// ── Inbound: companion → Illustrator ─────────────────────────────────────────

client.onDocument((doc: BridgeDocument) => {
  if (isReviewing || isExecuting) {
    // eslint-disable-next-line no-console
    console.warn('[Bridge] Discarding incoming push: prior operation still pending.');
    return;
  }
  const total = doc.containers.reduce((n, c) => n + c.children.length, 0);
  const imgs  = Object.keys(doc.assets?.images ?? {}).length;
  setStatus(`Received ${total} item(s), ${imgs} image(s). Review below.`);
  pendingDoc = doc;
  showReviewPanel(doc);
});

// ── Outbound: Illustrator → Figma ─────────────────────────────────────────────

pushBtn.addEventListener('click', () => {
  if (!isConnected || !client.assetBaseUrl) {
    setStatus('Not connected to Bridge companion.', 'err');
    return;
  }
  if (isReviewing || isExecuting) {
    setStatus('Resolve the pending review first.', 'err');
    return;
  }
  setStatus('Reading Illustrator selection…');

  cs.evalScript('bridge_readSelection()', (result: string) => {
    try {
      const r = JSON.parse(result) as { ok: boolean; document?: BridgeDocument; error?: string };
      if (!r.ok || !r.document) {
        setStatus(`Read error: ${r.error ?? 'nothing returned from ExtendScript'}`, 'err');
        return;
      }
      const sent  = client.pushDocument(r.document);
      const total = r.document.containers.reduce((n, c) => n + c.children.length, 0);
      if (sent) setStatus(`Pushed ${total} item(s) to Figma.`, 'ok');
      else      setStatus('Failed to send — WebSocket not open.', 'err');
    } catch (e) {
      setStatus(`Push error: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────

client.connect();
