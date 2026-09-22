import test from "node:test";
import assert from "node:assert/strict";

import { FreebuffExecutor } from "../../open-sse/executors/freebuff.ts";
import type { ExecuteInput } from "../../open-sse/executors/base.ts";
import { freebuffProvider } from "../../open-sse/config/providers/registry/freebuff/index.ts";
import { APIKEY_PROVIDERS_GATEWAYS } from "../../src/shared/constants/providers/apikey/gateways.ts";
import { validateFreebuffProvider } from "../../src/lib/providers/validation.ts";
import { createFreebuffFetchMock, withFreebuffFetch } from "./helpers/freebuff-fixtures.ts";

test("FreebuffExecutor: constructor initializes provider name correctly", () => {
  const executor = new FreebuffExecutor();
  assert.equal(executor.getProvider(), "freebuff");
});

test("FreebuffExecutor: returns 401 response when credentials are missing", async () => {
  const executor = new FreebuffExecutor();
  const res = await executor.execute({
    model: "deepseek/deepseek-v4-flash",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: false,
    credentials: { apiKey: "" },
  } as unknown as ExecuteInput);

  assert.equal(res.response.status, 401);
  const data = (await res.response.json()) as { error: { message: string } };
  assert.match(data.error.message, /Freebuff Auth Token required/i);
});

test("freebuffProvider: registry entry has valid structure and catalog", () => {
  assert.equal(freebuffProvider.id, "freebuff");
  assert.equal(freebuffProvider.format, "openai");
  assert.equal(freebuffProvider.executor, "freebuff");
  assert.equal(freebuffProvider.baseUrl, "https://www.codebuff.com/api/v1");
  assert.ok(Array.isArray(freebuffProvider.models));
  assert.ok(freebuffProvider.models.length >= 7);
  assert.equal(freebuffProvider.liveCatalogAuthoritative, true);

  const flash = freebuffProvider.models.find((m) => m.id === "deepseek/deepseek-v4-flash");
  assert.ok(flash, "deepseek/deepseek-v4-flash must exist in freebuff models");
  assert.equal(flash?.supportsReasoning, true);

  const withdrawn = freebuffProvider.models.find((m) => m.id === "minimax/minimax-m3");
  assert.equal(withdrawn, undefined, "withdrawn models must not be advertised");
});

test("APIKEY_PROVIDERS_GATEWAYS: freebuff gateway metadata is defined", () => {
  const fb = APIKEY_PROVIDERS_GATEWAYS.freebuff;
  assert.ok(fb, "freebuff must be in APIKEY_PROVIDERS_GATEWAYS");
  assert.equal(fb.id, "freebuff");
  assert.equal(fb.name, "Freebuff");
  assert.equal(fb.color, "#10B981");
  assert.equal(fb.hasFree, true);
});

test("validateFreebuffProvider: returns invalid when apiKey is empty", async () => {
  const res = await validateFreebuffProvider({ apiKey: "" });
  assert.equal(res.valid, false);
  assert.match(res.error || "", /Freebuff Auth Token required/i);
});

test("validateFreebuffProvider: uses read-only /me credential validation", async () => {
  const { fetch: fetchMock, calls } = createFreebuffFetchMock([
    {
      match: /\/api\/v1\/me\?fields=id$/,
      response: new Response(JSON.stringify({ id: "fixture-user" }), {
        headers: { "Content-Type": "application/json" },
      }),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    validateFreebuffProvider({ apiKey: "fixture-token" })
  );

  assert.equal(result.valid, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.init.method, "GET");
  assert.match(calls[0]?.url || "", /\/api\/v1\/me\?fields=id$/);
  assert.equal(
    calls.some((call) => call.url.includes("/freebuff/session")),
    false
  );
});

test("validateFreebuffProvider: distinguishes authentication and forbidden responses", async () => {
  for (const fixture of [
    { status: 401, message: /Invalid or expired/i },
    { status: 403, message: /forbidden/i },
  ]) {
    const { fetch: fetchMock } = createFreebuffFetchMock([
      {
        match: /\/api\/v1\/me\?fields=id$/,
        response: new Response("{}", { status: fixture.status }),
      },
    ]);

    const result = await withFreebuffFetch(fetchMock, () =>
      validateFreebuffProvider({ apiKey: "fixture-token" })
    );
    assert.equal(result.valid, false);
    assert.match(result.error || "", fixture.message);
  }
});

test("validateFreebuffProvider: rejects malformed success responses without leaking bodies", async () => {
  const { fetch: fetchMock } = createFreebuffFetchMock([
    {
      match: /\/api\/v1\/me\?fields=id$/,
      response: new Response(
        JSON.stringify({ diagnostic: "synthetic sensitive-looking diagnostic" }),
        { headers: { "Content-Type": "application/json" } }
      ),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    validateFreebuffProvider({ apiKey: "fixture-token" })
  );

  assert.equal(result.valid, false);
  assert.match(result.error || "", /invalid response shape/i);
  assert.doesNotMatch(result.error || "", /sensitive-looking diagnostic/i);
});

test("validateFreebuffProvider: sanitizes network failures", async () => {
  const { fetch: fetchMock } = createFreebuffFetchMock([
    {
      match: /\/api\/v1\/me\?fields=id$/,
      error: new Error("synthetic network detail bearer-secret-should-not-leak"),
    },
  ]);

  const result = await withFreebuffFetch(fetchMock, () =>
    validateFreebuffProvider({ apiKey: "fixture-token" })
  );

  assert.equal(result.valid, false);
  assert.match(result.error || "", /could not reach/i);
  assert.doesNotMatch(result.error || "", /bearer-secret|synthetic network detail/i);
});
