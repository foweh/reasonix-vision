/** Live vision smoke test: real CacheFirstLoop → real api.deepseek.com with one PNG.
 *  Usage: npx tsx scripts/vision-smoke.ts [image-path] */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { expandAtMentions } from "../src/at-mentions.js";
import { CacheFirstLoop, DeepSeekClient, ImmutablePrefix } from "../src/index.js";
import { type ImageAttachment, loadImageAttachment } from "../src/vision.js";

function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = (table[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

/** Solid-colour RGB PNG — no image library needed. */
function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const off = y * stride;
    for (let x = 0; x < size; x++) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  const argPath = process.argv[2];
  let imagePath = argPath;
  if (!imagePath) {
    const dir = mkdtempSync(join(tmpdir(), "reasonix-vision-smoke-"));
    imagePath = join(dir, "smoke.png");
    writeFileSync(imagePath, solidPng(96, [220, 20, 20]));
  }

  const attachment = loadImageAttachment(imagePath, "smoke.png");
  console.log(
    `[smoke] image: ${imagePath} (${attachment.mime}, ${attachment.bytes} bytes, dataUrl ${attachment.dataUrl.length} chars)`,
  );

  const client = new DeepSeekClient({});
  console.log(`[smoke] baseUrl: ${client.baseUrl}`);

  const loop = newLoop(client);

  const answer = await ask(loop, "这张图片是什么颜色？只说出颜色名。", [attachment]);
  console.log(`[smoke] direct attachment → ${JSON.stringify(answer)}`);
  assertAnswer(answer, "direct attachment");

  // Second leg: the `@shot.png` mention path the TUI/desktop actually use.
  // Fresh loop so the first answer can't leak into this turn. Note the space before
  // `@` — AT_MENTION_PATTERN is anchored on start-of-input or whitespace.
  const workspace = mkdtempSync(join(tmpdir(), "reasonix-vision-ws-"));
  writeFileSync(join(workspace, "shot.png"), solidPng(96, [20, 90, 220]));
  const mentionLoop = newLoop(client);
  const expanded = expandAtMentions("这张图片是什么颜色？只说出颜色名。 @shot.png", workspace);
  const mentioned = expanded.expansions.filter((ex) => ex.ok && ex.kind === "image");
  console.log(
    `[smoke] @mention resolved ${mentioned.length} image(s): ${mentioned[0]?.path ?? "-"}`,
  );
  if (mentioned.length !== 1) {
    console.error("[smoke] FAIL — @mention did not classify shot.png as an image");
    process.exit(1);
  }
  const mentionAnswer = await ask(
    mentionLoop,
    expanded.text,
    mentioned.map((ex) => loadImageAttachment(join(workspace, ex.path), ex.path)),
  );
  console.log(`[smoke] @mention → ${JSON.stringify(mentionAnswer)}`);
  assertAnswer(mentionAnswer, "@mention");

  const total = loop.stats.totalCost + mentionLoop.stats.totalCost;
  console.log(`[smoke] OK — both legs round-tripped (cost $${total.toFixed(5)})`);
}

function newLoop(client: DeepSeekClient): CacheFirstLoop {
  return new CacheFirstLoop({
    client,
    prefix: new ImmutablePrefix({ system: "Answer in as few words as possible." }),
    model: "deepseek-flash",
    stream: true,
  });
}

async function ask(
  loop: CacheFirstLoop,
  text: string,
  images: readonly ImageAttachment[],
): Promise<string> {
  let answer = "";
  for await (const ev of loop.step(text, { images })) {
    if (ev.role === "warning") console.log(`[smoke] warning: ${ev.content}`);
    if (ev.role === "error") {
      console.error(`[smoke] model error: ${ev.error}`);
      process.exit(1);
    }
    if (ev.role === "assistant_final") answer = ev.content;
  }
  return answer.trim();
}

function assertAnswer(answer: string, label: string): void {
  if (!answer) {
    console.error(`[smoke] FAIL — ${label}: empty answer (image was probably dropped)`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("[smoke] FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
