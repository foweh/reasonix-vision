/** Vision plumbing — content parts, data-URL loading, image mention classification. */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandAtMentions } from "../src/at-mentions.js";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  attachmentFromDataUrl,
  buildUserContent,
  contentToText,
  hasImagePart,
  imageMimeForPath,
  isImagePath,
  loadImageAttachment,
  modelSupportsImages,
} from "../src/vision.js";

/** Smallest valid PNG payload — 1×1 transparent, good enough for byte-shape tests. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function tmpPng(name = "shot.png", bytes = TINY_PNG_BASE64): string {
  const dir = mkdtempSync(join(tmpdir(), "reasonix-vision-"));
  const abs = join(dir, name);
  writeFileSync(abs, Buffer.from(bytes, "base64"));
  return abs;
}

describe("imageMimeForPath / isImagePath", () => {
  it("maps every supported extension case-insensitively", () => {
    expect(imageMimeForPath("a.png")).toBe("image/png");
    expect(imageMimeForPath("a.JPG")).toBe("image/jpeg");
    expect(imageMimeForPath("a.jpeg")).toBe("image/jpeg");
    expect(imageMimeForPath("a.webp")).toBe("image/webp");
    expect(imageMimeForPath("a.gif")).toBe("image/gif");
    expect(imageMimeForPath("a.bmp")).toBe("image/bmp");
  });

  it("rejects non-image extensions", () => {
    expect(imageMimeForPath("a.ts")).toBeUndefined();
    expect(isImagePath("src/client.ts")).toBe(false);
    expect(isImagePath("logo.svg")).toBe(false);
    expect(isImagePath("shot.png")).toBe(true);
  });
});

describe("modelSupportsImages", () => {
  it("is true only for the V4.1 flash model (and its pre-rename id)", () => {
    expect(modelSupportsImages("deepseek-flash")).toBe(true);
    expect(modelSupportsImages("deepseek-v4-flash")).toBe(true);
    expect(modelSupportsImages("deepseek-v4-pro")).toBe(false);
    expect(modelSupportsImages(undefined)).toBe(false);
  });
});

describe("loadImageAttachment", () => {
  it("reads bytes into a data URL with the right MIME", () => {
    const abs = tmpPng();
    const att = loadImageAttachment(abs, "shot.png");
    expect(att.path).toBe("shot.png");
    expect(att.mime).toBe("image/png");
    expect(att.bytes).toBeGreaterThan(0);
    expect(att.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(att.dataUrl).toBe(`data:image/png;base64,${TINY_PNG_BASE64}`);
  });

  it("throws on a non-image extension", () => {
    const abs = tmpPng("notes.txt");
    expect(() => loadImageAttachment(abs)).toThrow(/unsupported image type/);
  });

  it("throws once the file exceeds the byte cap", () => {
    const abs = tmpPng();
    expect(() => loadImageAttachment(abs, "shot.png", 4)).toThrow(/too large/);
    expect(DEFAULT_MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});

describe("attachmentFromDataUrl", () => {
  it("adopts a well-formed data URL", () => {
    const att = attachmentFromDataUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
    expect(att.mime).toBe("image/png");
    expect(att.bytes).toBeGreaterThan(0);
  });

  it("rejects a non-image or non-base64 payload", () => {
    expect(() => attachmentFromDataUrl("data:text/plain;base64,aGk=")).toThrow();
    expect(() => attachmentFromDataUrl("https://example.com/a.png")).toThrow();
  });
});

describe("buildUserContent", () => {
  it("collapses to a bare string with no images (cache prefix unchanged)", () => {
    expect(buildUserContent("hello")).toBe("hello");
    expect(buildUserContent("hello", [])).toBe("hello");
  });

  it("puts the text part first, then one image_url part per attachment", () => {
    const att = attachmentFromDataUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
    const content = buildUserContent("what is this?", [att, att]);
    if (typeof content === "string") throw new Error("expected parts array");
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: "what is this?" });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: att.dataUrl } });
    expect(hasImagePart(content)).toBe(true);
    expect(hasImagePart("plain")).toBe(false);
  });

  it("omits the text part when the prompt is empty", () => {
    const att = attachmentFromDataUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
    const content = buildUserContent("", [att]);
    if (typeof content === "string") throw new Error("expected parts array");
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("image_url");
  });
});

describe("contentToText", () => {
  it("flattens parts without leaking base64 into prompts or summaries", () => {
    const att = attachmentFromDataUrl(`data:image/png;base64,${TINY_PNG_BASE64}`);
    const content = buildUserContent("describe", [att]);
    const flat = contentToText(content);
    expect(flat).toContain("describe");
    expect(flat).toContain("[image]");
    expect(flat).not.toContain("base64");
  });

  it("handles the plain-string and null cases", () => {
    expect(contentToText("hi")).toBe("hi");
    expect(contentToText(null)).toBe("");
    expect(contentToText(undefined)).toBe("");
  });
});

describe("expandAtMentions image classification", () => {
  it("marks an image mention as kind=image and does NOT inline it as text", () => {
    const abs = tmpPng();
    const root = abs.slice(0, abs.length - "shot.png".length);
    const out = expandAtMentions("what is in @shot.png?", root);
    const ex = out.expansions.find((e) => e.path === "shot.png");
    expect(ex?.ok).toBe(true);
    expect(ex?.kind).toBe("image");
    expect(ex?.mime).toBe("image/png");
    // The bug this guards: reading a PNG as utf8 used to inject garbage.
    expect(out.text).not.toContain('<file path="shot.png"');
    expect(out.text).not.toContain("PNG");
  });

  it("still inlines text mentions as before", () => {
    const abs = tmpPng();
    const root = abs.slice(0, abs.length - "shot.png".length);
    writeFileSync(join(root, "notes.ts"), "export const x = 1;\n");
    const out = expandAtMentions("@notes.ts", root);
    expect(out.expansions[0]?.kind).toBeUndefined();
    expect(out.text).toContain("export const x = 1;");
  });
});
