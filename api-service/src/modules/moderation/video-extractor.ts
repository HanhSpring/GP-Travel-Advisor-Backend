import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as https from 'https';
import * as http from 'http';
import ffmpeg = require('fluent-ffmpeg');
import ffmpegStatic = require('ffmpeg-static');

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);
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
export async function extractFrameFromVideo(
  videoUrl: string,
  timestampString: string = '00:00:01',
): Promise<string> {
  const tempDir = os.tmpdir();
  const id = crypto.randomBytes(16).toString('hex');
  const tempVideoPath = path.join(tempDir, `${id}.mp4`);
  const tempFrameName = `${id}.jpg`;
  const tempFramePath = path.join(tempDir, tempFrameName);

  // Download video to local temp file first
  await downloadToTemp(videoUrl, tempVideoPath);

  return new Promise((resolve, reject) => {
    ffmpeg(tempVideoPath)
      .on('end', () => {
        fs.unlink(tempVideoPath, () => {});
        try {
          if (!fs.existsSync(tempFramePath)) {
            reject(new Error(`Frame not created for: ${videoUrl}`));
            return;
          }
          const imageBuffer = fs.readFileSync(tempFramePath);
          fs.unlink(tempFramePath, () => {});
          resolve(`data:image/jpeg;base64,${imageBuffer.toString('base64')}`);
        } catch (err) {
          reject(err);
        }
      })
      .on('error', (err) => {
        fs.unlink(tempVideoPath, () => {});
        if (fs.existsSync(tempFramePath)) fs.unlink(tempFramePath, () => {});
        reject(err);
      })
      .screenshots({
        timestamps: [timestampString],
        filename: tempFrameName,
        folder: tempDir,
      });
  });
}