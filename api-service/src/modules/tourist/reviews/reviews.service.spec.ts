import { getReviewActivityAction } from './review-activity';

describe('getReviewActivityAction', () => {
  it('uses review when written content is present', () => {
    expect(getReviewActivityAction('Great place')).toBe('review');
  });

  it.each([undefined, null, '', '   '])(
    'uses rating when written content is absent (%p)',
    (content) => {
      expect(getReviewActivityAction(content)).toBe('rating');
    },
  );
});
