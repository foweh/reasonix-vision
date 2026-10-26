/** Image input for chat turns: extension→MIME, size caps, data-URL loading, content parts.
 *  Wire format is the standard OpenAI multimodal shape DeepSeek V4.1 accepts. */

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { ContentPart, ImageUrlPart } from "./types.js";

/** Extensions we accept, mapped to the MIME type baked into the data URL. */
export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/** 10 MiB. Base64 inflates by ~4/3, and every byte rides in the prompt on every
 *  later turn — past this the context cost outweighs the picture. */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ImageAttachment {
  /** Path as the user wrote it — for display and log lines, not for re-reading. */
  path: string;
  mime: string;
  bytes: number;
  /** `data:<mime>;base64,<payload>` — exactly what goes on the wire. */
  dataUrl: string;
}

/** MIME type for a path whose extension we recognise, else undefined. */
export function imageMimeForPath(path: string): string | undefined {
  return IMAGE_MIME_BY_EXT[extname(path).toLowerCase()];
}

export function isImagePath(path: string): boolean {
  return imageMimeForPath(path) !== undefined;
}

/** Models whose `input_modalities` include `image` — mirrors GET /models.
 *  The pro tier silently drops image parts, so callers warn instead of assuming failure. */
export function modelSupportsImages(model: string | undefined): boolean {
  return model === "deepseek-flash" || model === "deepseek-v4-flash";
}

/** Read an image off disk into a wire-ready attachment. Throws on unsupported
 *  extension or oversize file — callers surface the message to the user. */
export function loadImageAttachment(
  absPath: string,
  displayPath: string = absPath,
  maxBytes: number = DEFAULT_MAX_IMAGE_BYTES,
): ImageAttachment {
  const mime = imageMimeForPath(absPath);
  if (!mime) throw new Error(`unsupported image type: ${displayPath}`);
  const size = statSync(absPath).size;
  if (size > maxBytes) {
    throw new Error(
      `image too large: ${displayPath} is ${size} bytes (limit ${maxBytes}); downscale it first`,
    );
  }
  const dataUrl = `data:${mime};base64,${readFileSync(absPath).toString("base64")}`;
  return { path: displayPath, mime, bytes: size, dataUrl };
}

/** Adopt an already-encoded `data:image/...;base64,...` URL — the desktop
 *  webview hands us these straight from a File/Blob, no disk round-trip. */
export function attachmentFromDataUrl(
  dataUrl: string,
  displayPath = "attached image",
): ImageAttachment {
  const trimmed = dataUrl.trim();
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed);
  if (!match) throw new Error("not a base64 image data URL");
  const mime = (match[1] ?? "").toLowerCase();
  const payload = (match[2] ?? "").replace(/\s+/g, "");
  // 4 base64 chars carry 3 bytes; padding trims the tail.
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((payload.length * 3) / 4) - padding;
  if (bytes > DEFAULT_MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${displayPath} is ${bytes} bytes`);
  }
  return { path: displayPath, mime, bytes, dataUrl: trimmed };
}

/** Assemble the `content` field of a user message. Text-only collapses back to a
 *  bare string so the prompt-cache prefix is unchanged for image-free sessions. */
export function buildUserContent(
  text: string,
  images: readonly ImageAttachment[] = [],
): string | ContentPart[] {
  if (images.length === 0) return text;
  const parts: ContentPart[] = [];
  if (text.length > 0) parts.push({ type: "text", text });
  for (const img of images) {
    const part: ImageUrlPart = { type: "image_url", image_url: { url: img.dataUrl } };
    parts.push(part);
  }
  return parts;
}

/** Flatten message content to plain text for token estimates, summaries, search
 *  and transcript display — the base64 payload itself is never useful there. */
export function contentToText(content: string | ContentPart[] | null | undefined): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  const out: string[] = [];
  for (const part of content) {
    if (part.type === "text") out.push(part.text);
    else out.push("[image]");
  }
  return out.join("\n");
}

/** True when a message carries at least one image part. */
export function hasImagePart(content: string | ContentPart[] | null | undefined): boolean {
  if (!content || typeof content === "string") return false;
  return content.some((part) => part.type === "image_url");
}
