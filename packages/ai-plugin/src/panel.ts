/**
 * UXP panel entry — M7 plan/execute split.
 *
 * Inbound flow:
 *   WS document arrives
 *     → planner reads existing AI doc state (no modal scope needed)
 *     → summary sent to UI panel (rendered in this same process)
 *     → user clicks Accept → executor runs inside executeAsModalForUXP
 *       (or Cancel → plan discarded, no side effects)
 *
 * Outbound flow (push to Figma): unchanged from M3.
 *
 * Concurrency: if a new WS document arrives while a plan is pending review,
 * we silently discard the new one with a console warning (per M7 spec).
 */
import {
  type BridgeDocument,
  type DocumentPlan,
  summarizePlan,
  isPlanNoOp,
  formatSummary,
} from '@bridge/shared';
import { CompanionClient } from './ws-client';
import { selectionToBridgeDocument } from './ai-to-ir';
import { planDocument } from './ai-planner';
import { executePlan } from './ai-executor';

const client = new CompanionClient();

const statusEl = document.getElementById('status') as HTMLDivElement;
const pushBtn = document.getElementById('push-btn') as HTMLButtonElement;
const reviewPanel = document.getElementById('review-panel') as HTMLDivElement;
const reviewWarnings = document.getElementById('review-warnings') as HTMLDivElement;
const reviewSummary = document.getElementById('review-summary') as HTMLDivElement;
const acceptBtn = document.getElementById('accept-btn') as HTMLButtonElement;
const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;

let isConnected = false;
let isReviewing = false;
let isExecuting = false;

interface PendingPlan {
  plan: DocumentPlan;
  document: BridgeDocument;
  assetBaseUrl: string;
}
let pendingPlan: PendingPlan | null = null;

function setStatus(text: string, kind: 'ok' | 'err' | 'plain' = 'plain'): void {
  statusEl.textContent = text;
  statusEl.className = kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : '';
}

function updatePushButtonState(): void {
  pushBtn.disabled = !isConnected || isReviewing || isExecuting;
}

// ── Review panel ─────────────────────────────────────────────────────

function showReviewPanel(plan: DocumentPlan): void {
  const summary = summarizePlan(plan);

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
  updatePushButtonState();
}

function hideReviewPanel(): void {
  reviewPanel.classList.remove('visible');
  isReviewing = false;
  updatePushButtonState();
}

acceptBtn.addEventListener('click', async () => {
  if (!pendingPlan) return;
  const { plan, document: doc, assetBaseUrl } = pendingPlan;
  pendingPlan = null;
  hideReviewPanel();

  isExecuting = true;
  updatePushButtonState();
  setStatus('Applying sync…');

  try {
    // Executor wraps its own modal scope.
    const result = await executePlan(plan, doc, assetBaseUrl);
    if (result.ok) {
      setStatus(`Applied ${result.executedOps} operation(s).`, 'ok');
    } else {
      setStatus(`Apply error: ${result.error}`, 'err');
    }
  } catch (e) {
    setStatus(`Apply error: ${e instanceof Error ? e.message : String(e)}`, 'err');
  } finally {
    isExecuting = false;
    updatePushButtonState();
  }
});

cancelBtn.addEventListener('click', () => {
  if (pendingPlan) {
    // eslint-disable-next-line no-console
    console.info('[Bridge] Plan cancelled; discarding without side effects.');
  }
  pendingPlan = null;
  hideReviewPanel();
  setStatus('Sync cancelled.');
});

// ── Status routing ───────────────────────────────────────────────────

client.onStatus((status, detail) => {
  switch (status) {
    case 'connecting':
      setStatus('Connecting to companion…');
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
      setStatus(`Error: ${detail ?? 'unknown'}`, 'err');
      break;
  }
  updatePushButtonState();
});

// ── Inbound document — plan, then await accept/cancel ────────────────

client.onDocument(async (doc) => {
  const baseUrl = client.assetBaseUrl;
  if (!baseUrl) {
    setStatus('Received document but companion URL unknown', 'err');
    return;
  }

  if (isReviewing || isExecuting) {
    // M7: silently discard with console warning.
    // eslint-disable-next-line no-console
    console.warn('[Bridge] Discarding incoming push: prior plan still pending or executing.');
    return;
  }

  const total = doc.containers.reduce((n, c) => n + c.children.length, 0);
  const imgs = Object.keys(doc.assets?.images ?? {}).length;
  setStatus(`Computing plan for ${total} item(s), ${imgs} image(s)…`);

  try {
    // Planner runs OUTSIDE executeAsModalForUXP because it only reads.
    // This keeps the AI canvas interactive during plan computation.
    const plan = await planDocument(doc);

    if (isPlanNoOp(plan)) {
      setStatus('No changes from incoming sync.', 'ok');
      return;
    }

    pendingPlan = { plan, document: doc, assetBaseUrl: baseUrl };
    setStatus('Plan ready. Review below.');
    showReviewPanel(plan);
  } catch (e) {
    setStatus(`Plan error: ${e instanceof Error ? e.message : String(e)}`, 'err');
    pendingPlan = null;
  }
});

// ── Outbound (M3, unchanged) ─────────────────────────────────────────

pushBtn.addEventListener('click', async () => {
  const baseUrl = client.assetBaseUrl;
  if (!isConnected || !baseUrl) {
    setStatus('Not connected', 'err');
    return;
  }
  if (isReviewing || isExecuting) {
    setStatus('Resolve the pending review first.', 'err');
    return;
  }
  try {
    setStatus('Translating selection…');
    const doc = await selectionToBridgeDocument(baseUrl);
    const sent = client.pushDocument(doc);
    if (sent) {
      const total = doc.containers.reduce((n, c) => n + c.children.length, 0);
      const imgCount = Object.keys(doc.assets.images).length;
      setStatus(
        `Pushed ${total} item(s), ${imgCount} image(s) across ${doc.containers.length} container(s).`,
        'ok'
      );
    } else {
      setStatus('Failed to send — socket not open', 'err');
    }
  } catch (e) {
    setStatus(`Error: ${e instanceof Error ? e.message : String(e)}`, 'err');
  }
});

client.connect();
