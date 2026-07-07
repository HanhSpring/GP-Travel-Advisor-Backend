import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import ffmpeg = require('fluent-ffmpeg');
import ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);
}

if (ffprobeStatic && ffprobeStatic.path) {
  ffmpeg.setFfprobePath(ffprobeStatic.path);
}

function downloadToTemp(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const protocol = url.startsWith('https') ? https : http;

    const req = protocol.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        file.close();
        fs.unlink(destPath, () => {});
        reject(new Error(`Failed to download video: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    });

    req.on('error', (err) => {
      file.close();
      fs.unlink(destPath, () => {});
      reject(err);
    });

    // 30s timeout
    req.setTimeout(30000, () => {
      req.destroy();
      file.close();
      fs.unlink(destPath, () => {});
      reject(new Error('Video download timed out'));
    });
  });
}

/**
 * Downloads a remote video then extracts a frame as base64.
 */
export async function extractFramesFromVideo(
  videoUrl: string,
): Promise<string[]> {
  const tempDir = os.tmpdir();
  const id = crypto.randomBytes(16).toString('hex');
  const tempVideoPath = path.join(tempDir, `${id}.mp4`);

  // Download video to local temp file first
  await downloadToTemp(videoUrl, tempVideoPath);

  return new Promise((resolve, reject) => {
    ffmpeg(tempVideoPath)
      .on('end', () => {
        fs.unlink(tempVideoPath, () => {});
        try {
          const frames: string[] = [];
          for (let i = 1; i <= 3; i++) {
            const tempFramePath = path.join(tempDir, `${id}_${i}.jpg`);
            if (fs.existsSync(tempFramePath)) {
              const imageBuffer = fs.readFileSync(tempFramePath);
              fs.unlink(tempFramePath, () => {});
              frames.push(`data:image/jpeg;base64,${imageBuffer.toString('base64')}`);
            }
          }
          if (frames.length === 0) {
            reject(new Error(`No frames created for: ${videoUrl}`));
          } else {
            resolve(frames);
          }
        } catch (err) {
          reject(err);
        }
      })
      .on('error', (err) => {
        fs.unlink(tempVideoPath, () => {});
        for (let i = 1; i <= 3; i++) {
          const p = path.join(tempDir, `${id}_${i}.jpg`);
          if (fs.existsSync(p)) fs.unlink(p, () => {});
        }
        reject(err);
      })
      .screenshots({
        timestamps: ['20%', '50%', '80%'],
        filename: `${id}_%i.jpg`,
        folder: tempDir,
      });
  });
}
