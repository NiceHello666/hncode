// ReadMediaFile tool — reads media files and returns base64 for images,
// or metadata for other formats (video, audio).
// Allows multimodal models to view images and identify media types.

import fs from 'node:fs';
import path from 'node:path';
import { resolvePath } from './utils.js';

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB max for images
const MAX_PREVIEW_SIZE = 100 * 1024;     // 100KB text preview for non-images

const SUPPORTED_IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const VIDEO_EXT = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.flac', '.m4a'];

export const spec = {
  name: 'ReadMediaFile',
  description: 'Read a media file. Images return base64; other formats return metadata.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the media file.' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    let p;
    try { p = resolvePath(args.path, ctx); } catch (e) { return e.message; }
    
    if (!fs.existsSync(p)) return `Error: file not found: ${args.path}`;
    
    const stat = fs.statSync(p);
    const ext = path.extname(p).toLowerCase();
    
    if (SUPPORTED_IMAGE_EXT.includes(ext)) {
      if (stat.size > MAX_IMAGE_SIZE) {
        return `Error: image too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 20MB): ${args.path}`;
      }
      const data = fs.readFileSync(p);
      const base64 = data.toString('base64');
      const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : ext === '.bmp' ? 'image/bmp'
        : 'image/unknown';
      return `data:${mimeType};base64,${base64}`;
    }
    
    const fileType = VIDEO_EXT.includes(ext) ? 'video' : AUDIO_EXT.includes(ext) ? 'audio' : 'unknown';
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    return `[Media: ${fileType.toUpperCase()}] ${args.path} (${sizeMB}MB) - cannot preview in text mode.`;
  },
};