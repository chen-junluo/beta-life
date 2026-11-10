import type { AiImageDraft } from "./types";

export const MAX_IMAGES = 4;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
// Rust rejects data URLs over 12M characters; base64 adds a third.
const MAX_BYTES = 8 * 1024 * 1024;
const THUMBNAIL_EDGE = 240;

export const isImageFile = (file: File) => file.type.startsWith("image/");

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name || "图片"}`));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

async function thumbnailOf(dataUrl: string): Promise<string> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const scale = Math.min(1, THUMBNAIL_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return dataUrl;
  // JPEG has no alpha: transparent screenshots get a white background instead of black.
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.72);
}

/** Reads a pasted or dropped image; throws a user-facing message for unsupported files. */
export async function readImage(file: File): Promise<AiImageDraft> {
  const name = file.name || "粘贴的图片";
  if (!IMAGE_TYPES.includes(file.type)) throw new Error(`${name}：只支持 PNG、JPEG 和 WebP 图片`);
  if (file.size > MAX_BYTES) throw new Error(`${name} 超过 8MB`);
  const dataUrl = await readDataUrl(file);
  return { id: crypto.randomUUID(), name, mimeType: file.type, dataUrl, thumbnail: await thumbnailOf(dataUrl) };
}
