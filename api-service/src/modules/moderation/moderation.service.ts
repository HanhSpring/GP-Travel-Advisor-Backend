import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

import { extractFrameFromVideo } from './video-extractor';

export type ModerationResult = {
  status: 'approved' | 'violation';
  violations: string[];
};

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  private isVideo(url: string): boolean {
    const lowerUrl = url.toLowerCase();
    return lowerUrl.endsWith('.mp4') || lowerUrl.endsWith('.mov') || lowerUrl.endsWith('.avi');
  }

  async moderateReview(
    content: string | null,
    images: string[] = [],
    videos: string[] = [],
  ): Promise<ModerationResult> {
    const textToAnalyze = content || '';
    const allMediaUrls = [...images, ...videos];

    // --- STEP 1: Internal rules (business-specific, fast, no API cost) ---
    const internalViolations = this.checkInternalRules(textToAnalyze);
    if (internalViolations.length > 0) {
      return { status: 'violation', violations: internalViolations };
    }

    // --- STEP 2: OpenAI omni-moderation-latest (primary AI check, supports Vietnamese) ---
    let openaiApiOk = false;
    let openaiViolations: string[] = [];
    try {
      const inputs: any[] = [];
      if (textToAnalyze.trim()) {
        inputs.push({ type: 'text', text: textToAnalyze });
      }

      for (const url of allMediaUrls) {
        if (!url) continue;
        if (this.isVideo(url)) {
          try {
            const frameBase64 = await extractFrameFromVideo(url);
            inputs.push({ type: 'image_url', image_url: { url: frameBase64 } });
          } catch (err) {
            this.logger.warn(`Could not extract frame from video: ${url}`, err);
          }
        } else {
          inputs.push({ type: 'image_url', image_url: { url } });
        }
      }

      if (inputs.length > 0) {
        const response = await this.openai.moderations.create({
          model: 'omni-moderation-latest',
          input: inputs,
        });

        openaiApiOk = true;

        // Each input item returns its own result — check ALL of them
        for (const result of response.results) {
          if (result.flagged) {
            const flagged = Object.entries(result.categories)
              .filter(([, isFlagged]) => isFlagged)
              .map(([category]) => category);
            openaiViolations.push(...flagged);
          }
        }
      } else {
        // Nothing to check — treat as clean
        openaiApiOk = true;
      }
    } catch (error) {
      this.logger.error('OpenAI Moderation API error — will keep review as pending', error);
    }

    if (openaiViolations.length > 0) {
      return { status: 'violation', violations: openaiViolations };
    }

    // If OpenAI API failed (network/quota/etc.), return violation to trigger manual review
    // rather than silently approving potentially bad content
    if (!openaiApiOk && (textToAnalyze.trim() || allMediaUrls.length > 0)) {
      return {
        status: 'violation',
        violations: ['OpenAI API không phản hồi — cần kiểm duyệt thủ công'],
      };
    }

    return { status: 'approved', violations: [] };
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
    const urlRegex = /(booking\.com|agoda\.com|traveloka\.com|airbnb\.com|facebook\.com)/g;
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
      s.normalize('NFD')
       .replace(/[̀-ͯ]/g, '')  // strip combining diacritics
       .replace(/đ/g, 'd')
       .replace(/Đ/g, 'd');

    const normalizedText = normalizeVi(lowerText);

    // Exact profanity words (normalized, no diacritics)
    const profanityWords = [
      'lon',       // lồn
      'cac',       // cặc
      'dit',       // địt
      'du ma',     // đụ mẹ
      'du me',
      'du ba',
      'du bo',
      'vl',        // viết tắt vãi lồn
      'vcl',
      'vkl',
      'clm',       // con lồn mẹ (phổ biến trong chat)
      'dm',        // đụ mẹ (viết tắt)
      'dkm',
      'dmm',
      'dmc',
      'đmm',
      'đkm',
      'fuck',
      'shit',
      'bitch',
      'asshole',
      'con cho',   // con chó
      'do cho',    // đồ chó
      'thang cho',
      'con dieu',  // con điếm
      'dieu',      // điếm
      'mai dam',   // mại dâm
      'chim chuot',
      'dau buoi',  // đầu buồi
      'buoi',      // buồi
    ];

    // Check each profanity word — match as whole word or substring
    const foundProfanity = profanityWords.filter((word) =>
      normalizedText.includes(word),
    );

    if (foundProfanity.length > 0) {
      violations.push(`Ngôn ngữ thô tục (Profanity): ${foundProfanity.join(', ')}`);
    }

    return violations;
  }
}
