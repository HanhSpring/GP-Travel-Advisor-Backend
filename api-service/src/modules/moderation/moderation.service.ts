import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

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

  async moderateReview(
    content: string | null,
    images: string[] = [],
    videos: string[] = [],
  ): Promise<ModerationResult> {
    const textToAnalyze = content || '';
    const internalViolations = this.checkInternalRules(textToAnalyze);

    // If internal rules flagged something that causes immediate rejection
    if (internalViolations.some(v => v.includes('Số điện thoại') || v.includes('URL'))) {
      return { status: 'violation', violations: internalViolations };
    }

    // OpenAI Moderation
    let openaiViolations: string[] = [];
    try {
      const inputs: any[] = [];
      if (textToAnalyze.trim()) {
        inputs.push({ type: 'text', text: textToAnalyze });
      }

      // OpenAI omni-moderation-latest supports image_url
      images.forEach((url) => {
        if (url) {
          inputs.push({ type: 'image_url', image_url: { url } });
        }
      });

      if (inputs.length > 0) {
        const response = await this.openai.moderations.create({
          model: 'omni-moderation-latest',
          input: inputs,
        });

        const result = response.results[0];
        if (result.flagged) {
          const flaggedCategories = Object.entries(result.categories)
            .filter(([_, isFlagged]) => isFlagged)
            .map(([category]) => category);
          openaiViolations = flaggedCategories;
        }
      }
    } catch (error) {
      this.logger.error('OpenAI Moderation API error', error);
      // Fallback: Proceed without OpenAI if it fails, rely on internal rules
    }

    const allViolations = [...internalViolations, ...openaiViolations];

    if (openaiViolations.length > 0) {
      return { status: 'violation', violations: allViolations };
    }

    if (internalViolations.length > 0) {
      return { status: 'violation', violations: allViolations };
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
    const spamRegex = /(.)\1{4,}/g; // 5 identical characters in a row
    if (spamRegex.test(lowerText)) {
      violations.push('Spam');
    }

    // 5. Fake Review (Too short but 5 stars - since we don't pass stars here, just check if it's "Lorem ipsum")
    if (lowerText.includes('lorem ipsum')) {
      violations.push('Fake Review (Lorem ipsum)');
    }

    return violations;
  }
}
