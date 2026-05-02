/**
 * Figma sandbox entry. M7 split:
 *
 *   - applyDocument is gone from the inbound path.
 *   - Inbound path is now: planDocument → cache plan → emit summary
 *     → wait for acceptPlan or cancelPlan → execute or discard.
 *
 * The outbound path (push to Illustrator) is unchanged from M3.
 *
 * MILESTONE TRACE: M1 base, M2 image fetch, M3 push request,
 * M7 plan/execute split.
 */
import {
  type BridgeDocument,
  type DocumentPlan,
  summarizePlan,
  isPlanNoOp,
} from '@bridge/shared';
import { selectionToPreliminaryDocument } from './figma-to-ir';
import { planDocument } from './figma-planner';
import { executePlan } from './figma-executor';

figma.showUI(__html__, { width: 320, height: 380 });

// Inbound asset fetch plumbing — unchanged from M3
interface AssetReplyMessage {
  kind: 'assetReply';
  hash: string;
  bytes: Uint8Array | null;
  error?: string;
}
const inflightAssetFetches = new Map<string, Promise<Uint8Array>>();
const pendingHandlers = new Set<(msg: AssetReplyMessage) => void>();

function fetchAsset(hash: string): Promise<Uint8Array> {
  const existing = inflightAssetFetches.get(hash);
  if (existing) return existing;
  const p = new Promise<Uint8Array>((resolve, reject) => {
    const handler = (msg: AssetReplyMessage) => {
      if (msg.kind !== 'assetReply' || msg.hash !== hash) return;
      pendingHandlers.delete(handler);
      if (msg.bytes) resolve(msg.bytes);
      else reject(new Error(msg.error ?? 'unknown'));
    };
    pendingHandlers.add(handler);
    figma.ui.postMessage({ kind: 'fetchAsset', hash });
  });
  inflightAssetFetches.set(hash, p);
  p.finally(() => inflightAssetFetches.delete(hash));
  return p;
}

// ── M7: pending plan state ───────────────────────────────────────────

interface PendingPlan {
  plan: DocumentPlan;
  document: BridgeDocument;
}

let pendingPlan: PendingPlan | null = null;

async function handlePlanRequest(doc: BridgeDocument): Promise<void> {
  try {
    if (pendingPlan) {
      // eslint-disable-next-line no-console
      console.warn('[Bridge] handlePlanRequest called with pending plan; discarding');
      figma.ui.postMessage({ kind: 'planError', error: 'Prior plan still pending' });
      return;
    }
    const plan = await planDocument(doc);
    pendingPlan = { plan, document: doc };

    const summary = summarizePlan(plan);
    figma.ui.postMessage({
      kind: 'planReady',
      summary,
      isNoOp: isPlanNoOp(plan),
    });
  } catch (e) {
    pendingPlan = null;
    const err = e instanceof Error ? e.message : String(e);
    figma.ui.postMessage({ kind: 'planError', error: err });
  }
}

async function handleAccept(): Promise<void> {
  if (!pendingPlan) {
    figma.ui.postMessage({ kind: 'applyResult', ok: false, error: 'No plan to accept' });
    return;
  }
  const { plan, document: doc } = pendingPlan;
  pendingPlan = null;
  try {
    const result = await executePlan(plan, doc, fetchAsset);
    figma.ui.postMessage({ kind: 'applyResult', ok: true, count: result.executedOps });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    figma.ui.postMessage({ kind: 'applyResult', ok: false, error: err });
  }
}

function handleCancel(): void {
  if (pendingPlan) {
    // eslint-disable-next-line no-console
    console.info('[Bridge] Plan cancelled; discarding without side effects.');
  }
  pendingPlan = null;
}

// ── Outbound (M3, unchanged) ─────────────────────────────────────────

async function handlePushRequest(): Promise<void> {
  try {
    const prelim = await selectionToPreliminaryDocument();
    figma.ui.postMessage({ kind: 'preliminaryDocument', document: prelim });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    figma.ui.postMessage({ kind: 'pushError', error: err });
    figma.notify(`Bridge: ${err}`, { error: true });
  }
}

interface PlanDocumentMessage { kind: 'planDocument'; document: BridgeDocument; }
interface AcceptPlanMessage   { kind: 'acceptPlan'; }
interface CancelPlanMessage   { kind: 'cancelPlan'; }
interface RequestPushMessage  { kind: 'requestPush'; }

type IncomingMessage =
  | PlanDocumentMessage
  | AcceptPlanMessage
  | CancelPlanMessage
  | AssetReplyMessage
  | RequestPushMessage;

figma.ui.onmessage = async (msg: IncomingMessage) => {
  switch (msg.kind) {
    case 'planDocument':
      await handlePlanRequest(msg.document);
      return;
    case 'acceptPlan':
      await handleAccept();
      return;
    case 'cancelPlan':
      handleCancel();
      return;
    case 'assetReply':
      for (const h of pendingHandlers) h(msg);
      return;
    case 'requestPush':
      await handlePushRequest();
      return;
  }
};
