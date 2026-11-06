import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The socket asks the session for tokens; here the session is a stand-in whose answers each
// test controls.
const session = vi.hoisted(() => ({
  status: "signed_out" as string,
  current: vi.fn<() => Promise<string | undefined>>(),
  refresh: vi.fn<() => Promise<string | undefined>>(),
}));

vi.mock("./session", async () => {
  const { create } = await import("zustand");
  return {
    API_URL: "http://localhost:3000",
    useSession: create(() => ({ status: session.status })),
    currentAccessToken: session.current,
    refreshAccessToken: session.refresh,
  };
});

const { MarketSocket, TOKEN_EXPIRED_CLOSE_CODE } = await import("./socket");
const { useBooks } = await import("./book");
const { useSession } = await import("./session");

class FakeSocket {
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  closedWith: number | undefined;

  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  close(code: number) {
    this.closedWith = code;
  }
  open() {
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

let sockets: FakeSocket[];
let socket: InstanceType<typeof MarketSocket>;

const latest = () => sockets[sockets.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  session.status = "signed_out";
  useSession.setState({ status: "signed_out" });
  session.current.mockReset();
  session.refresh.mockReset();
  useBooks.setState({ books: {} });
  socket = new MarketSocket({
    url: "ws://test/ws",
    createSocket: () => {
      const fake = new FakeSocket();
      sockets.push(fake);
      return fake as unknown as WebSocket;
    },
    initialBackoffMs: 100,
    maxBackoffMs: 1000,
    random: () => 1,
  });
});

afterEach(() => {
  socket.stop();
  vi.useRealTimers();
});

const book = (sequence: number) => ({
  type: "book",
  market: "BTC-USD",
  sequence,
  bids: [{ price: "100.00000000", quantity: "1.00000000" }],
  asks: [],
});

describe("market socket", () => {
  it("sends subscriptions made before the socket opened once it opens", async () => {
    socket.start();
    socket.subscribe({ channel: "book", market: "BTC-USD" });
    expect(latest().sent).toEqual([]);

    latest().open();
    await vi.runAllTimersAsync();

    expect(latest().sent).toEqual([{ op: "subscribe", channel: "book", market: "BTC-USD" }]);
  });

  it("tells the server only about the first subscriber and the last to leave", async () => {
    socket.start();
    latest().open();
    await vi.runAllTimersAsync();

    socket.subscribe({ channel: "trades", market: "BTC-USD" });
    socket.subscribe({ channel: "trades", market: "BTC-USD" });
    socket.unsubscribe({ channel: "trades", market: "BTC-USD" });
    expect(latest().sent).toHaveLength(1);
    socket.unsubscribe({ channel: "trades", market: "BTC-USD" });

    expect(latest().sent).toEqual([
      { op: "subscribe", channel: "trades", market: "BTC-USD" },
      { op: "unsubscribe", channel: "trades", market: "BTC-USD" },
    ]);
  });

  it("reconnects with growing delays and subscribes to everything again", async () => {
    socket.start();
    socket.subscribe({ channel: "book", market: "BTC-USD" });
    socket.subscribe({ channel: "trades", market: "ETH-USD" });
    latest().open();
    await vi.runAllTimersAsync();

    latest().drop();
    await vi.advanceTimersByTimeAsync(99);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    // Failing again doubles the wait.
    latest().drop();
    await vi.advanceTimersByTimeAsync(199);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    latest().open();
    await vi.runAllTimersAsync();

    expect(latest().sent).toEqual([
      { op: "subscribe", channel: "book", market: "BTC-USD" },
      { op: "subscribe", channel: "trades", market: "ETH-USD" },
    ]);
  });

  it("marks books unsynced while disconnected", async () => {
    socket.start();
    socket.subscribe({ channel: "book", market: "BTC-USD" });
    latest().open();
    await vi.runAllTimersAsync();
    latest().receive(book(5));
    expect(useBooks.getState().books["BTC-USD"]?.synced).toBe(true);

    latest().drop();

    expect(useBooks.getState().books["BTC-USD"]?.synced).toBe(false);
  });

  it("asks for a fresh snapshot when a delta skips a sequence", async () => {
    socket.start();
    socket.subscribe({ channel: "book", market: "BTC-USD" });
    latest().open();
    await vi.runAllTimersAsync();
    latest().receive(book(5));

    latest().receive({
      type: "book_update",
      market: "BTC-USD",
      firstSequence: 7,
      sequence: 7,
      changes: [],
    });

    expect(latest().sent).toEqual([
      { op: "subscribe", channel: "book", market: "BTC-USD" },
      { op: "subscribe", channel: "book", market: "BTC-USD" },
    ]);
    latest().receive(book(7));
    expect(useBooks.getState().books["BTC-USD"]).toMatchObject({ synced: true, gaps: 1 });
  });

  it("authenticates before subscribing when signed in", async () => {
    useSession.setState({ status: "signed_in" });
    session.current.mockResolvedValue("token-1");
    socket.start();
    socket.subscribe({ channel: "account" });

    latest().open();
    await vi.runAllTimersAsync();

    expect(latest().sent).toEqual([
      { op: "auth", token: "token-1" },
      { op: "subscribe", channel: "account" },
    ]);
  });

  it("refreshes the token and reconnects at once after a token-expired close", async () => {
    useSession.setState({ status: "signed_in" });
    session.current.mockResolvedValueOnce("old");
    socket.start();
    latest().open();
    await vi.runAllTimersAsync();

    session.refresh.mockResolvedValueOnce("new");
    session.current.mockResolvedValueOnce("new");
    latest().drop(TOKEN_EXPIRED_CLOSE_CODE);
    await vi.advanceTimersByTimeAsync(0);
    latest().open();
    await vi.runAllTimersAsync();

    expect(session.refresh).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(latest().sent).toEqual([{ op: "auth", token: "new" }]);
  });

  it("opens a new connection on sign out, so the server forgets the user", async () => {
    useSession.setState({ status: "signed_in" });
    session.current.mockResolvedValue("token-1");
    socket.start();
    latest().open();
    await vi.runAllTimersAsync();

    useSession.setState({ status: "signed_out" });

    expect(sockets[0]?.closedWith).toBe(1000);
    expect(sockets).toHaveLength(2);
  });
});
