// The terminal's one WebSocket to the API, kept open for the life of the tab.
//
// The client remembers what it wants to be subscribed to, not what the server last
// confirmed. Every new connection, first or fiftieth, authenticates if the user is signed in
// and then subscribes to all of it again, so a reconnect needs no special path: the server
// answers each book subscription with a fresh snapshot and the books resync from it.
//
// A dropped connection is retried with exponential backoff and jitter, so a restarted API is
// not hit by every open tab in the same instant. Close code 4001 means the access token
// expired; the client refreshes it first and reconnects at once.

import { useEffect } from "react";
import { create } from "zustand";
import type { Channel, ClientMessage, ServerMessage } from "@slipstream/protocol";
import { useBooks } from "./book";
import { useTrades } from "./trades";
import { API_URL, currentAccessToken, refreshAccessToken, useSession } from "./session";

export const SOCKET_URL = `${API_URL.replace(/^http/, "ws")}/ws`;

// Matches TOKEN_EXPIRED_CLOSE_CODE in the API's ws.ts.
export const TOKEN_EXPIRED_CLOSE_CODE = 4001;

export type ConnectionStatus = "connecting" | "open" | "reconnecting";

export const useConnection = create<{ status: ConnectionStatus; reconnects: number }>(() => ({
  status: "connecting",
  reconnects: 0,
}));

export type Topic = { channel: Channel; market?: string };

const keyOf = ({ channel, market }: Topic) =>
  market === undefined ? channel : `${channel}:${market}`;

export type SocketOptions = {
  url?: string;
  createSocket?: (url: string) => WebSocket;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
};

export class MarketSocket {
  readonly #url: string;
  readonly #createSocket: (url: string) => WebSocket;
  readonly #initialBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #random: () => number;

  // How many components want each topic; the server hears about the first and the last.
  readonly #wanted = new Map<string, { topic: Topic; count: number }>();
  #socket: WebSocket | undefined;
  // True once the current connection has sent its auth and subscriptions. Until then a new
  // subscription is only remembered, and goes out with the rest.
  #ready = false;
  #failures = 0;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #stopSession: (() => void) | undefined;

  constructor({
    url = SOCKET_URL,
    createSocket = (target) => new WebSocket(target),
    initialBackoffMs = 500,
    maxBackoffMs = 10_000,
    random = Math.random,
  }: SocketOptions = {}) {
    this.#url = url;
    this.#createSocket = createSocket;
    this.#initialBackoffMs = initialBackoffMs;
    this.#maxBackoffMs = maxBackoffMs;
    this.#random = random;
  }

