/**
 * What a turn sends to Claude Code: one user message, of the owner's text or of content blocks.
 *
 * The shape is the Agent SDK's streaming input, the only mode that takes images. A turn is one
 * user message, which carries the uuid Claude Code replays it under (`--replay-user-messages`).
 */
import type { UUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Prompt } from "../seam.ts";

type Content = SDKUserMessage["message"]["content"];
type Block = Exclude<Content, string>[number];
type ImageBlock = Extract<Block, { type: "image" }>;
type MediaType = Extract<ImageBlock["source"], { type: "base64" }>["media_type"];

// The types the API takes for a base64 image (`@anthropic-ai/sdk` `Base64ImageSource`, with the
// Agent SDK 0.3.323): a request with another one is refused as a whole.
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function contentOf(prompt: Prompt): Content {
  if (typeof prompt.content === "string") return prompt.content;
  return prompt.content.map((part): Block => {
    if (part.type === "text") return { type: "text", text: part.text };
    // The seam's media type is a plain string. An image the API would refuse is not sent: a text
    // block says so, so that the turn goes on and the session tells the owner.
    if (!IMAGE_TYPES.has(part.mediaType))
      return {
        type: "text",
        text: `[An attached image of type "${part.mediaType}" was not sent: only image/jpeg, image/png, image/gif and image/webp can be read.]`,
      };
    const media_type = part.mediaType as MediaType;
    return { type: "image", source: { type: "base64", media_type, data: part.data } };
  });
}

/**
 * `prompt` as the one user message of a turn, under its id: the message the SDK itself builds
 * for a string, plus the uuid. The id is a UUID the core made.
 */
export function userMessage(prompt: Prompt): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: contentOf(prompt) },
    parent_tool_use_id: null,
    uuid: prompt.id as UUID,
  };
}
