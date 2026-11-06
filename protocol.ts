// The WebSocket protocol at /ws: what a client may send and what the server sends back. The
// API (ws.ts, feed.ts) and the web terminal both use these types, so this file holds types
// only and imports nothing: the terminal imports it from outside its own package, and a type
// import is erased before its bundler would have to resolve the file.

export type Side = "buy" | "sell";

export type Channel = "book" | "trades" | "account";

// book and trades name a market; account never does, since it is the authenticated user's
// own. ws.ts validates that rule; the type keeps the wire shape the schema produces.
export type ClientMessage =
  | { op: "auth"; token: string }
  | { op: "subscribe" | "unsubscribe"; channel: Channel; market?: string };

export type Level = { price: string; quantity: string };

export type ServerMessage =
  | { type: "subscribed" | "unsubscribed"; channel: string; market?: string }
  | { type: "authenticated"; expiresAt: string }
  | { type: "error"; error: string; message: string }
  | {
      type: "order";
      market: string;
      id: string;
      clientOrderId: string | null;
      status: string;
      filledQuantity: string;
      sequence: number;
    }
  | {
      // The whole balance sheet. Keep the one with the highest version: two markets can
      // settle for the same user at once, and their balance reads can arrive out of order.
      type: "balances";
      version: number;
      balances: { asset: string; available: string; reserved: string }[];
    }
  | { type: "book"; market: string; sequence: number; bids: Level[]; asks: Level[] }
  | {
      type: "book_update";
      market: string;
      firstSequence: number;
      sequence: number;
      // The new total at each level the command changed; "0" removes the level.
      changes: (Level & { side: Side })[];
    }
  | {
      type: "trade";
      market: string;
      sequence: number;
      price: string;
      quantity: string;
      takerSide: Side;
      time: string;
    };