  start(): void {
    this.#stopSession = useSession.subscribe((state, previous) => {
      if (state.status === previous.status) {
        return;
      }
      if (state.status === "signed_in" && this.#ready) {
        void this.#authenticate();
      }
      // The server keeps a connection's user until it closes, so signing out starts a new one.
      if (state.status === "signed_out" && previous.status === "signed_in") {
        this.#reconnectNow();
      }
    });
    this.#connect();
  }

  stop(): void {
    this.#stopSession?.();
    clearTimeout(this.#retry);
    const socket = this.#socket;
    this.#socket = undefined;
    this.#ready = false;
    socket?.close(1000);
  }

  subscribe(topic: Topic): void {
    const key = keyOf(topic);
    const entry = this.#wanted.get(key);
    if (entry !== undefined) {
      entry.count += 1;
      return;
    }
    this.#wanted.set(key, { topic, count: 1 });
    this.#sendIfReady({ op: "subscribe", ...topic });
  }

  unsubscribe(topic: Topic): void {
    const key = keyOf(topic);
    const entry = this.#wanted.get(key);
    if (entry === undefined) {
      return;
    }
    entry.count -= 1;
    if (entry.count === 0) {
      this.#wanted.delete(key);
      this.#sendIfReady({ op: "unsubscribe", ...topic });
    }
  }

  // Subscribing again while subscribed makes the server send a fresh snapshot.
  resync(topic: Topic): void {
    if (this.#wanted.has(keyOf(topic))) {
      this.#sendIfReady({ op: "subscribe", ...topic });
    }
  }

  #send(message: ClientMessage): void {
    this.#socket?.send(JSON.stringify(message));
  }

  #sendIfReady(message: ClientMessage): void {
    if (this.#ready) {
      this.#send(message);
    }
  }

  #connect(): void {
    useConnection.setState({ status: this.#failures === 0 ? "connecting" : "reconnecting" });
    const socket = this.#createSocket(this.#url);
    this.#socket = socket;

    socket.onopen = () => {
      void this.#handshake(socket);
    };
    socket.onmessage = (event: MessageEvent) => {
      // The server sends only JSON text it built itself.
      const message = JSON.parse(String(event.data)) as ServerMessage;
      this.#receive(message);
    };
    socket.onclose = (event: CloseEvent) => {
      // A socket replaced on purpose (sign out, stop) has already been forgotten.
      if (this.#socket !== socket) {
        return;
      }
      this.#socket = undefined;
      this.#ready = false;
      useBooks.getState().markAllUnsynced();
      // Whatever trades while the socket is down come back with the history refetch.
      useTrades.getState().clearAll();
      this.#scheduleReconnect(event.code);
    };
  }

  async #handshake(socket: WebSocket): Promise<void> {
    if (useSession.getState().status === "signed_in") {
      let token: string | undefined;
      try {
        token = await currentAccessToken();
      } catch (error) {
        // Public channels still work; private ones wait for the next connection.
        console.warn("socket connected without authenticating", error);
      }
      if (this.#socket !== socket) {
        return;
      }
      if (token !== undefined) {
        this.#send({ op: "auth", token });
      }
    }
    // The server handles one connection's messages in order, so these follow the auth.
    for (const { topic } of this.#wanted.values()) {
      this.#send({ op: "subscribe", ...topic });
    }
    this.#ready = true;
    this.#failures = 0;
    useConnection.setState({ status: "open" });
  }

  async #authenticate(refresh = false): Promise<void> {
    try {
      const token = await (refresh ? refreshAccessToken() : currentAccessToken());
      if (token !== undefined) {
        this.#sendIfReady({ op: "auth", token });
      }
    } catch (error) {
      console.warn("socket could not authenticate", error);
    }
  }

  #receive(message: ServerMessage): void {
    if (message.type === "book" || message.type === "book_update") {
      if (useBooks.getState().receive(message) === "gap") {
        this.resync({ channel: "book", market: message.market });
      }
    }
    if (message.type === "trade") {
      useTrades.getState().receive(message);
    }
    // The token in memory had expired before the server checked it; get a new one and retry.
    if (message.type === "error" && message.error === "token_expired") {
      void this.#authenticate(true);
    }
  }

  #scheduleReconnect(code: number): void {
    useConnection.setState((state) => ({
      status: "reconnecting",
      reconnects: state.reconnects + 1,
    }));
    if (code === TOKEN_EXPIRED_CLOSE_CODE) {
      // Refreshed first, so the handshake authenticates with a token the server accepts. If
      // the API cannot be reached for that, it cannot be reached for the socket either.
      refreshAccessToken().then(
        () => {
          this.#connect();
        },
        () => {
          this.#backOff();
        },
      );
      return;
    }
    this.#backOff();
  }

  #backOff(): void {
    // Full jitter on top of the doubling: anywhere from half the delay to all of it.
    const ceiling = Math.min(this.#maxBackoffMs, this.#initialBackoffMs * 2 ** this.#failures);
    const delay = ceiling / 2 + (this.#random() * ceiling) / 2;
    this.#failures += 1;
    this.#retry = setTimeout(() => {
      this.#connect();
    }, delay);
  }

  #reconnectNow(): void {
    const socket = this.#socket;
    this.#socket = undefined;
    this.#ready = false;
    socket?.close(1000);
    clearTimeout(this.#retry);
    this.#connect();
  }
}

let shared: MarketSocket | undefined;

// The tab's socket, opened on first use. Only ever called from effects, so never on the server.
export function marketSocket(): MarketSocket {
  if (shared === undefined) {
    shared = new MarketSocket();
    shared.start();
  }
  return shared;
}

// Subscribed while the calling component is mounted.
export function useSubscription(channel: Channel, market?: string): void {
  useEffect(() => {
    const socket = marketSocket();
    const topic = { channel, market };
    socket.subscribe(topic);
    return () => {
      socket.unsubscribe(topic);
    };
  }, [channel, market]);
}
