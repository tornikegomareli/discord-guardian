import fs from "node:fs/promises";
import path from "node:path";

/** Discord attachment cap for an announcement image. Regular servers reject files near 10 MB. */
export const MAX_ANNOUNCE_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const TOO_LARGE = "image too large (max 8 MB)";

export interface AnnounceImage {
  name: string;
  data: Buffer;
}

/** True for boolean true or the string "true" (any case). The CLI always sends strings. */
export function mentionEveryoneRequested(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

/**
 * @everyone and @here notify only when asked. Role and user mentions are never listed,
 * so they cannot ping even if the text contains them.
 */
export function announceAllowedMentions(pingEveryone: boolean): { parse: Array<"everyone"> } {
  return { parse: pingEveryone ? ["everyone"] : [] };
}

function attachmentName(candidate: string, fallbackExt: string): string {
  const base = path.basename(candidate).replace(/[\0\r\n]/g, "");
  const ext = path.extname(base).toLowerCase();
  if (IMAGE_EXTS.has(ext) && base.length > ext.length) return base.slice(-100);
  return `image${fallbackExt}`;
}

/** Read one local png/jpg/gif/webp. The path must be absolute because the bot and the CLI share this machine. */
export async function loadLocalAnnounceImage(filePathRaw: string): Promise<AnnounceImage> {
  const filePath = filePathRaw.trim();
  if (/^https?:\/\//i.test(filePath)) throw new Error("image must be a local file path; use image_url for remote images");
  if (!filePath || !path.isAbsolute(filePath)) throw new Error("image path must be absolute");
  const ext = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) throw new Error("image must be png, jpg, gif, or webp");
  let st: { isFile(): boolean; size: number };
  try {
    st = await fs.stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new Error("image file not found");
    throw new Error("image file not readable");
  }
  if (!st.isFile()) throw new Error("image file not found");
  if (st.size === 0) throw new Error("image file is empty");
  if (st.size > MAX_ANNOUNCE_IMAGE_BYTES) throw new Error(TOO_LARGE);
  const data = await fs.readFile(filePath);
  if (data.length > MAX_ANNOUNCE_IMAGE_BYTES) throw new Error(TOO_LARGE);
  return { name: attachmentName(filePath, ext), data };
}

function imageExtFromResponse(pathname: string, contentType: string | null): string {
  const raw = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const mapped =
    raw === "image/png" ? ".png"
    : raw === "image/jpeg" || raw === "image/jpg" || raw === "image/pjpeg" ? ".jpg"
    : raw === "image/gif" ? ".gif"
    : raw === "image/webp" ? ".webp"
    : "";
  if (mapped) return mapped;
  const generic = !raw || raw === "application/octet-stream" || raw === "binary/octet-stream";
  if (!generic) throw new Error("image_url must be png, jpg, gif, or webp");
  const fromUrl = path.posix.extname(pathname).toLowerCase();
  if (!IMAGE_EXTS.has(fromUrl)) throw new Error("image_url must be png, jpg, gif, or webp");
  return fromUrl;
}

/** Stop reading once the body passes `max`. Exported so tests can cap a few bytes instead of 8 MB. */
export async function readBodyCapped(body: ReadableStream<Uint8Array> | null, max = MAX_ANNOUNCE_IMAGE_BYTES): Promise<Buffer> {
  if (!body) throw new Error("image file is empty");
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > max) throw new Error(TOO_LARGE);
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (total === 0) throw new Error("image file is empty");
  return Buffer.concat(chunks);
}

export async function loadRemoteAnnounceImage(rawUrl: string): Promise<AnnounceImage> {
  const url = rawUrl.trim();
  if (!url || url.length > 2048) throw new Error("bad image_url");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("bad image_url");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("image_url must be http(s)");
  let res: Response;
  try {
    res = await fetch(parsed, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new Error(`image_url fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`image_url fetch failed (${res.status})`);
  }
  const ext = imageExtFromResponse(parsed.pathname, res.headers.get("content-type"));
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_ANNOUNCE_IMAGE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new Error(TOO_LARGE);
  }
  let data: Buffer;
  try {
    data = await readBodyCapped(res.body);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("image ")) throw err;
    throw new Error(`image_url fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { name: attachmentName(parsed.pathname, ext), data };
}

/** Attach the local file, the remote file, or both. Empty values are skipped. */
export async function announceFilesFromBody(body: { image?: unknown; image_url?: unknown }): Promise<AnnounceImage[]> {
  const files: AnnounceImage[] = [];
  const image = typeof body.image === "string" ? body.image.trim() : "";
  const imageUrl = typeof body.image_url === "string" ? body.image_url.trim() : "";
  if (image) files.push(await loadLocalAnnounceImage(image));
  if (imageUrl) files.push(await loadRemoteAnnounceImage(imageUrl));
  return files;
}
