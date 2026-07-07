import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

import { extractFramesFromVideo } from './video-extractor';

export type MediaViolation = {
  url: string;
  mediaType: 'image' | 'video';
  categories: string[];
};

export type ModerationResult = {
  status: 'approved' | 'violation';
  violations: string[];
  textViolations: string[];
  mediaViolations: string[];
  mediaViolationDetails: MediaViolation[];
};

export function isVideoUrl(url: string): boolean {
  const lowerUrl = url.toLowerCase();
  return (
    lowerUrl.endsWith('.mp4') ||
    lowerUrl.endsWith('.mov') ||
    lowerUrl.endsWith('.avi')
  );
}

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);
  private _openai: OpenAI | null = null;

  private get openai(): OpenAI {
    if (!this._openai) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is not set');
      }
      // Timeout so a slow/hanging OpenAI call can't stall the whole moderation
      // pipeline — falls through to the "manual review" branch instead.
      this._openai = new OpenAI({ apiKey, timeout: 15000, maxRetries: 1 });
    }
    return this._openai;
  }

  private isVideo(url: string): boolean {
    return isVideoUrl(url);
  }

  async moderateReview(
    content: string | null,
    images: string[] = [],
    videos: string[] = [],
  ): Promise<ModerationResult> {
    const textToAnalyze = content || '';
    const allMediaUrls = [...images, ...videos].filter(Boolean);

    // --- STEP 1: Internal rules (business-specific, fast, no API cost) ---
    const internalViolations = this.checkInternalRules(textToAnalyze);
    if (internalViolations.length > 0) {
      return {
        status: 'violation',
        violations: internalViolations,
        textViolations: internalViolations,
        mediaViolations: [],
        mediaViolationDetails: allMediaUrls.map(url => ({
          url,
          mediaType: this.isVideo(url) ? 'video' : 'image',
          categories: []
        })),
      };
    }

    // --- STEP 2: OpenAI omni-moderation-latest (primary AI check, supports Vietnamese) ---
    // OpenAI's moderation endpoint allows only ONE image per request (a text
    // item plus one image is fine, but 2+ images in the same call are
    // rejected with "too_many_images"). So: one call for the text, and one
    // call PER media item (image, or extracted video frame) — all fired
    // concurrently instead of sequentially, which is what actually gives the
    // speedup without hitting that limit.
    const textViolations: string[] = [];
    const mediaViolations: string[] = [];
    const mediaViolationDetails: MediaViolation[] = [];
    let textCallFailed = false;
    let mediaCallFailed = false;

    const extractFlagged = (result: { flagged: boolean; categories: object }): string[] =>
      Object.entries(result.categories as Record<string, boolean>)
        .filter(([, isFlagged]) => isFlagged)
        .map(([category]) => category);

    const textPromise = textToAnalyze.trim()
      ? this.openai.moderations
          .create({
            model: 'omni-moderation-latest',
            input: [{ type: 'text', text: textToAnalyze }],
          })
          .then((response) => {
            for (const result of response.results) {
              if (result.flagged) textViolations.push(...extractFlagged(result));
            }
          })
          .catch((error) => {
            this.logger.error('OpenAI Moderation API error (text)', error);
            textCallFailed = true;
          })
      : Promise.resolve();

    const mediaPromises = allMediaUrls.map(async (url) => {
      const mediaType: 'image' | 'video' = this.isVideo(url) ? 'video' : 'image';
      let imageUrls: string[] = [];
      if (mediaType === 'video') {
        try {
          imageUrls = await extractFramesFromVideo(url);
        } catch (err) {
          this.logger.warn(`Could not extract frames from video: ${url}`, err);
          mediaCallFailed = true;
          return;
        }
      } else {
        imageUrls = [url];
      }

      try {
        let isFlagged = false;
        const allCategories = new Set<string>();

        const checks = imageUrls.map(async (imgUrl) => {
          const response = await this.openai.moderations.create({
            model: 'omni-moderation-latest',
            input: [{ type: 'image_url', image_url: { url: imgUrl } }],
          });
          for (const result of response.results) {
            if (result.flagged) {
              isFlagged = true;
              extractFlagged(result).forEach(c => allCategories.add(c));
            }
          }
        });

        await Promise.all(checks);

        if (isFlagged) {
          const flaggedCategories = Array.from(allCategories);
          mediaViolations.push(...flaggedCategories);
          mediaViolationDetails.push({ url, mediaType, categories: flaggedCategories });
        } else {
          mediaViolationDetails.push({ url, mediaType, categories: [] });
        }
      } catch (error) {
        this.logger.error(`OpenAI Moderation API error (media: ${url})`, error);
        mediaCallFailed = true;
      }
    });

    await Promise.all([textPromise, ...mediaPromises]);

    if (textViolations.length > 0 || mediaViolations.length > 0) {
      return {
        status: 'violation',
        violations: [...textViolations, ...mediaViolations],
        textViolations,
        mediaViolations,
        mediaViolationDetails,
      };
    }

    // If a call failed (network/quota/etc.), return violation to trigger manual
    // review rather than silently approving potentially bad content
    if (textCallFailed || mediaCallFailed) {
      const reason = 'OpenAI API không phản hồi — cần kiểm duyệt thủ công';
      return {
        status: 'violation',
        violations: [reason],
        textViolations: textCallFailed ? [reason] : [],
        mediaViolations: mediaCallFailed ? [reason] : [],
        mediaViolationDetails: [],
      };
    }

    return {
      status: 'approved',
      violations: [],
      textViolations: [],
      mediaViolations: [],
      mediaViolationDetails: [],
    };
  }

  private checkInternalRules(text: string): string[] {
    const violations: string[] = [];
    const lowerText = text.toLowerCase();

    // 1. Phone Number Detection
    const phoneRegex = /(0|\+84)[3|5|7|8|9][0-9]{8}/g;
    if (phoneRegex.test(lowerText)) {
      violations.push('Số điện thoại (Phone Number)');
    }

    // 2. External Booking Links Detection
    const urlRegex =
      /(booking\.com|agoda\.com|traveloka\.com|airbnb\.com|facebook\.com)/g;
    if (urlRegex.test(lowerText)) {
      violations.push('URL bên ngoài (External Booking Links)');
    }

    // 3. Advertising
    const adKeywords = ['giảm giá', 'sale 50', 'mua ngay', 'liên hệ zalo'];
    if (adKeywords.some((kw) => lowerText.includes(kw))) {
      violations.push('Quảng cáo (Advertising)');
    }

    // 4. Spam Detection (Repeated characters)
    const spamRegex = /(.)\1{4,}/g;
    if (spamRegex.test(lowerText)) {
      violations.push('Spam');
    }

    // 5. Fake Review
    if (lowerText.includes('lorem ipsum')) {
      violations.push('Fake Review (Lorem ipsum)');
    }

    // 6. Vietnamese Profanity / Hate Speech
    // Normalize text: remove diacritics for variant matching (e.g. "lon" = "lồn")
    const normalizeVi = (s: string) =>
      s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // strip combining diacritics
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'd');

    const normalizedText = normalizeVi(lowerText);

    // Exact profanity words (normalized, no diacritics)
    const profanityWords = [
      'lon', // lồn
      'cac', // cặc
      'dit', // địt
      'du ma', // đụ mẹ
      'du me',
      'du ba',
      'du bo',
      'vl', // viết tắt vãi lồn
      'vcl',
      'vkl',
      'clm', // con lồn mẹ (phổ biến trong chat)
      'dm', // đụ mẹ (viết tắt)
      'dkm',
      'dmm',
      'dmc',
      'đmm',
      'đkm',
      'fuck',
      'shit',
      'bitch',
      'asshole',
      'con cho', // con chó
      'do cho', // đồ chó
      'thang cho',
      'con dieu', // con điếm
      'dieu', // điếm
      'mai dam', // mại dâm
      'chim chuot',
      'dau buoi', // đầu buồi
      'buoi', // buồi
    ];

    // Check each profanity word — match as whole word or substring
    const foundProfanity = profanityWords.filter((word) =>
      normalizedText.includes(word),
    );

    if (foundProfanity.length > 0) {
      violations.push(
        `Ngôn ngữ thô tục (Profanity): ${foundProfanity.join(', ')}`,
      );
    }

    return violations;
  }
}
