import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import test from "node:test";

import { WebSocket } from "ws";

import type { VoxRtcGateway, VoxRtcGatewayOptions } from "../src/index.js";
import { createVoxRtcGatewayWithClientFactory } from "../src/gateway.js";

type WireEvent = {
  type: string;
  data: Record<string, unknown>;
  sessionId: string;
  channelName: string;
};

class FakeSession {
  readonly sessionId = "rtc_private";
  sent: Array<{ type: string; data: unknown }> = [];
  closeCalls = 0;
  handlers = new Set<(event: WireEvent) => void>();

  onEvent(handler: (event: WireEvent) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  sendOffer(offer: unknown, options: unknown) {
    this.sent.push({ type: "rtc.offer", data: { offer, options } });
  }

  sendIceCandidate(candidate: unknown) {
    this.sent.push({ type: "rtc.ice_candidate", data: candidate });
  }

  closeRtc(reason: string) {
    this.sent.push({ type: "rtc.close", data: { reason } });
  }

  close() {
    this.closeCalls += 1;
  }

  emit(type: string, data: Record<string, unknown>) {
    for (const handler of this.handlers) {
      handler({
        type,
        data,
        sessionId: this.sessionId,
        channelName: `/rtc/${this.sessionId}`,
      });
    }
  }
}

function fakeClient(session: FakeSession) {
  return {
    createCalls: 0,
    disconnectCalls: 0,
    async createControlledSession() {
      this.createCalls += 1;
      return {
        bootstrap: {
          sessionId: session.sessionId,
          expiresAt: "2026-07-16T12:00:00Z",
          attachTtlSeconds: 120,
          iceServers: [{ urls: ["stun:turn.example.test:3478"] }],
        },
        session,
      };
    },
    disconnect() {
      this.disconnectCalls += 1;
    },
  };
}

function createTestGateway(
  session: FakeSession,
  options: Omit<VoxRtcGatewayOptions, "voxHttpBase" | "apiKey"> = {},
): { gateway: VoxRtcGateway; client: ReturnType<typeof fakeClient> } {
  const client = fakeClient(session);
  const gateway = createVoxRtcGatewayWithClientFactory(
    {
      voxHttpBase: "http://vox.internal.test:11435",
      apiKey: "must-not-leak",
      ...options,
    },
    () => client as never,
  );
  return { gateway, client };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (raw) => {
      try {
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
  });
}

test("gateway constructs and owns its Vox client without an authentication callback", async () => {
  const session = new FakeSession();
  const client = fakeClient(session);
  let receivedOptions: { httpBase: string; apiKey?: string } | null = null;
  const gateway = createVoxRtcGatewayWithClientFactory(
    {
      voxHttpBase: "http://vox.internal.test:11435",
      apiKey: "vox-secret",
    },
    (options) => {
      receivedOptions = options;
      return client as never;
    },
  );

  assert.deepEqual(receivedOptions, {
    httpBase: "http://vox.internal.test:11435",
    apiKey: "vox-secret",
  });
  await gateway.close();
  assert.equal(client.disconnectCalls, 1);
});

test("gateway provides full trickle signaling without leaking Vox credentials", async () => {
  const session = new FakeSession();
  const server = createServer();
  const created: unknown[] = [];
  const closed: string[] = [];
  let upgradeRequest: unknown;
  server.on("upgrade", (request) => {
    upgradeRequest = request;
  });
  const { gateway } = createTestGateway(session, {
    path: "/api/vox/rtc",
    onSessionCreated: (context) => created.push(context),
    onSessionClosed: (context) => closed.push(context.reason),
  });
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`, {
    headers: { "x-user-id": "user-1" },
  });

  try {
    const readyPromise = nextMessage(ws);
    await once(ws, "open");
    const ready = await readyPromise;
    assert.equal(ready.type, "gateway.ready");
    const readyData = ready.data as Record<string, unknown>;
    const capability = String(readyData.capability);
    assert.ok(capability.length >= 32);
    assert.equal(JSON.stringify(ready).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(ready).includes("voxHttpBase"), false);
    assert.equal(
      (readyData.session as Record<string, unknown>).sessionId,
      "rtc_private",
    );
    assert.equal(created.length, 1);
    assert.equal((created[0] as { request: unknown }).request, upgradeRequest);
    assert.equal((created[0] as { session: unknown }).session, session);
    assert.equal(
      (created[0] as { request: { headers: Record<string, string> } }).request
        .headers["x-user-id"],
      "user-1",
    );

    ws.send(
      JSON.stringify({
        id: "offer-1",
        type: "rtc.offer",
        capability,
        data: {
          offer: { type: "offer", sdp: "offer-sdp" },
          restart: false,
          generation: 1,
        },
      }),
    );
    ws.send(
      JSON.stringify({
        id: "candidate-1",
        type: "rtc.ice_candidate",
        capability,
        data: {
          generation: 1,
          candidate: {
            candidate: "candidate:first",
            sdpMid: "audio",
            sdpMLineIndex: 0,
            usernameFragment: "ufrag",
          },
        },
      }),
    );
    ws.send(
      JSON.stringify({
        id: "candidate-complete",
        type: "rtc.ice_candidate",
        capability,
        data: { candidate: null, generation: 1 },
      }),
    );

    while (session.sent.length < 3)
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      session.sent.map((item) => item.type),
      ["rtc.offer", "rtc.ice_candidate", "rtc.ice_candidate"],
    );
    assert.equal(
      session.sent[1]?.data &&
        (session.sent[1].data as { sdpMLineIndex: number }).sdpMLineIndex,
      0,
    );
    assert.equal(session.sent[2]?.data, null);

    const answerPromise = nextMessage(ws);
    session.emit("rtc.answer", {
      session_id: session.sessionId,
      answer: { type: "answer", sdp: "answer-sdp" },
    });
    const answer = await answerPromise;
    assert.equal(answer.id, "offer-1");
    assert.equal(answer.type, "rtc.answer");

    const candidatePromise = nextMessage(ws);
    session.emit("rtc.ice_candidate", { candidate: null });
    const candidate = await candidatePromise;
    assert.equal(candidate.type, "rtc.ice_candidate");
    assert.deepEqual(candidate.data, { candidate: null, generation: 1 });

    ws.send(
      JSON.stringify({
        id: "offer-2",
        type: "rtc.offer",
        capability,
        data: {
          offer: { type: "offer", sdp: "restart-sdp" },
          restart: true,
          generation: 2,
        },
      }),
    );
    while (session.sent.length < 4)
      await new Promise((resolve) => setImmediate(resolve));
    const staleErrorPromise = nextMessage(ws);
    ws.send(
      JSON.stringify({
        id: "candidate-stale",
        type: "rtc.ice_candidate",
        capability,
        data: {
          generation: 1,
          candidate: {
            candidate: "candidate:stale",
            sdpMid: "audio",
            sdpMLineIndex: 0,
          },
        },
      }),
    );
    const staleError = await staleErrorPromise;
    assert.equal(staleError.id, "candidate-stale");
    assert.equal(staleError.type, "gateway.error");
    assert.match(
      String((staleError.data as Record<string, unknown>).message),
      /Stale RTC candidate generation/,
    );
    assert.equal(session.sent.length, 4);

    const restartAnswerPromise = nextMessage(ws);
    session.emit("rtc.answer", {
      session_id: session.sessionId,
      answer: { type: "answer", sdp: "restart-answer-sdp" },
    });
    const restartAnswer = await restartAnswerPromise;
    assert.equal(restartAnswer.id, "offer-2");

    ws.close();
    await once(ws, "close");
    while (closed.length === 0)
      await new Promise((resolve) => setImmediate(resolve));
    session.emit("rtc.session.closed", { reason: "late_duplicate" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.closeCalls, 1);
    assert.deepEqual(closed, ["browser_disconnected"]);
  } finally {
    if (ws.readyState === WebSocket.OPEN) ws.close();
    detach();
    await closeServer(server);
  }
});

test("gateway rejects an invalid capability and cleans up exactly once", async () => {
  const session = new FakeSession();
  const server = createServer();
  const closed: string[] = [];
  const { gateway } = createTestGateway(session, {
    onSessionClosed: (context) => closed.push(context.reason),
  });
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    const readyPromise = nextMessage(ws);
    await once(ws, "open");
    await readyPromise;
    const errorPromise = nextMessage(ws);
    ws.send(
      JSON.stringify({
        id: "bad-1",
        type: "rtc.offer",
        capability: "not-the-capability",
        data: { offer: { type: "offer", sdp: "offer-sdp" } },
      }),
    );
    const error = await errorPromise;
    assert.equal(error.type, "gateway.error");
    await once(ws, "close");
    assert.equal(session.closeCalls, 1);
    assert.deepEqual(closed, ["invalid_capability"]);
  } finally {
    detach();
    await closeServer(server);
  }
});

test("an explicit browser close does not send a duplicate RTC close", async () => {
  const session = new FakeSession();
  const server = createServer();
  const { gateway } = createTestGateway(session);
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    const readyPromise = nextMessage(ws);
    await once(ws, "open");
    const ready = await readyPromise;
    const capability = String(
      (ready.data as Record<string, unknown>).capability,
    );
    ws.send(
      JSON.stringify({
        id: "close-1",
        type: "rtc.close",
        capability,
        data: { reason: "user_hangup" },
      }),
    );
    while (!session.sent.some((message) => message.type === "rtc.close")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    ws.close();
    await once(ws, "close");
    while (session.closeCalls === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(
      session.sent.filter((message) => message.type === "rtc.close"),
      [{ type: "rtc.close", data: { reason: "user_hangup" } }],
    );
    assert.equal(session.closeCalls, 1);
  } finally {
    detach();
    await closeServer(server);
  }
});

test("a synchronous onSessionCreated failure rolls the controlled session back", async () => {
  const session = new FakeSession();
  const server = createServer();
  const closed: string[] = [];
  const { gateway } = createTestGateway(session, {
    onSessionCreated: () => {
      throw new Error("application setup rejected the session");
    },
    onSessionClosed: (context) => closed.push(context.reason),
  });
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    await once(ws, "open");
    await once(ws, "close");
    assert.equal(session.closeCalls, 1);
    assert.equal(session.handlers.size, 0);
    assert.deepEqual(session.sent.at(-1), {
      type: "rtc.close",
      data: { reason: "session_created_hook_failed" },
    });
    assert.deepEqual(closed, ["session_created_hook_failed"]);
  } finally {
    detach();
    await closeServer(server);
  }
});

test("an asynchronous onSessionCreated rejection rolls the controlled session back", async () => {
  const session = new FakeSession();
  const server = createServer();
  const closed: string[] = [];
  const { gateway } = createTestGateway(session, {
    onSessionCreated: async () => {
      await Promise.resolve();
      throw new Error("asynchronous application setup failure");
    },
    onSessionClosed: (context) => closed.push(context.reason),
  });
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    await once(ws, "open");
    await once(ws, "close");
    assert.equal(session.closeCalls, 1);
    assert.equal(session.handlers.size, 0);
    assert.deepEqual(session.sent.at(-1), {
      type: "rtc.close",
      data: { reason: "session_created_hook_failed" },
    });
    assert.deepEqual(closed, ["session_created_hook_failed"]);
  } finally {
    detach();
    await closeServer(server);
  }
});

test("a Vox-side session failure closes the browser and backend exactly once", async () => {
  const session = new FakeSession();
  const server = createServer();
  const closed: string[] = [];
  const { gateway } = createTestGateway(session, {
    onSessionClosed: (context) => closed.push(context.reason),
  });
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    const readyPromise = nextMessage(ws);
    await once(ws, "open");
    await readyPromise;
    const closedPromise = once(ws, "close");
    session.emit("rtc.session.closed", { reason: "peer_failed" });
    await closedPromise;
    session.emit("rtc.session.closed", { reason: "late_duplicate" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.closeCalls, 1);
    assert.equal(session.handlers.size, 0);
    assert.equal(
      session.sent.some((message) => message.type === "rtc.close"),
      false,
    );
    assert.deepEqual(closed, ["peer_failed"]);
  } finally {
    detach();
    await closeServer(server);
  }
});

test("browser disconnect during session creation closes the eventual backend session", async () => {
  const session = new FakeSession();
  const server = createServer();
  const closed: string[] = [];
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const client = fakeClient(session);
  client.createControlledSession = async () => {
    await sessionGate;
    return fakeClient(session).createControlledSession();
  };
  const gateway = createVoxRtcGatewayWithClientFactory(
    {
      voxHttpBase: "http://vox.internal.test:11435",
      onSessionClosed: (context) => closed.push(context.reason),
    },
    () => client as never,
  );
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    await once(ws, "open");
    ws.close();
    await once(ws, "close");
    releaseSession();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(session.closeCalls, 1);
    assert.equal(session.handlers.size, 0);
    assert.deepEqual(closed, ["browser_disconnected"]);
  } finally {
    releaseSession();
    detach();
    await closeServer(server);
  }
});

test("browser disconnect waits for the session-created hook before session cleanup", async () => {
  const session = new FakeSession();
  const server = createServer();
  const lifecycle: string[] = [];
  let releaseHook!: () => void;
  let markHookStarted!: () => void;
  const hookGate = new Promise<void>((resolve) => {
    releaseHook = resolve;
  });
  const hookStarted = new Promise<void>((resolve) => {
    markHookStarted = resolve;
  });
  const { gateway } = createTestGateway(session, {
    onSessionCreated: async () => {
      lifecycle.push("created:start");
      markHookStarted();
      await hookGate;
      lifecycle.push("created:end");
    },
    onSessionClosed: () => {
      lifecycle.push("closed");
    },
  });
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    await once(ws, "open");
    await hookStarted;
    ws.close();
    await once(ws, "close");
    releaseHook();
    while (lifecycle.length < 3)
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(lifecycle, ["created:start", "created:end", "closed"]);
    assert.equal(session.closeCalls, 1);
    assert.equal(session.handlers.size, 0);
  } finally {
    releaseHook();
    detach();
    await closeServer(server);
  }
});

test("a malformed offer preserves correlation and does not poison the next offer", async () => {
  const session = new FakeSession();
  const server = createServer();
  const { gateway } = createTestGateway(session);
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    const readyPromise = nextMessage(ws);
    await once(ws, "open");
    const ready = await readyPromise;
    const capability = String(
      (ready.data as Record<string, unknown>).capability,
    );

    const errorPromise = nextMessage(ws);
    ws.send(
      JSON.stringify({
        id: "offer-bad",
        type: "rtc.offer",
        capability,
        data: { offer: { type: "offer", sdp: "" }, generation: 1 },
      }),
    );
    const error = await errorPromise;
    assert.equal(error.id, "offer-bad");
    assert.equal(error.type, "gateway.error");

    ws.send(
      JSON.stringify({
        id: "offer-good",
        type: "rtc.offer",
        capability,
        data: { offer: { type: "offer", sdp: "valid-offer" }, generation: 1 },
      }),
    );
    while (session.sent.length === 0)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.sent[0]?.type, "rtc.offer");

    const answerPromise = nextMessage(ws);
    session.emit("rtc.answer", {
      session_id: session.sessionId,
      answer: { type: "answer", sdp: "answer-sdp" },
    });
    const answer = await answerPromise;
    assert.equal(answer.id, "offer-good");
    assert.equal(answer.type, "rtc.answer");
  } finally {
    ws.close();
    detach();
    await closeServer(server);
  }
});

test("gateway shutdown closes every active session exactly once", async () => {
  const session = new FakeSession();
  const server = createServer();
  const closed: string[] = [];
  const { gateway, client } = createTestGateway(session, {
    onSessionClosed: (context) => closed.push(context.reason),
  });
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    const readyPromise = nextMessage(ws);
    await once(ws, "open");
    await readyPromise;
    const closePromise = once(ws, "close");
    await gateway.close();
    await closePromise;
    await gateway.close();
    assert.equal(session.closeCalls, 1);
    assert.equal(client.disconnectCalls, 1);
    assert.deepEqual(closed, ["gateway_shutdown"]);
  } finally {
    detach();
    await closeServer(server);
  }
});

test("gateway shutdown during session creation closes the eventual backend session", async () => {
  const session = new FakeSession();
  const server = createServer();
  const closed: string[] = [];
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const client = fakeClient(session);
  client.createControlledSession = async () => {
    await sessionGate;
    return fakeClient(session).createControlledSession();
  };
  const gateway = createVoxRtcGatewayWithClientFactory(
    {
      voxHttpBase: "http://vox.internal.test:11435",
      onSessionClosed: (context) => closed.push(context.reason),
    },
    () => client as never,
  );
  const detach = gateway.attach(server);
  const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/vox/rtc`);

  try {
    await once(ws, "open");
    const closePromise = gateway.close("backend_shutdown");
    releaseSession();
    await closePromise;
    assert.equal(session.closeCalls, 1);
    assert.equal(client.disconnectCalls, 1);
    assert.deepEqual(closed, ["backend_shutdown"]);
  } finally {
    releaseSession();
    if (ws.readyState === WebSocket.OPEN) ws.close();
    detach();
    await closeServer(server);
  }
});
