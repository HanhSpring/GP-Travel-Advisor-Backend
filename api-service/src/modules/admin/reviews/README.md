# Admin Reviews API Documentation

## Overview
API quản lý đánh giá dành cho admin platform. Cung cấp các tính năng xem danh sách đánh giá, chi tiết đánh giá, duyệt/từ chối đánh giá.

## Database Changes Required

### SQL Migration Script
Trước khi sử dụng API, chạy script sau để thêm cột `status` vào bảng `review_ai.reviews`:

```sql
-- Create review status enum type
CREATE TYPE review_ai.review_status_enum AS ENUM ('pending', 'approved', 'violation');

-- Add status column to reviews table
ALTER TABLE review_ai.reviews 
ADD COLUMN status review_ai.review_status_enum DEFAULT 'pending';

-- Add index for faster filtering
CREATE INDEX idx_reviews_status ON review_ai.reviews(status);
CREATE INDEX idx_reviews_created_at ON review_ai.reviews(created_at DESC);
```

Lưu tại: `migrations/add_review_status.sql`

## API Endpoints

### 1. Get Reviews List (Danh sách đánh giá)
```
GET /admin/reviews?page=1&limit=10&status=pending&sort=newest
```

**Query Parameters:**
- `page` (optional, default: 1): Trang hiện tại
- `limit` (optional, default: 10, max: 100): Số lượng bản ghi mỗi trang
- `status` (optional): Lọc theo trạng thái - `pending`, `approved`, `violation`
- `sort` (optional, default: newest): Sắp xếp - `newest`, `oldest`, `highest_rating`, `lowest_rating`
- `search` (optional): Tìm kiếm theo tên địa điểm

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "reviewer_id": "uuid",
      "reviewer_name": "Võ Danh",
      "reviewer_review_count": 12,
      "reviewer_report_count": 2,
      "place_id": "uuid",
      "place_name": "Khách sạn Luxury",
      "place_address": "Quận 1, TP HCM",
      "rating": 2,
      "review_content": "Dịch vụ quá tệ, lừa đảo",
      "main_topic": "Service Quality",
      "status": "pending",
      "created_at": "2023-10-20T14:30:00Z",
      "has_images": false
    }
  ],
  "pagination": {
    "total": 45600,
    "page": 1,
    "limit": 10,
    "total_pages": 4560
  },
  "summary": {
    "total_reviews": 45600,
    "pending_count": 85,
    "approved_count": 45000,
    "violation_count": 12
  }
}
```

### 2. Get Filter Options (Lấy danh sách filter)
```
GET /admin/reviews/filters
```

**Response:**
```json
{
  "statuses": [
    { "value": "pending", "label": "Chờ duyệt" },
    { "value": "approved", "label": "Đã duyệt" },
    { "value": "violation", "label": "Vi phạm" }
  ]
}
```

### 3. Get Review Detail (Chi tiết đánh giá)
```
GET /admin/reviews/:id
```

**Response:**
```json
{
  "id": "uuid",
  "user": {
    "id": "uuid",
    "name": "Võ Danh",
    "review_count": 12,
    "report_count": 2
  },
  "place": {
    "id": "uuid",
    "name": "Khách sạn Luxury",
    "address": "Quận 1, TP HCM"
  },
  "rating": 2,
  "main_topic": "Service Quality",
  "review_content": "Dịch vụ quá tệ, lừa đảo không thể chấp nhận được",
  "images": [
    { "url": "https://example.com/image1.jpg" }
  ],
  "status": "pending",
  "created_at": "2023-10-20T14:30:00Z"
}
```

### 4. Approve Review (Duyệt đánh giá)
```
PUT /admin/reviews/:id/approve
```

**Request Body:** (Empty)

**Response:**
```json
{
  "success": true,
  "message": "Review approved successfully"
}
```

### 5. Reject Review as Violation (Từ chối/Đánh dấu vi phạm)
```
PUT /admin/reviews/:id/reject
```

**Request Body:**
```json
{
  "status": "violation",
  "reason": "Nội dung tấn công cá nhân, vi phạm quy định"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Review marked as violation successfully"
}
```

### 6. Update Review Status (Cập nhật trạng thái)
```
PUT /admin/reviews/:id
```

**Request Body:**
```json
{
  "status": "approved|violation",
  "reason": "Optional reason for rejection"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Review status updated successfully"
}
```

## File Structure

```
src/modules/admin/reviews/
├── admin-reviews.controller.ts      # Controller xử lý requests
├── admin-reviews.service.ts         # Service chứa business logic
├── admin-reviews.module.ts          # Module registration
└── dto/
    ├── admin-review-list.dto.ts     # DTO cho danh sách
    ├── admin-review-detail.dto.ts   # DTO cho chi tiết
    └── admin-review-action.dto.ts   # DTO cho hành động
```

## Feature Highlights

✅ **Danh sách đánh giá** với pagination, search, filter, sort
✅ **Chi tiết đánh giá** cùng thông tin user, place, images
✅ **Duyệt/Từ chối** đánh giá với ghi chú reason
✅ **Thống kê** tổng số đánh giá theo trạng thái (Chờ duyệt, Đã duyệt, Vi phạm)
✅ **Lấy dữ liệu filter** để populate dropdown trên FE
✅ **Error handling** với proper HTTP status codes

## Implementation Notes

- Status enum type: `pending` (Chờ duyệt), `approved` (Đã duyệt), `violation` (Vi phạm)
- Default status cho review mới: `pending`
- Có index trên status và created_at để optimize query performance
- API tự động fetch thông tin user, place, review_content liên quan
- Graceful error handling khi data không tồn tại
- Support sorting by rating (highest/lowest) cho đánh giá quality assessment

## Notes for Frontend

- Sử dụng `status` field để hiển thị badge status trên list
- Uncheck `has_images` để ẩn/hiện image placeholder
- `reviewer_report_count` là placeholder (cần report table để implement)
- `images` array hiện empty (cần image storage solution)
