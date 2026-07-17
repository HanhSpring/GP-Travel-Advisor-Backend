alter table review_ai.reviews
  add column reply text null,
  add column replied_at timestamptz null;

comment on column review_ai.reviews.reply
  is 'Nội dung phản hồi của chủ địa điểm cho đánh giá này.';

comment on column review_ai.reviews.replied_at
  is 'Thời điểm chủ địa điểm gửi phản hồi gần nhất.';
