// ReadMediaFile tool — hands a media file to the model as a REAL attachment.
//
// An image does not come back as a paragraph describing itself: it returns
// `{ text, media: [{ type: 'image', mimeType, data }] }`, which the agent stores
// as the tool result and llm.js converts into the shape each protocol wants
// (`image_url` for OpenAI, an `image` block for Anthropic). That is what lets the
// model actually look at a screenshot instead of reading its dimensions.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePath } from './utils.js';

// Bytes, not a bit count. Raised well past the old 20MB/64KB limits: the point of
// this tool is to LOOK at things, and a modern screenshot or photo routinely
// exceeds them. Override with HNCODE_MEDIA_MAX_BYTES when a provider has its own
// ceiling (most cap a single image at 5MB after base64).
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
function maxBytes() {
  const v = Number(process.env.HNCODE_MEDIA_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BYTES;
}

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.flac', '.m4a'];

export const spec = {
  name: 'ReadMediaFile',
  description: 'Read a media file and attach it to the conversation. Images are sent to the model as an actual image; audio and video return metadata.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the media file.' },
      maxBytes: {
        type: 'number',
        description: 'Reject the file above this many bytes instead of the default limit.',
      },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }

    if (!fs.existsSync(p)) return `Error: file not found: ${args.path}`;
    const stat = fs.statSync(p);
    if (!stat.isFile()) return `Error: not a file: ${args.path}`;

    const ext = path.extname(p).toLowerCase();
    const abs = p.replace(/\\/g, '/');
    const sizeKB = Math.max(1, Math.round(stat.size / 1024));

    if (IMAGE_MIME[ext]) {
      const cap = Number.isFinite(args.maxBytes) && args.maxBytes > 0 ? args.maxBytes : maxBytes();
      if (stat.size > cap) {
        return `Error: image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max ${(cap / 1024 / 1024).toFixed(0)}MB): ${args.path}\n`
          + 'Resize it, or raise the limit with HNCODE_MEDIA_MAX_BYTES.';
      }
      const mimeType = IMAGE_MIME[ext];
      const data = fs.readFileSync(p).toString('base64');
      const approxKB = Math.round(data.length / 1024);
      return {
        text: `[image] ${args.path} (${sizeKB}KB, ${mimeType})`,
        media: [{ type: 'image', mimeType, data }],
        // Kept for the TUI/web transcript, which renders a one-line receipt
        // rather than the bytes.
        _receipt: `Read image ${path.basename(abs)} (${sizeKB}KB, ~${approxKB}KB base64)`,
      };
    }

    const fileType = VIDEO_EXT.includes(ext) ? 'video' : AUDIO_EXT.includes(ext) ? 'audio' : 'unknown';
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    return `[Media: ${fileType.toUpperCase()}] ${args.path} (${sizeMB}MB) - cannot be attached as an image.`;
  },
};
