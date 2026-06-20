export function getReviewActivityAction(
  content?: string | null,
): 'review' | 'rating' {
  return content?.trim() ? 'review' : 'rating';
}
