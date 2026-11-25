import { describe, expect, it } from "bun:test";
import { recognizeEndpoint } from "../endpoints.ts";

describe("recognizeEndpoint", () => {
  it("maps every data-plane codec to its endpoint exactly", () => {
    expect(recognizeEndpoint("openai_chat")).toEqual({ endpoint: "/v1/chat/completions", family: "openai", exact: true });
    expect(recognizeEndpoint("openai_responses").endpoint).toBe("/v1/responses");
    expect(recognizeEndpoint("anthropic_messages")).toEqual({ endpoint: "/v1/messages", family: "anthropic", exact: true });
    expect(recognizeEndpoint("anthropic_count_tokens").endpoint).toBe("/v1/messages/count_tokens");
    expect(recognizeEndpoint("gemini")).toEqual({ endpoint: "/v1beta/models/{model}:generateContent", family: "gemini", exact: true });
    expect(recognizeEndpoint("antigravity_internal").family).toBe("antigravity");
    expect(recognizeEndpoint("bedrock_converse").endpoint).toBe("/model/{model}/converse");
    expect(recognizeEndpoint("mcp_jsonrpc").endpoint).toBe("/mcp");
    expect(recognizeEndpoint("openai_audio_transcriptions").endpoint).toBe("/v1/audio/transcriptions");
  });

  it("recognises aliased and older codec names by keyword", () => {
    expect(recognizeEndpoint("anthropic")).toEqual({ endpoint: "/v1/messages", family: "anthropic", exact: false });
    expect(recognizeEndpoint("Claude-Messages").endpoint).toBe("/v1/messages");
    expect(recognizeEndpoint("openai-chat").endpoint).toBe("/v1/chat/completions");
    expect(recognizeEndpoint("OpenAI_Chat_Completions").endpoint).toBe("/v1/chat/completions");
    expect(recognizeEndpoint("openai").endpoint).toBe("/v1/chat/completions");
    expect(recognizeEndpoint("codex").endpoint).toBe("/v1/responses");
    expect(recognizeEndpoint("text_completion").endpoint).toBe("/v1/completions");
    expect(recognizeEndpoint("vertex_gemini").family).toBe("gemini");
    expect(recognizeEndpoint("count-tokens").endpoint).toBe("/v1/messages/count_tokens");
  });

  it("keeps paths and unknown values, and names an empty codec", () => {
    expect(recognizeEndpoint("/v1/messages")).toEqual({ endpoint: "/v1/messages", family: "anthropic", exact: false });
    expect(recognizeEndpoint("/v1beta/models/gemini-2.5-pro:streamGenerateContent").family).toBe("gemini");
    expect(recognizeEndpoint("custom_proto")).toEqual({ endpoint: "custom_proto", family: "other", exact: false });
    expect(recognizeEndpoint("").endpoint).toBe("unknown");
    expect(recognizeEndpoint(undefined).endpoint).toBe("unknown");
  });
});
