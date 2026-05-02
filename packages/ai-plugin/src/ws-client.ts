import {
  BRIDGE_PROTOCOL_VERSION,
  type BridgeDocument,
  type ClientToCompanion,
  type CompanionToClient,
} from '@bridge/shared';

const COMPANION_WS_URL = 'ws://127.0.0.1:7711/bridge';
const CLIENT_VERSION = '0.6.0';

type StatusListener = (status: 'connecting' | 'connected' | 'disconnected' | 'error', detail?: string) => void;
type DocumentListener = (doc: BridgeDocument) => void | Promise<void>;

export class CompanionClient {
  private ws: WebSocket | null = null;
  private statusListeners = new Set<StatusListener>();
  private documentListeners = new Set<DocumentListener>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _assetBaseUrl: string | null = null;

  get assetBaseUrl(): string | null {
    return this._assetBaseUrl;
  }

  connect(): void {
    this.notifyStatus('connecting');
    try {
      this.ws = new WebSocket(COMPANION_WS_URL);
    } catch (e) {
      this.notifyStatus('error', String(e));
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.send({
        kind: 'hello',
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        role: 'illustrator',
        clientVersion: CLIENT_VERSION,
      });
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as CompanionToClient;
        if (msg.kind === 'welcome') {
          this._assetBaseUrl = msg.assetBaseUrl;
          this.notifyStatus('connected');
        } else if (msg.kind === 'document') {
          for (const l of this.documentListeners) {
            void l(msg.document);
          }
        } else if (msg.kind === 'error') {
          this.notifyStatus('error', `${msg.code}: ${msg.message}`);
        }
      } catch {
        // ignore
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      this._assetBaseUrl = null;
      this.notifyStatus('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = () => {
      this.notifyStatus('error', 'socket error');
    };
  }

  pushDocument(doc: BridgeDocument): boolean {
    return this.send({ kind: 'pushDocument', document: doc });
  }

  onStatus(listener: StatusListener): void {
    this.statusListeners.add(listener);
  }

  onDocument(listener: DocumentListener): void {
    this.documentListeners.add(listener);
  }

  private send(msg: ClientToCompanion): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private notifyStatus(status: Parameters<StatusListener>[0], detail?: string): void {
    for (const l of this.statusListeners) l(status, detail);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }
}
