import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatCompletionsUrl, gigachatModel, upstreamBodySnippet } from "./gigachat.ts";

describe("chatCompletionsUrl", () => {
  it("uses the documented base and joins the chat path", () => {
    const previous = process.env.GIGACHAT_API_URL;
    delete process.env.GIGACHAT_API_URL;
    try {
      assert.equal(chatCompletionsUrl(), "https://api.giga.chat/v1/chat/completions");
      assert.equal(chatCompletionsUrl(""), "https://api.giga.chat/v1/chat/completions");
      assert.equal(
        chatCompletionsUrl("https://gigachat.devices.sberbank.ru/api/v1/"),
        "https://gigachat.devices.sberbank.ru/api/v1/chat/completions",
      );
      assert.equal(
        chatCompletionsUrl("https://api.giga.chat/v1/chat/completions"),
        "https://api.giga.chat/v1/chat/completions",
      );
    } finally {
      if (previous === undefined) delete process.env.GIGACHAT_API_URL;
      else process.env.GIGACHAT_API_URL = previous;
    }
  });
});

describe("gigachatModel", () => {
  it("sends GigaChat-2 instead of the retired id", () => {
    const previous = process.env.GIGACHAT_MODEL;
    delete process.env.GIGACHAT_MODEL;
    try {
      assert.equal(gigachatModel(), "GigaChat-2");
      assert.equal(gigachatModel(""), "GigaChat-2");
      assert.equal(gigachatModel("GigaChat"), "GigaChat-2");
      assert.equal(gigachatModel(" GigaChat "), "GigaChat-2");
      assert.equal(gigachatModel("GigaChat-2-Max"), "GigaChat-2-Max");
    } finally {
      if (previous === undefined) delete process.env.GIGACHAT_MODEL;
      else process.env.GIGACHAT_MODEL = previous;
    }
  });
});

describe("upstreamBodySnippet", () => {
  it("keeps a short body and drops token-like fields", () => {
    const snippet = upstreamBodySnippet(
      '{"status":404,"message":"No such model","access_token":"secret-value"}\nAuthorization: Bearer abc.def',
    );
    assert.match(snippet, /No such model/);
    assert.equal(snippet.includes("secret-value"), false);
    assert.equal(snippet.includes("abc.def"), false);
    assert.equal(snippet.length <= 180, true);
  });
});
