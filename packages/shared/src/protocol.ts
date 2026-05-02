import type { BridgeDocument } from './bridge-schema';

export type ClientRole = 'illustrator' | 'figma';

// ── Client → Companion ─────────────────────────────────────────────────────

export interface HelloMessage {
  kind: 'hello';
  protocolVersion: string;
  role: ClientRole;
  clientVersion: string;
}

export interface PushDocumentMessage {
  kind: 'pushDocument';
  document: BridgeDocument;
  /** Reserved for future per-recipient routing. M3+ companions ignore this. */
  target?: { connectionId?: string };
}

export type ClientToCompanion = HelloMessage | PushDocumentMessage;

// ── Companion → Client ─────────────────────────────────────────────────────

export interface WelcomeMessage {
  kind: 'welcome';
  connectionId: string;
  protocolVersion: string;
  /**
   * Absolute base URL for the asset HTTP endpoints. Plugins must use this
   * prefix for fetch() rather than hardcoding a port.
   */
  assetBaseUrl: string;
}

export interface DocumentMessage {
  kind: 'document';
  document: BridgeDocument;
}

export interface ErrorMessage {
  kind: 'error';
  code: 'protocolMismatch' | 'invalidPayload' | 'internal';
  message: string;
}

export type CompanionToClient = WelcomeMessage | DocumentMessage | ErrorMessage;

export type AnyMessage = ClientToCompanion | CompanionToClient;
