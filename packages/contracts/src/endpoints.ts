import { z } from "zod";

/**
 * Smart endpoint recognition for usage records. The data plane records each turn's wire codecs
 * (ingressCodec: what the client spoke, from the request path; egressCodec: what was sent
 * upstream), not the HTTP path. A codec maps to exactly one endpoint family, so the endpoint is
 * recovered from it: known codecs by table (mirrors net-go DetectIngressCodec /
 * ProviderEgressCodec), anything else (older or aliased names such as "anthropic" or
 * "openai-chat") by keyword, and a value that already is a path is kept as it is.
 */

export const EndpointFamilySchema = z.enum(["openai", "anthropic", "gemini", "antigravity", "bedrock", "mcp", "other"]);
export type EndpointFamily = z.infer<typeof EndpointFamilySchema>;

export interface RecognizedEndpoint {
  /** HTTP endpoint, e.g. "/v1/chat/completions"; `{model}` marks a path segment. */
  endpoint: string;
  family: EndpointFamily;
  /** True when the codec is a known data-plane codec (not inferred from keywords). */
  exact: boolean;
}

const KNOWN: Record<string, Omit<RecognizedEndpoint, "exact">> = {
  openai_chat: { endpoint: "/v1/chat/completions", family: "openai" },
  openai_responses: { endpoint: "/v1/responses", family: "openai" },
  openai_completions: { endpoint: "/v1/completions", family: "openai" },
  openai_embeddings: { endpoint: "/v1/embeddings", family: "openai" },
  openai_images: { endpoint: "/v1/images/generations", family: "openai" },
  openai_videos: { endpoint: "/v1/videos", family: "openai" },
  openai_audio_speech: { endpoint: "/v1/audio/speech", family: "openai" },
  openai_audio_transcriptions: { endpoint: "/v1/audio/transcriptions", family: "openai" },
  openai_audio_translations: { endpoint: "/v1/audio/translations", family: "openai" },
  openai_rerank: { endpoint: "/v1/rerank", family: "openai" },
  openai_moderations: { endpoint: "/v1/moderations", family: "openai" },
  anthropic_messages: { endpoint: "/v1/messages", family: "anthropic" },
  anthropic_count_tokens: { endpoint: "/v1/messages/count_tokens", family: "anthropic" },
  gemini: { endpoint: "/v1beta/models/{model}:generateContent", family: "gemini" },
  antigravity_internal: { endpoint: "/v1internal:generateContent", family: "antigravity" },
  bedrock_converse: { endpoint: "/model/{model}/converse", family: "bedrock" },
  mcp_jsonrpc: { endpoint: "/mcp", family: "mcp" },
  typesafe_systemone: { endpoint: "SystemOne", family: "other" },
};

/** Keyword rules for codecs outside KNOWN, most specific first. */
const RULES: [RegExp, string][] = [
  [/count_?tokens/, "anthropic_count_tokens"],
  [/anthropic|claude|messages/, "anthropic_messages"],
  [/responses|codex/, "openai_responses"],
  [/embed/, "openai_embeddings"],
  [/image/, "openai_images"],
  [/video/, "openai_videos"],
  [/speech|tts/, "openai_audio_speech"],
  [/transcri/, "openai_audio_transcriptions"],
  [/translat/, "openai_audio_translations"],
  [/rerank/, "openai_rerank"],
  [/moderat/, "openai_moderations"],
  [/antigravity|v1internal|cloudcode/, "antigravity_internal"],
  [/gemini|generate_?content|vertex|google/, "gemini"],
  [/bedrock|converse/, "bedrock_converse"],
  [/mcp|jsonrpc/, "mcp_jsonrpc"],
  [/chat/, "openai_chat"],
  [/completion/, "openai_completions"],
  [/openai|oai/, "openai_chat"],
];

function familyOfPath(path: string): EndpointFamily {
  if (path.startsWith("/v1/messages")) return "anthropic";
  if (path.startsWith("/v1beta/") || path.includes(":generateContent") || path.includes(":streamGenerateContent")) return "gemini";
  if (path.startsWith("/v1internal")) return "antigravity";
  if (path.startsWith("/model/")) return "bedrock";
  if (path === "/mcp" || path.startsWith("/mcp/")) return "mcp";
  if (path.startsWith("/v1/")) return "openai";
  return "other";
}

/** The HTTP endpoint behind a recorded wire codec (see the module comment). */
export function recognizeEndpoint(codec: string | null | undefined): RecognizedEndpoint {
  const raw = (codec ?? "").trim();
  if (!raw) return { endpoint: "unknown", family: "other", exact: false };
  if (raw.startsWith("/")) return { endpoint: raw, family: familyOfPath(raw), exact: false };
  const key = raw.toLowerCase().replace(/[\s.\-/]+/g, "_");
  const known = KNOWN[key];
  if (known) return { ...known, exact: key === raw };
  for (const [re, target] of RULES) {
    if (re.test(key)) return { ...KNOWN[target]!, exact: false };
  }
  return { endpoint: raw, family: "other", exact: false };
}
