import { WebSocket, WebSocketServer } from 'ws';
import { v4 as uuid } from 'uuid';
import {
  BRIDGE_PROTOCOL_VERSION,
  type ClientRole,
  type ClientToCompanion,
  type CompanionToClient,
} from '@bridge/shared';
import { logger } from './logger';

interface Connection {
  id: string;
  socket: WebSocket;
  role: ClientRole | null;
  clientVersion: string | null;
}

/**
 * Hub keeps a registry of connected clients and routes pushed documents
 * from one role to all clients of the other role. Topology:
 *
 *   Illustrator clients --pushDocument--> Hub --document--> Figma clients
 *   Figma clients       --pushDocument--> Hub --document--> Illustrator clients
 */
export class WsHub {
  private connections = new Map<string, Connection>();

  constructor(
    private readonly assetBaseUrl: string,
    private readonly options: { maxPayload?: number } = {}
  ) {}

  attach(server: import('http').Server): void {
    const wss = new WebSocketServer({
      server,
      path: '/bridge',
      maxPayload: this.options.maxPayload ?? 50 * 1024 * 1024,
    });

    wss.on('connection', (socket) => {
      const conn: Connection = {
        id: uuid(),
        socket,
        role: null,
        clientVersion: null,
      };
      this.connections.set(conn.id, conn);
      logger.info('ws.connected', { connectionId: conn.id });

      this.send(conn, {
        kind: 'welcome',
        connectionId: conn.id,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        assetBaseUrl: this.assetBaseUrl,
      });

      socket.on('message', (raw) => this.handleMessage(conn, raw.toString()));
      socket.on('close', () => {
        this.connections.delete(conn.id);
        logger.info('ws.disconnected', { connectionId: conn.id, role: conn.role });
      });
      socket.on('error', (err) => {
        logger.warn('ws.error', { connectionId: conn.id, error: err.message });
      });
    });
  }

  private handleMessage(conn: Connection, raw: string): void {
    let msg: ClientToCompanion;
    try {
      msg = JSON.parse(raw) as ClientToCompanion;
    } catch {
      this.send(conn, { kind: 'error', code: 'invalidPayload', message: 'malformed JSON' });
      return;
    }

    switch (msg.kind) {
      case 'hello':
        this.handleHello(conn, msg);
        return;
      case 'pushDocument':
        this.handlePush(conn, msg);
        return;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        this.send(conn, { kind: 'error', code: 'invalidPayload', message: 'unknown message kind' });
      }
    }
  }

  private handleHello(conn: Connection, msg: Extract<ClientToCompanion, { kind: 'hello' }>): void {
    if (msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
      this.send(conn, {
        kind: 'error',
        code: 'protocolMismatch',
        message: `expected ${BRIDGE_PROTOCOL_VERSION}, got ${msg.protocolVersion}`,
      });
      conn.socket.close();
      return;
    }
    conn.role = msg.role;
    conn.clientVersion = msg.clientVersion;
    logger.info('ws.hello', {
      connectionId: conn.id,
      role: msg.role,
      clientVersion: msg.clientVersion,
    });
  }

  private handlePush(conn: Connection, msg: Extract<ClientToCompanion, { kind: 'pushDocument' }>): void {
    if (!conn.role) {
      this.send(conn, { kind: 'error', code: 'invalidPayload', message: 'must send hello before pushDocument' });
      return;
    }

    const targetRole: ClientRole = conn.role === 'illustrator' ? 'figma' : 'illustrator';
    const recipients = [...this.connections.values()].filter((c) => c.role === targetRole);

    const imageCount = Object.keys(msg.document.assets?.images ?? {}).length;
    logger.info('hub.routing', {
      from: conn.role,
      to: targetRole,
      recipientCount: recipients.length,
      containerCount: msg.document.containers.length,
      imageCount,
    });

    for (const recipient of recipients) {
      this.send(recipient, { kind: 'document', document: msg.document });
    }
  }

  private send(conn: Connection, msg: CompanionToClient): void {
    if (conn.socket.readyState !== WebSocket.OPEN) return;
    conn.socket.send(JSON.stringify(msg));
  }
}
