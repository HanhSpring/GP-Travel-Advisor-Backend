# Báo Cáo Thống Kê Địa Điểm Thiếu Dữ Liệu Giá

*Ngày báo cáo: 14/06/2026*

Tài liệu này ghi nhận thống kê về các địa điểm chưa có thông tin giá cả (cột `price` rỗng hoặc bằng `[]`) trong cơ sở dữ liệu `places_rows.csv`, phân tích chi tiết 2 cấp theo tỉnh/thành phố và nhóm loại hình.

## 1. Báo Cáo Tổng Quan

* **Tổng số địa điểm trong CSDL**: 59,138 địa điểm.
* **Số địa điểm thiếu giá**: 46,422 địa điểm (78.50%).
* **Số địa điểm đã có giá**: 12,716 địa điểm (21.50%).

### Bảng thống kê theo nhóm dịch vụ (`slot_type`):
| Nhóm dịch vụ (`slot_type`) | Số lượng thiếu giá | Tổng số địa điểm | Tỷ lệ thiếu giá |
| :--- | :---: | :---: | :---: |
| **restaurant** | 15,595 | 21,286 | 73.26% |
| **entertainment** | 8,462 | 8,551 | 98.96% |
| **attraction** | 7,851 | 7,901 | 99.37% |
| **cafe** | 7,675 | 9,822 | 78.14% |
| **accommodation** | 4,080 | 8,732 | 46.72% |
| **shopping** | 2,759 | 2,846 | 96.94% |

## 2. Thống Kê Tổng Quan Theo Tỉnh/Thành Phố

| Tỉnh / Thành phố | Số lượng thiếu giá | Tổng số địa điểm | Tỷ lệ thiếu giá |
| :--- | :---: | :---: | :---: |
| Hồ Chí Minh | 7,314 | 10,177 | 71.87% |
| Đà Nẵng | 4,510 | 6,455 | 69.87% |
| Hà Nội | 4,020 | 5,856 | 68.65% |
| Lâm Đồng | 3,880 | 4,591 | 84.51% |
| Khánh Hòa | 3,159 | 3,944 | 80.10% |
| An Giang | 2,549 | 2,877 | 88.60% |
| Cần Thơ | 2,531 | 3,153 | 80.27% |
| Đắk Lắk | 1,821 | 1,940 | 93.87% |
| Đồng Nai | 1,781 | 2,283 | 78.01% |
| Thừa Thiên Huế | 1,556 | 2,217 | 70.18% |
| Quảng Ninh | 1,327 | 1,549 | 85.67% |
| Vĩnh Long | 1,279 | 1,332 | 96.02% |
| Tây Ninh | 1,231 | 1,255 | 98.09% |
| Đồng Tháp | 1,197 | 1,256 | 95.30% |
| Hải Phòng | 977 | 1,713 | 57.03% |
| Nghệ An | 913 | 1,133 | 80.58% |
| Thanh Hóa | 790 | 869 | 90.91% |
| Gia Lai | 682 | 782 | 87.21% |
| Quảng Trị | 427 | 471 | 90.66% |
| Bắc Giang | 427 | 457 | 93.44% |
| Lào Cai | 394 | 550 | 71.64% |
| Hưng Yên | 351 | 373 | 94.10% |
| Bắc Ninh | 331 | 401 | 82.54% |
| Phú Thọ | 318 | 365 | 87.12% |
| Quảng Ngãi | 299 | 323 | 92.57% |
| Cà Mau | 295 | 307 | 96.09% |
| Ninh Bình | 279 | 407 | 68.55% |
| Kon Tum | 232 | 245 | 94.69% |
| Nam Định | 225 | 233 | 96.57% |
| Bạc Liêu | 205 | 216 | 94.91% |
| Thái Nguyên | 182 | 253 | 71.94% |
| Hà Tĩnh | 178 | 191 | 93.19% |
| Lạng Sơn | 173 | 185 | 93.51% |
| Hòa Bình | 165 | 193 | 85.49% |
| Hà Giang | 127 | 199 | 63.82% |
| Sơn La | 126 | 149 | 84.56% |
| Điện Biên | 66 | 98 | 67.35% |
| Tuyên Quang | 42 | 55 | 76.36% |
| Cao Bằng | 36 | 52 | 69.23% |
| Lai Châu | 17 | 21 | 80.95% |
| Bắc Kạn | 10 | 12 | 83.33% |

## 3. Thống Kê Chi Tiết 2 Cấp Theo Từng Tỉnh/Thành Phố

Dưới đây là chi tiết số lượng địa điểm thiếu giá phân loại theo từng tỉnh/thành phố (Cấp 1) và theo nhóm loại hình dịch vụ kèm loại hình chi tiết (Cấp 2):

### 📍 Hồ Chí Minh (Thiếu 7,314 / 10,177 địa điểm - 71.87%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 1,338 / tổng số 2,604 địa điểm (51.38%).
  * Cafe & Đồ uống: Thiếu 681 / tổng số 993 địa điểm (68.58%).
  * Nhà hàng: Thiếu 517 / tổng số 687 địa điểm (75.25%).
  * Tiệm bánh & Tráng miệng: Thiếu 241 / tổng số 385 địa điểm (62.60%).
  * Pub/Bar: Thiếu 66 / tổng số 73 địa điểm (90.41%).
  * Quán chay: Thiếu 49 / tổng số 89 địa điểm (55.06%).
  * Buffet & Khu ẩm thực: Thiếu 34 / tổng số 35 địa điểm (97.14%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 752 / tổng số 752 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 439 / tổng số 439 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 420 / tổng số 420 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 365 / tổng số 365 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 180 / tổng số 186 địa điểm (96.77%).
  * Công viên giải trí: Thiếu 149 / tổng số 149 địa điểm (100.00%).
  * Billiards: Thiếu 141 / tổng số 141 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 117 / tổng số 118 địa điểm (99.15%).
  * Karaoke: Thiếu 101 / tổng số 101 địa điểm (100.00%).
  * Di tích: Thiếu 95 / tổng số 97 địa điểm (97.94%).
  * Nhà hát/Sân khấu: Thiếu 63 / tổng số 67 địa điểm (94.03%).
  * Bãi biển/Vịnh: Thiếu 56 / tổng số 56 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 46 / tổng số 51 địa điểm (90.20%).
  * Nông trại: Thiếu 35 / tổng số 35 địa điểm (100.00%).
  * Rạp phim: Thiếu 31 / tổng số 31 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 29 / tổng số 32 địa điểm (90.62%).
  * Tour có hướng dẫn: Thiếu 21 / tổng số 27 địa điểm (77.78%).
  * Bảo tàng nghệ thuật/3D: Thiếu 19 / tổng số 21 địa điểm (90.48%).
  * Phố đi bộ: Thiếu 9 / tổng số 12 địa điểm (75.00%).
  * Làng nghề: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 483 / tổng số 1,140 địa điểm (42.37%).
  * Homestay & Villa: Thiếu 271 / tổng số 461 địa điểm (58.79%).
  * Nhà nghỉ: Thiếu 44 / tổng số 64 địa điểm (68.75%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 219 / tổng số 220 địa điểm (99.55%).
  * Trung tâm thương mại: Thiếu 119 / tổng số 134 địa điểm (88.81%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 109 / tổng số 117 địa điểm (93.16%).
  * Dịch vụ du lịch: Thiếu 41 / tổng số 41 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 32 / tổng số 32 địa điểm (100.00%).

### 📍 Đà Nẵng (Thiếu 4,510 / 6,455 địa điểm - 69.87%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 494 / tổng số 1,342 địa điểm (36.81%).
  * Nhà hàng: Thiếu 238 / tổng số 351 địa điểm (67.81%).
  * Cafe & Đồ uống: Thiếu 230 / tổng số 445 địa điểm (51.69%).
  * Tiệm bánh & Tráng miệng: Thiếu 90 / tổng số 228 địa điểm (39.47%).
  * Pub/Bar: Thiếu 42 / tổng số 48 địa điểm (87.50%).
  * Quán chay: Thiếu 20 / tổng số 43 địa điểm (46.51%).
  * Buffet & Khu ẩm thực: Thiếu 14 / tổng số 15 địa điểm (93.33%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 497 / tổng số 497 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 292 / tổng số 293 địa điểm (99.66%).
  * Spa & Thư giãn: Thiếu 245 / tổng số 246 địa điểm (99.59%).
  * Thể thao ngoài trời: Thiếu 207 / tổng số 210 địa điểm (98.57%).
  * Thiên nhiên: Thiếu 196 / tổng số 199 địa điểm (98.49%).
  * Di tích: Thiếu 163 / tổng số 165 địa điểm (98.79%).
  * Công viên/Quảng trường: Thiếu 128 / tổng số 128 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 115 / tổng số 115 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 111 / tổng số 115 địa điểm (96.52%).
  * Billiards: Thiếu 103 / tổng số 103 địa điểm (100.00%).
  * Nông trại: Thiếu 96 / tổng số 96 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 92 / tổng số 94 địa điểm (97.87%).
  * Tour có hướng dẫn: Thiếu 80 / tổng số 85 địa điểm (94.12%).
  * Công viên giải trí: Thiếu 77 / tổng số 79 địa điểm (97.47%).
  * Karaoke: Thiếu 66 / tổng số 66 địa điểm (100.00%).
  * Làng nghề: Thiếu 47 / tổng số 47 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 32 / tổng số 33 địa điểm (96.97%).
  * Bảo tàng nghệ thuật/3D: Thiếu 25 / tổng số 25 địa điểm (100.00%).
  * Rạp phim: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 4 / tổng số 4 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Homestay & Villa: Thiếu 372 / tổng số 600 địa điểm (62.00%).
  * Khách sạn & Resort: Thiếu 195 / tổng số 523 địa điểm (37.28%).
  * Nhà nghỉ: Thiếu 31 / tổng số 36 địa điểm (86.11%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 74 / tổng số 74 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 61 / tổng số 73 địa điểm (83.56%).
  * Dịch vụ du lịch: Thiếu 37 / tổng số 37 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 23 / tổng số 27 địa điểm (85.19%).
  * Cửa hàng tiện lợi: Thiếu 6 / tổng số 6 địa điểm (100.00%).

### 📍 Hà Nội (Thiếu 4,020 / 5,856 địa điểm - 68.65%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 422 / tổng số 1,222 địa điểm (34.53%).
  * Nhà hàng: Thiếu 119 / tổng số 235 địa điểm (50.64%).
  * Cafe & Đồ uống: Thiếu 107 / tổng số 244 địa điểm (43.85%).
  * Tiệm bánh & Tráng miệng: Thiếu 93 / tổng số 265 địa điểm (35.09%).
  * Pub/Bar: Thiếu 35 / tổng số 40 địa điểm (87.50%).
  * Buffet & Khu ẩm thực: Thiếu 21 / tổng số 21 địa điểm (100.00%).
  * Quán chay: Thiếu 11 / tổng số 16 địa điểm (68.75%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 612 / tổng số 612 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 322 / tổng số 322 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 304 / tổng số 304 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 284 / tổng số 285 địa điểm (99.65%).
  * Karaoke: Thiếu 215 / tổng số 215 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 184 / tổng số 187 địa điểm (98.40%).
  * Billiards: Thiếu 121 / tổng số 121 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 109 / tổng số 110 địa điểm (99.09%).
  * Công viên/Quảng trường: Thiếu 90 / tổng số 90 địa điểm (100.00%).
  * Di tích: Thiếu 83 / tổng số 84 địa điểm (98.81%).
  * Công viên giải trí: Thiếu 78 / tổng số 81 địa điểm (96.30%).
  * Bảo tàng & Không gian trưng bày: Thiếu 41 / tổng số 42 địa điểm (97.62%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 36 / tổng số 39 địa điểm (92.31%).
  * Nông trại: Thiếu 31 / tổng số 31 địa điểm (100.00%).
  * Làng nghề: Thiếu 24 / tổng số 24 địa điểm (100.00%).
  * Bảo tàng nghệ thuật/3D: Thiếu 18 / tổng số 18 địa điểm (100.00%).
  * Rạp phim: Thiếu 16 / tổng số 16 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 16 / tổng số 18 địa điểm (88.89%).
  * Bãi biển/Vịnh: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 7 / tổng số 7 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 197 / tổng số 639 địa điểm (30.83%).
  * Homestay & Villa: Thiếu 115 / tổng số 234 địa điểm (49.15%).
  * Nhà nghỉ: Thiếu 29 / tổng số 44 địa điểm (65.91%).
* **Nhóm Mua sắm (shopping)**:
  * Trung tâm thương mại: Thiếu 137 / tổng số 145 địa điểm (94.48%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 58 / tổng số 60 địa điểm (96.67%).
  * Chợ truyền thống: Thiếu 42 / tổng số 42 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 22 / tổng số 22 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 13 / tổng số 13 địa điểm (100.00%).

### 📍 Lâm Đồng (Thiếu 3,880 / 4,591 địa điểm - 84.51%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 861 / tổng số 1,026 địa điểm (83.92%).
  * Cafe & Đồ uống: Thiếu 606 / tổng số 661 địa điểm (91.68%).
  * Nhà hàng: Thiếu 432 / tổng số 469 địa điểm (92.11%).
  * Tiệm bánh & Tráng miệng: Thiếu 130 / tổng số 148 địa điểm (87.84%).
  * Pub/Bar: Thiếu 63 / tổng số 65 địa điểm (96.92%).
  * Quán chay: Thiếu 16 / tổng số 20 địa điểm (80.00%).
  * Buffet & Khu ẩm thực: Thiếu 12 / tổng số 12 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 227 / tổng số 228 địa điểm (99.56%).
  * Thiên nhiên: Thiếu 174 / tổng số 176 địa điểm (98.86%).
  * Nông trại: Thiếu 102 / tổng số 102 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 93 / tổng số 96 địa điểm (96.88%).
  * Bãi biển/Vịnh: Thiếu 78 / tổng số 79 địa điểm (98.73%).
  * Spa & Thư giãn: Thiếu 76 / tổng số 76 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 75 / tổng số 79 địa điểm (94.94%).
  * Công viên/Quảng trường: Thiếu 49 / tổng số 52 địa điểm (94.23%).
  * Di tích: Thiếu 45 / tổng số 46 địa điểm (97.83%).
  * Karaoke: Thiếu 32 / tổng số 32 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 24 / tổng số 24 địa điểm (100.00%).
  * Billiards: Thiếu 20 / tổng số 20 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 20 / tổng số 26 địa điểm (76.92%).
  * Nhà hát/Sân khấu: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 9 / tổng số 11 địa điểm (81.82%).
  * Làng nghề: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 7 / tổng số 8 địa điểm (87.50%).
  * Bảo tàng nghệ thuật/3D: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Rạp phim: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Homestay & Villa: Thiếu 303 / tổng số 400 địa điểm (75.75%).
  * Khách sạn & Resort: Thiếu 254 / tổng số 555 địa điểm (45.77%).
  * Nhà nghỉ: Thiếu 19 / tổng số 24 địa điểm (79.17%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 55 / tổng số 58 địa điểm (94.83%).
  * Chợ truyền thống: Thiếu 29 / tổng số 29 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 29 / tổng số 29 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 13 / tổng số 13 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 2 / tổng số 2 địa điểm (100.00%).

### 📍 Khánh Hòa (Thiếu 3,159 / 3,944 địa điểm - 80.10%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 627 / tổng số 887 địa điểm (70.69%).
  * Nhà hàng: Thiếu 324 / tổng số 376 địa điểm (86.17%).
  * Cafe & Đồ uống: Thiếu 215 / tổng số 350 địa điểm (61.43%).
  * Tiệm bánh & Tráng miệng: Thiếu 119 / tổng số 159 địa điểm (74.84%).
  * Pub/Bar: Thiếu 40 / tổng số 42 địa điểm (95.24%).
  * Buffet & Khu ẩm thực: Thiếu 18 / tổng số 18 địa điểm (100.00%).
  * Quán chay: Thiếu 16 / tổng số 19 địa điểm (84.21%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 313 / tổng số 313 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 173 / tổng số 176 địa điểm (98.30%).
  * Bãi biển/Vịnh: Thiếu 134 / tổng số 135 địa điểm (99.26%).
  * Thể thao trong nhà: Thiếu 113 / tổng số 113 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 102 / tổng số 102 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 97 / tổng số 98 địa điểm (98.98%).
  * Công viên/Quảng trường: Thiếu 56 / tổng số 56 địa điểm (100.00%).
  * Di tích: Thiếu 53 / tổng số 55 địa điểm (96.36%).
  * Nông trại: Thiếu 49 / tổng số 49 địa điểm (100.00%).
  * Billiards: Thiếu 47 / tổng số 47 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 41 / tổng số 42 địa điểm (97.62%).
  * Karaoke: Thiếu 32 / tổng số 32 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 29 / tổng số 31 địa điểm (93.55%).
  * Nhà hát/Sân khấu: Thiếu 21 / tổng số 24 địa điểm (87.50%).
  * Tour có hướng dẫn: Thiếu 18 / tổng số 18 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Làng nghề: Thiếu 6 / tổng số 7 địa điểm (85.71%).
  * Rạp phim: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Bảo tàng nghệ thuật/3D: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 218 / tổng số 439 địa điểm (49.66%).
  * Homestay & Villa: Thiếu 110 / tổng số 160 địa điểm (68.75%).
  * Nhà nghỉ: Thiếu 22 / tổng số 26 địa điểm (84.62%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 51 / tổng số 54 địa điểm (94.44%).
  * Chợ truyền thống: Thiếu 44 / tổng số 44 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 32 / tổng số 33 địa điểm (96.97%).
  * Dịch vụ du lịch: Thiếu 18 / tổng số 18 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 An Giang (Thiếu 2,549 / 2,877 địa điểm - 88.60%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 587 / tổng số 594 địa điểm (98.82%).
  * Cafe & Đồ uống: Thiếu 362 / tổng số 369 địa điểm (98.10%).
  * Nhà hàng: Thiếu 280 / tổng số 280 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 96 / tổng số 97 địa điểm (98.97%).
  * Pub/Bar: Thiếu 55 / tổng số 55 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Quán chay: Thiếu 15 / tổng số 15 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 188 / tổng số 188 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 124 / tổng số 124 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 113 / tổng số 113 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 85 / tổng số 85 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 56 / tổng số 57 địa điểm (98.25%).
  * Công viên/Quảng trường: Thiếu 39 / tổng số 40 địa điểm (97.50%).
  * Công viên giải trí: Thiếu 38 / tổng số 39 địa điểm (97.44%).
  * Karaoke: Thiếu 38 / tổng số 38 địa điểm (100.00%).
  * Di tích: Thiếu 37 / tổng số 37 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 34 / tổng số 37 địa điểm (91.89%).
  * Nông trại: Thiếu 32 / tổng số 32 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 28 / tổng số 28 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 15 / tổng số 17 địa điểm (88.24%).
  * Làng nghề: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Billiards: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 8 / tổng số 9 địa điểm (88.89%).
  * Rạp phim: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 5 / tổng số 6 địa điểm (83.33%).
  * Phố đi bộ: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Bảo tàng nghệ thuật/3D: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 150 / tổng số 385 địa điểm (38.96%).
  * Homestay & Villa: Thiếu 50 / tổng số 110 địa điểm (45.45%).
  * Nhà nghỉ: Thiếu 5 / tổng số 13 địa điểm (38.46%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 29 / tổng số 29 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 17 / tổng số 17 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 7 / tổng số 7 địa điểm (100.00%).

### 📍 Cần Thơ (Thiếu 2,531 / 3,153 địa điểm - 80.27%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 971 / tổng số 1,247 địa điểm (77.87%).
  * Cafe & Đồ uống: Thiếu 288 / tổng số 383 địa điểm (75.20%).
  * Nhà hàng: Thiếu 232 / tổng số 270 địa điểm (85.93%).
  * Tiệm bánh & Tráng miệng: Thiếu 182 / tổng số 232 địa điểm (78.45%).
  * Quán chay: Thiếu 39 / tổng số 52 địa điểm (75.00%).
  * Buffet & Khu ẩm thực: Thiếu 15 / tổng số 16 địa điểm (93.75%).
  * Pub/Bar: Thiếu 10 / tổng số 12 địa điểm (83.33%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 188 / tổng số 188 địa điểm (100.00%).
  * Karaoke: Thiếu 46 / tổng số 46 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 37 / tổng số 37 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 35 / tổng số 35 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 32 / tổng số 32 địa điểm (100.00%).
  * Di tích: Thiếu 28 / tổng số 28 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 28 / tổng số 28 địa điểm (100.00%).
  * Nông trại: Thiếu 26 / tổng số 27 địa điểm (96.30%).
  * Thể thao ngoài trời: Thiếu 21 / tổng số 21 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 8 / tổng số 9 địa điểm (88.89%).
  * Nhà hát/Sân khấu: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Billiards: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Rạp phim: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Làng nghề: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 65 / tổng số 171 địa điểm (38.01%).
  * Homestay & Villa: Thiếu 31 / tổng số 55 địa điểm (56.36%).
  * Nhà nghỉ: Thiếu 6 / tổng số 16 địa điểm (37.50%).
* **Nhóm Mua sắm (shopping)**:
  * Trung tâm thương mại: Thiếu 73 / tổng số 77 địa điểm (94.81%).
  * Chợ truyền thống: Thiếu 57 / tổng số 58 địa điểm (98.28%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 38 / tổng số 38 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 12 / tổng số 12 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 4 / tổng số 4 địa điểm (100.00%).

### 📍 Đắk Lắk (Thiếu 1,821 / 1,940 địa điểm - 93.87%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 576 / tổng số 608 địa điểm (94.74%).
  * Cafe & Đồ uống: Thiếu 496 / tổng số 504 địa điểm (98.41%).
  * Nhà hàng: Thiếu 174 / tổng số 177 địa điểm (98.31%).
  * Tiệm bánh & Tráng miệng: Thiếu 119 / tổng số 122 địa điểm (97.54%).
  * Pub/Bar: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Quán chay: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 5 / tổng số 5 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Thiên nhiên: Thiếu 61 / tổng số 61 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 47 / tổng số 47 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 26 / tổng số 26 địa điểm (100.00%).
  * Karaoke: Thiếu 24 / tổng số 24 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 21 / tổng số 21 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 19 / tổng số 19 địa điểm (100.00%).
  * Nông trại: Thiếu 16 / tổng số 16 địa điểm (100.00%).
  * Di tích: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Billiards: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Rạp phim: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 3 / tổng số 4 địa điểm (75.00%).
  * Làng nghề: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Homestay & Villa: Thiếu 34 / tổng số 47 địa điểm (72.34%).
  * Khách sạn & Resort: Thiếu 32 / tổng số 87 địa điểm (36.78%).
  * Nhà nghỉ: Thiếu 2 / tổng số 6 địa điểm (33.33%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 29 / tổng số 29 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 22 / tổng số 22 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Đồng Nai (Thiếu 1,781 / 2,283 địa điểm - 78.01%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 457 / tổng số 715 địa điểm (63.92%).
  * Cafe & Đồ uống: Thiếu 238 / tổng số 324 địa điểm (73.46%).
  * Nhà hàng: Thiếu 141 / tổng số 202 địa điểm (69.80%).
  * Tiệm bánh & Tráng miệng: Thiếu 68 / tổng số 107 địa điểm (63.55%).
  * Quán chay: Thiếu 9 / tổng số 15 địa điểm (60.00%).
  * Pub/Bar: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 3 / tổng số 3 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 265 / tổng số 265 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 76 / tổng số 76 địa điểm (100.00%).
  * Karaoke: Thiếu 72 / tổng số 72 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 50 / tổng số 51 địa điểm (98.04%).
  * Công viên/Quảng trường: Thiếu 33 / tổng số 33 địa điểm (100.00%).
  * Di tích: Thiếu 29 / tổng số 29 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 22 / tổng số 22 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 16 / tổng số 16 địa điểm (100.00%).
  * Nông trại: Thiếu 16 / tổng số 17 địa điểm (94.12%).
  * Spa & Thư giãn: Thiếu 15 / tổng số 20 địa điểm (75.00%).
  * Billiards: Thiếu 13 / tổng số 13 địa điểm (100.00%).
  * Rạp phim: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Làng nghề: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 19 / tổng số 43 địa điểm (44.19%).
  * Homestay & Villa: Thiếu 15 / tổng số 25 địa điểm (60.00%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 91 / tổng số 91 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 47 / tổng số 50 địa điểm (94.00%).
  * Trung tâm thương mại: Thiếu 34 / tổng số 39 địa điểm (87.18%).
  * Dịch vụ du lịch: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 4 / tổng số 4 địa điểm (100.00%).

### 📍 Thừa Thiên Huế (Thiếu 1,556 / 2,217 địa điểm - 70.18%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 559 / tổng số 857 địa điểm (65.23%).
  * Cafe & Đồ uống: Thiếu 299 / tổng số 450 địa điểm (66.44%).
  * Nhà hàng: Thiếu 150 / tổng số 184 địa điểm (81.52%).
  * Tiệm bánh & Tráng miệng: Thiếu 129 / tổng số 176 địa điểm (73.30%).
  * Pub/Bar: Thiếu 24 / tổng số 28 địa điểm (85.71%).
  * Quán chay: Thiếu 19 / tổng số 29 địa điểm (65.52%).
  * Buffet & Khu ẩm thực: Thiếu 12 / tổng số 12 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Di tích: Thiếu 46 / tổng số 47 địa điểm (97.87%).
  * Công trình tôn giáo: Thiếu 37 / tổng số 38 địa điểm (97.37%).
  * Spa & Thư giãn: Thiếu 20 / tổng số 20 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 18 / tổng số 18 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Karaoke: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Billiards: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Làng nghề: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 41 / tổng số 108 địa điểm (37.96%).
  * Homestay & Villa: Thiếu 39 / tổng số 73 địa điểm (53.42%).
  * Nhà nghỉ: Thiếu 2 / tổng số 10 địa điểm (20.00%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 61 / tổng số 66 địa điểm (92.42%).
  * Chợ truyền thống: Thiếu 33 / tổng số 33 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 16 / tổng số 17 địa điểm (94.12%).
  * Dịch vụ du lịch: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 2 / tổng số 2 địa điểm (100.00%).

### 📍 Quảng Ninh (Thiếu 1,327 / 1,549 địa điểm - 85.67%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 355 / tổng số 402 địa điểm (88.31%).
  * Nhà hàng: Thiếu 233 / tổng số 240 địa điểm (97.08%).
  * Cafe & Đồ uống: Thiếu 199 / tổng số 236 địa điểm (84.32%).
  * Tiệm bánh & Tráng miệng: Thiếu 121 / tổng số 128 địa điểm (94.53%).
  * Pub/Bar: Thiếu 47 / tổng số 47 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Quán chay: Thiếu 8 / tổng số 9 địa điểm (88.89%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Bãi biển/Vịnh: Thiếu 32 / tổng số 32 địa điểm (100.00%).
  * Karaoke: Thiếu 26 / tổng số 26 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 22 / tổng số 22 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Rạp phim: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Làng nghề: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Nông trại: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Di tích: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Bảo tàng nghệ thuật/3D: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Billiards: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 129 / tổng số 237 địa điểm (54.43%).
  * Homestay & Villa: Thiếu 32 / tổng số 45 địa điểm (71.11%).
  * Nhà nghỉ: Thiếu 5 / tổng số 6 địa điểm (83.33%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 22 / tổng số 22 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 13 / tổng số 14 địa điểm (92.86%).
  * Trung tâm thương mại: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 3 / tổng số 3 địa điểm (100.00%).

### 📍 Vĩnh Long (Thiếu 1,279 / 1,332 địa điểm - 96.02%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 342 / tổng số 348 địa điểm (98.28%).
  * Cafe & Đồ uống: Thiếu 215 / tổng số 216 địa điểm (99.54%).
  * Nhà hàng: Thiếu 92 / tổng số 92 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 58 / tổng số 58 địa điểm (100.00%).
  * Pub/Bar: Thiếu 12 / tổng số 12 địa điểm (100.00%).
  * Quán chay: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 6 / tổng số 6 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 217 / tổng số 217 địa điểm (100.00%).
  * Karaoke: Thiếu 46 / tổng số 46 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 29 / tổng số 29 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 27 / tổng số 27 địa điểm (100.00%).
  * Di tích: Thiếu 26 / tổng số 26 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 18 / tổng số 18 địa điểm (100.00%).
  * Nông trại: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Billiards: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Làng nghề: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Rạp phim: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 4 / tổng số 5 địa điểm (80.00%).
  * Tour có hướng dẫn: Thiếu 3 / tổng số 3 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Homestay & Villa: Thiếu 26 / tổng số 41 địa điểm (63.41%).
  * Khách sạn & Resort: Thiếu 12 / tổng số 40 địa điểm (30.00%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 40 / tổng số 40 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Tây Ninh (Thiếu 1,231 / 1,255 địa điểm - 98.09%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 266 / tổng số 270 địa điểm (98.52%).
  * Cafe & Đồ uống: Thiếu 192 / tổng số 194 địa điểm (98.97%).
  * Nhà hàng: Thiếu 49 / tổng số 50 địa điểm (98.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 42 / tổng số 42 địa điểm (100.00%).
  * Quán chay: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Pub/Bar: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 286 / tổng số 286 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 55 / tổng số 55 địa điểm (100.00%).
  * Di tích: Thiếu 47 / tổng số 47 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 45 / tổng số 45 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 42 / tổng số 42 địa điểm (100.00%).
  * Nông trại: Thiếu 29 / tổng số 29 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 27 / tổng số 27 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 25 / tổng số 25 địa điểm (100.00%).
  * Billiards: Thiếu 22 / tổng số 22 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Karaoke: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 4 / tổng số 5 địa điểm (80.00%).
  * Bãi biển/Vịnh: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Làng nghề: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Bảo tàng nghệ thuật/3D: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Homestay & Villa: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Khách sạn & Resort: Thiếu 5 / tổng số 20 địa điểm (25.00%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 13 / tổng số 13 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Đồng Tháp (Thiếu 1,197 / 1,256 địa điểm - 95.30%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 326 / tổng số 340 địa điểm (95.88%).
  * Cafe & Đồ uống: Thiếu 173 / tổng số 177 địa điểm (97.74%).
  * Nhà hàng: Thiếu 88 / tổng số 89 địa điểm (98.88%).
  * Tiệm bánh & Tráng miệng: Thiếu 47 / tổng số 48 địa điểm (97.92%).
  * Buffet & Khu ẩm thực: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Quán chay: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Pub/Bar: Thiếu 6 / tổng số 6 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 140 / tổng số 140 địa điểm (100.00%).
  * Karaoke: Thiếu 64 / tổng số 64 địa điểm (100.00%).
  * Di tích: Thiếu 45 / tổng số 45 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 35 / tổng số 35 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 33 / tổng số 33 địa điểm (100.00%).
  * Nông trại: Thiếu 24 / tổng số 24 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 20 / tổng số 20 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 17 / tổng số 17 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Làng nghề: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Billiards: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Rạp phim: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 21 / tổng số 53 địa điểm (39.62%).
  * Homestay & Villa: Thiếu 3 / tổng số 9 địa điểm (33.33%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 33 / tổng số 33 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 21 / tổng số 22 địa điểm (95.45%).
  * Dịch vụ du lịch: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 2 / tổng số 2 địa điểm (100.00%).

### 📍 Hải Phòng (Thiếu 977 / 1,713 địa điểm - 57.03%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 274 / tổng số 658 địa điểm (41.64%).
  * Tiệm bánh & Tráng miệng: Thiếu 106 / tổng số 156 địa điểm (67.95%).
  * Cafe & Đồ uống: Thiếu 86 / tổng số 146 địa điểm (58.90%).
  * Nhà hàng: Thiếu 72 / tổng số 108 địa điểm (66.67%).
  * Pub/Bar: Thiếu 15 / tổng số 16 địa điểm (93.75%).
  * Buffet & Khu ẩm thực: Thiếu 2 / tổng số 3 địa điểm (66.67%).
  * Quán chay: Thiếu 2 / tổng số 5 địa điểm (40.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Karaoke: Thiếu 82 / tổng số 82 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 59 / tổng số 59 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Rạp phim: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Billiards: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Di tích: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Nông trại: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 59 / tổng số 190 địa điểm (31.05%).
  * Homestay & Villa: Thiếu 21 / tổng số 75 địa điểm (28.00%).
  * Nhà nghỉ: Thiếu 4 / tổng số 14 địa điểm (28.57%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 66 / tổng số 66 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 32 / tổng số 34 địa điểm (94.12%).
  * Trung tâm thương mại: Thiếu 23 / tổng số 27 địa điểm (85.19%).
  * Dịch vụ du lịch: Thiếu 17 / tổng số 17 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 3 / tổng số 3 địa điểm (100.00%).

### 📍 Nghệ An (Thiếu 913 / 1,133 địa điểm - 80.58%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 414 / tổng số 523 địa điểm (79.16%).
  * Tiệm bánh & Tráng miệng: Thiếu 126 / tổng số 145 địa điểm (86.90%).
  * Cafe & Đồ uống: Thiếu 125 / tổng số 178 địa điểm (70.22%).
  * Nhà hàng: Thiếu 104 / tổng số 107 địa điểm (97.20%).
  * Pub/Bar: Thiếu 23 / tổng số 27 địa điểm (85.19%).
  * Quán chay: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 4 / tổng số 4 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Di tích: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Karaoke: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Rạp phim: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Billiards: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 27 / tổng số 57 địa điểm (47.37%).
  * Homestay & Villa: Thiếu 1 / tổng số 2 địa điểm (50.00%).
  * Nhà nghỉ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 31 / tổng số 31 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 12 / tổng số 13 địa điểm (92.31%).
  * Cửa hàng tiện lợi: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 5 / tổng số 5 địa điểm (100.00%).

### 📍 Thanh Hóa (Thiếu 790 / 869 địa điểm - 90.91%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 307 / tổng số 326 địa điểm (94.17%).
  * Nhà hàng: Thiếu 103 / tổng số 106 địa điểm (97.17%).
  * Cafe & Đồ uống: Thiếu 102 / tổng số 112 địa điểm (91.07%).
  * Tiệm bánh & Tráng miệng: Thiếu 87 / tổng số 90 địa điểm (96.67%).
  * Pub/Bar: Thiếu 18 / tổng số 18 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Quán chay: Thiếu 5 / tổng số 5 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Karaoke: Thiếu 21 / tổng số 21 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Di tích: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Rạp phim: Thiếu 3 / tổng số 4 địa điểm (75.00%).
  * Thể thao trong nhà: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Làng nghề: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Nông trại: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 27 / tổng số 68 địa điểm (39.71%).
  * Homestay & Villa: Thiếu 7 / tổng số 9 địa điểm (77.78%).
* **Nhóm Mua sắm (shopping)**:
  * Trung tâm thương mại: Thiếu 24 / tổng số 24 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 5 / tổng số 5 địa điểm (100.00%).

### 📍 Gia Lai (Thiếu 682 / 782 địa điểm - 87.21%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 161 / tổng số 162 địa điểm (99.38%).
  * Cafe & Đồ uống: Thiếu 120 / tổng số 120 địa điểm (100.00%).
  * Nhà hàng: Thiếu 50 / tổng số 50 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 25 / tổng số 25 địa điểm (100.00%).
  * Pub/Bar: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Quán chay: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 42 / tổng số 42 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 39 / tổng số 39 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 33 / tổng số 33 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 32 / tổng số 32 địa điểm (100.00%).
  * Karaoke: Thiếu 27 / tổng số 27 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 19 / tổng số 19 địa điểm (100.00%).
  * Di tích: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Nông trại: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Billiards: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Rạp phim: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Làng nghề: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 37 / tổng số 113 địa điểm (32.74%).
  * Homestay & Villa: Thiếu 8 / tổng số 29 địa điểm (27.59%).
  * Nhà nghỉ: Thiếu 2 / tổng số 4 địa điểm (50.00%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Quảng Trị (Thiếu 427 / 471 địa điểm - 90.66%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 127 / tổng số 127 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 71 / tổng số 71 địa điểm (100.00%).
  * Nhà hàng: Thiếu 68 / tổng số 68 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 13 / tổng số 13 địa điểm (100.00%).
  * Pub/Bar: Thiếu 7 / tổng số 8 địa điểm (87.50%).
  * Quán chay: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Karaoke: Thiếu 17 / tổng số 17 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Di tích: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 26 / tổng số 53 địa điểm (49.06%).
  * Homestay & Villa: Thiếu 15 / tổng số 29 địa điểm (51.72%).
  * Nhà nghỉ: Thiếu 5 / tổng số 7 địa điểm (71.43%).
* **Nhóm Mua sắm (shopping)**:
  * Dịch vụ du lịch: Thiếu 12 / tổng số 12 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 4 / tổng số 4 địa điểm (100.00%).

### 📍 Bắc Giang (Thiếu 427 / 457 địa điểm - 93.44%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 116 / tổng số 116 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 97 / tổng số 97 địa điểm (100.00%).
  * Nhà hàng: Thiếu 41 / tổng số 41 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 24 / tổng số 24 địa điểm (100.00%).
  * Pub/Bar: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Quán chay: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Karaoke: Thiếu 24 / tổng số 24 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 12 / tổng số 12 địa điểm (100.00%).
  * Di tích: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Billiards: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 12 / tổng số 38 địa điểm (31.58%).
  * Homestay & Villa: Thiếu 1 / tổng số 3 địa điểm (33.33%).
* **Nhóm Mua sắm (shopping)**:
  * Dịch vụ du lịch: Thiếu 32 / tổng số 32 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 2 / tổng số 2 địa điểm (100.00%).

### 📍 Lào Cai (Thiếu 394 / 550 địa điểm - 71.64%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 76 / tổng số 76 địa điểm (100.00%).
  * Nhà hàng: Thiếu 64 / tổng số 64 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 43 / tổng số 43 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Pub/Bar: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Quán chay: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Thiên nhiên: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Karaoke: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Di tích: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Rạp phim: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Làng nghề: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Nông trại: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Homestay & Villa: Thiếu 58 / tổng số 121 địa điểm (47.93%).
  * Khách sạn & Resort: Thiếu 52 / tổng số 141 địa điểm (36.88%).
  * Nhà nghỉ: Thiếu 3 / tổng số 7 địa điểm (42.86%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 4 / tổng số 4 địa điểm (100.00%).

### 📍 Hưng Yên (Thiếu 351 / 373 địa điểm - 94.10%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 95 / tổng số 95 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 63 / tổng số 63 địa điểm (100.00%).
  * Nhà hàng: Thiếu 37 / tổng số 37 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 22 / tổng số 22 địa điểm (100.00%).
  * Pub/Bar: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Quán chay: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 29 / tổng số 29 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 13 / tổng số 13 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 9 / tổng số 10 địa điểm (90.00%).
  * Thể thao trong nhà: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 5 / tổng số 6 địa điểm (83.33%).
  * Công viên giải trí: Thiếu 4 / tổng số 7 địa điểm (57.14%).
  * Nông trại: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Karaoke: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Làng nghề: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Di tích: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Billiards: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 4 / tổng số 19 địa điểm (21.05%).
  * Homestay & Villa: Thiếu 3 / tổng số 5 địa điểm (60.00%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Bắc Ninh (Thiếu 331 / 401 địa điểm - 82.54%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 49 / tổng số 74 địa điểm (66.22%).
  * Cafe & Đồ uống: Thiếu 44 / tổng số 57 địa điểm (77.19%).
  * Nhà hàng: Thiếu 34 / tổng số 40 địa điểm (85.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 15 / tổng số 19 địa điểm (78.95%).
  * Pub/Bar: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Quán chay: Thiếu 2 / tổng số 3 địa điểm (66.67%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 54 / tổng số 54 địa điểm (100.00%).
  * Karaoke: Thiếu 23 / tổng số 23 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Di tích: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Làng nghề: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Billiards: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Nông trại: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 13 / tổng số 30 địa điểm (43.33%).
  * Homestay & Villa: Thiếu 1 / tổng số 4 địa điểm (25.00%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 3 / tổng số 4 địa điểm (75.00%).
  * Dịch vụ du lịch: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Phú Thọ (Thiếu 318 / 365 địa điểm - 87.12%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 64 / tổng số 64 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 53 / tổng số 53 địa điểm (100.00%).
  * Nhà hàng: Thiếu 43 / tổng số 43 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 22 / tổng số 22 địa điểm (100.00%).
  * Pub/Bar: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Spa & Thư giãn: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Karaoke: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Rạp phim: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Di tích: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 25 / tổng số 61 địa điểm (40.98%).
  * Homestay & Villa: Thiếu 9 / tổng số 18 địa điểm (50.00%).
* **Nhóm Mua sắm (shopping)**:
  * Dịch vụ du lịch: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Quảng Ngãi (Thiếu 299 / 323 địa điểm - 92.57%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 94 / tổng số 94 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 77 / tổng số 77 địa điểm (100.00%).
  * Nhà hàng: Thiếu 30 / tổng số 30 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 21 / tổng số 21 địa điểm (100.00%).
  * Pub/Bar: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Quán chay: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Spa & Thư giãn: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Karaoke: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Nông trại: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Rạp phim: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Billiards: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 5 / tổng số 20 địa điểm (25.00%).
  * Homestay & Villa: Thiếu 4 / tổng số 12 địa điểm (33.33%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Cà Mau (Thiếu 295 / 307 địa điểm - 96.09%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 90 / tổng số 90 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 40 / tổng số 40 địa điểm (100.00%).
  * Nhà hàng: Thiếu 29 / tổng số 29 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Quán chay: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Pub/Bar: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 22 / tổng số 22 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 20 / tổng số 20 địa điểm (100.00%).
  * Karaoke: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Di tích: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Nông trại: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Rạp phim: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 7 / tổng số 18 địa điểm (38.89%).
  * Homestay & Villa: Thiếu 2 / tổng số 3 địa điểm (66.67%).
* **Nhóm Mua sắm (shopping)**:
  * Dịch vụ du lịch: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 2 / tổng số 2 địa điểm (100.00%).

### 📍 Ninh Bình (Thiếu 279 / 407 địa điểm - 68.55%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 41 / tổng số 41 địa điểm (100.00%).
  * Nhà hàng: Thiếu 34 / tổng số 34 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 28 / tổng số 28 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Pub/Bar: Thiếu 4 / tổng số 4 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 16 / tổng số 16 địa điểm (100.00%).
  * Karaoke: Thiếu 12 / tổng số 12 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Di tích: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 45 / tổng số 114 địa điểm (39.47%).
  * Homestay & Villa: Thiếu 43 / tổng số 101 địa điểm (42.57%).
  * Nhà nghỉ: Thiếu 4 / tổng số 5 địa điểm (80.00%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Kon Tum (Thiếu 232 / 245 địa điểm - 94.69%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 73 / tổng số 73 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 47 / tổng số 47 địa điểm (100.00%).
  * Nhà hàng: Thiếu 15 / tổng số 15 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 13 / tổng số 13 địa điểm (100.00%).
  * Pub/Bar: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 16 / tổng số 16 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 13 / tổng số 13 địa điểm (100.00%).
  * Karaoke: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Di tích: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Nông trại: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Làng nghề: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Tour có hướng dẫn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Homestay & Villa: Thiếu 4 / tổng số 9 địa điểm (44.44%).
  * Khách sạn & Resort: Thiếu 4 / tổng số 12 địa điểm (33.33%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 2 / tổng số 2 địa điểm (100.00%).

### 📍 Nam Định (Thiếu 225 / 233 địa điểm - 96.57%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 90 / tổng số 90 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 34 / tổng số 35 địa điểm (97.14%).
  * Nhà hàng: Thiếu 25 / tổng số 25 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 25 / tổng số 25 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Karaoke: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Billiards: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Mua sắm (shopping)**:
  * Dịch vụ du lịch: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 3 / tổng số 3 địa điểm (100.00%).

### 📍 Bạc Liêu (Thiếu 205 / 216 địa điểm - 94.91%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 53 / tổng số 53 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 33 / tổng số 33 địa điểm (100.00%).
  * Nhà hàng: Thiếu 19 / tổng số 19 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Pub/Bar: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 38 / tổng số 38 địa điểm (100.00%).
  * Di tích: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Karaoke: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Nhà hát/Sân khấu: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Nông trại: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 5 / tổng số 15 địa điểm (33.33%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 2 / tổng số 2 địa điểm (100.00%).

### 📍 Thái Nguyên (Thiếu 182 / 253 địa điểm - 71.94%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 61 / tổng số 87 địa điểm (70.11%).
  * Nhà hàng: Thiếu 26 / tổng số 29 địa điểm (89.66%).
  * Cafe & Đồ uống: Thiếu 23 / tổng số 38 địa điểm (60.53%).
  * Tiệm bánh & Tráng miệng: Thiếu 17 / tổng số 30 địa điểm (56.67%).
  * Buffet & Khu ẩm thực: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Quán chay: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Thiên nhiên: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Rạp phim: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Karaoke: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Di tích: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Làng nghề: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 8 / tổng số 17 địa điểm (47.06%).
  * Homestay & Villa: Thiếu 1 / tổng số 5 địa điểm (20.00%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 1 / tổng số 2 địa điểm (50.00%).

### 📍 Hà Tĩnh (Thiếu 178 / 191 địa điểm - 93.19%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 63 / tổng số 63 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 40 / tổng số 40 địa điểm (100.00%).
  * Nhà hàng: Thiếu 14 / tổng số 14 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 12 / tổng số 12 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Karaoke: Thiếu 17 / tổng số 17 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Bãi biển/Vịnh: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Billiards: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Di tích: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Nông trại: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 9 / tổng số 21 địa điểm (42.86%).
  * Nhà nghỉ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Cửa hàng tiện lợi: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Lạng Sơn (Thiếu 173 / 185 địa điểm - 93.51%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 58 / tổng số 58 địa điểm (100.00%).
  * Nhà hàng: Thiếu 39 / tổng số 39 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 21 / tổng số 21 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 17 / tổng số 17 địa điểm (100.00%).
  * Pub/Bar: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công trình tôn giáo: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Di tích: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 6 / tổng số 15 địa điểm (40.00%).
  * Homestay & Villa: Thiếu 1 / tổng số 4 địa điểm (25.00%).
* **Nhóm Mua sắm (shopping)**:
  * Dịch vụ du lịch: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Hòa Bình (Thiếu 165 / 193 địa điểm - 85.49%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Cafe & Đồ uống: Thiếu 24 / tổng số 24 địa điểm (100.00%).
  * Quán ăn: Thiếu 23 / tổng số 23 địa điểm (100.00%).
  * Nhà hàng: Thiếu 12 / tổng số 12 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Pub/Bar: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Thiên nhiên: Thiếu 9 / tổng số 9 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Karaoke: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Thể thao ngoài trời: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Thể thao trong nhà: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Công viên giải trí: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Di tích: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Nông trại: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 19 / tổng số 35 địa điểm (54.29%).
  * Homestay & Villa: Thiếu 14 / tổng số 26 địa điểm (53.85%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 21 / tổng số 21 địa điểm (100.00%).
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 3 / tổng số 3 địa điểm (100.00%).

### 📍 Hà Giang (Thiếu 127 / 199 địa điểm - 63.82%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Cafe & Đồ uống: Thiếu 16 / tổng số 16 địa điểm (100.00%).
  * Quán ăn: Thiếu 16 / tổng số 16 địa điểm (100.00%).
  * Nhà hàng: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Pub/Bar: Thiếu 3 / tổng số 3 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Thiên nhiên: Thiếu 10 / tổng số 10 địa điểm (100.00%).
  * Karaoke: Thiếu 7 / tổng số 7 địa điểm (100.00%).
  * Di tích: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Làng nghề: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Phố đi bộ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Homestay & Villa: Thiếu 25 / tổng số 70 địa điểm (35.71%).
  * Khách sạn & Resort: Thiếu 8 / tổng số 30 địa điểm (26.67%).
  * Nhà nghỉ: Thiếu 1 / tổng số 6 địa điểm (16.67%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Sơn La (Thiếu 126 / 149 địa điểm - 84.56%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 19 / tổng số 19 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 18 / tổng số 18 địa điểm (100.00%).
  * Nhà hàng: Thiếu 17 / tổng số 17 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Pub/Bar: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Thiên nhiên: Thiếu 19 / tổng số 19 địa điểm (100.00%).
  * Karaoke: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Nông trại: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Rạp phim: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Di tích: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Làng nghề: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Spa & Thư giãn: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Đài quan sát & Khu chụp ảnh: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Homestay & Villa: Thiếu 23 / tổng số 30 địa điểm (76.67%).
  * Khách sạn & Resort: Thiếu 4 / tổng số 20 địa điểm (20.00%).
  * Nhà nghỉ: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 5 / tổng số 5 địa điểm (100.00%).

### 📍 Điện Biên (Thiếu 66 / 98 địa điểm - 67.35%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 24 / tổng số 39 địa điểm (61.54%).
  * Cafe & Đồ uống: Thiếu 12 / tổng số 13 địa điểm (92.31%).
  * Nhà hàng: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Pub/Bar: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Karaoke: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Bảo tàng & Không gian trưng bày: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 1 / tổng số 12 địa điểm (8.33%).
  * Nhà nghỉ: Thiếu 1 / tổng số 2 địa điểm (50.00%).
* **Nhóm Mua sắm (shopping)**:
  * Cửa hàng đặc sản/Quà lưu niệm: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Chợ truyền thống: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Dịch vụ du lịch: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Tuyên Quang (Thiếu 42 / 55 địa điểm - 76.36%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Nhà hàng: Thiếu 8 / tổng số 8 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Buffet & Khu ẩm thực: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Thiên nhiên: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Công trình tôn giáo: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Karaoke: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Rạp phim: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 3 / tổng số 10 địa điểm (30.00%).
  * Homestay & Villa: Thiếu 2 / tổng số 8 địa điểm (25.00%).
  * Nhà nghỉ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Mua sắm (shopping)**:
  * Dịch vụ du lịch: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Trung tâm thương mại: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Cao Bằng (Thiếu 36 / 52 địa điểm - 69.23%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Nhà hàng: Thiếu 11 / tổng số 11 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 5 / tổng số 5 địa điểm (100.00%).
  * Quán ăn: Thiếu 4 / tổng số 4 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Thiên nhiên: Thiếu 6 / tổng số 6 địa điểm (100.00%).
  * Công viên/Quảng trường: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Karaoke: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 3 / tổng số 12 địa điểm (25.00%).
  * Nhà nghỉ: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Mua sắm (shopping)**:
  * Dịch vụ du lịch: Thiếu 4 / tổng số 4 địa điểm (100.00%).

### 📍 Lai Châu (Thiếu 17 / 21 địa điểm - 80.95%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Cafe & Đồ uống: Thiếu 2 / tổng số 2 địa điểm (100.00%).
  * Quán ăn: Thiếu 2 / tổng số 2 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Công viên/Quảng trường: Thiếu 1 / tổng số 1 địa điểm (100.00%).
  * Thiên nhiên: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Lưu trú (accommodation)**:
  * Khách sạn & Resort: Thiếu 7 / tổng số 10 địa điểm (70.00%).
  * Homestay & Villa: Thiếu 3 / tổng số 4 địa điểm (75.00%).
* **Nhóm Mua sắm (shopping)**:
  * Trung tâm thương mại: Thiếu 1 / tổng số 1 địa điểm (100.00%).

### 📍 Bắc Kạn (Thiếu 10 / 12 địa điểm - 83.33%)
* **Nhóm Ẩm thực & Cafe (restaurant / cafe)**:
  * Quán ăn: Thiếu 4 / tổng số 4 địa điểm (100.00%).
  * Tiệm bánh & Tráng miệng: Thiếu 3 / tổng số 3 địa điểm (100.00%).
  * Cafe & Đồ uống: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Tham quan & Vui chơi (attraction / entertainment)**:
  * Thiên nhiên: Thiếu 1 / tổng số 1 địa điểm (100.00%).
* **Nhóm Mua sắm (shopping)**:
  * Chợ truyền thống: Thiếu 1 / tổng số 1 địa điểm (100.00%).

==================================================

## 4. Ý Kiến Chuyên Môn: Phương Án Thiết Kế Lưu Trữ Giờ Đóng/Mở Cửa

**Vấn đề đặt ra:** Giờ đóng/mở cửa hiện được lưu dạng JSON trong cơ sở dữ liệu, phục vụ hai mục đích:
1. Hiển thị trên giao diện người dùng (Flutter App UI).
2. Lập lịch trình tối ưu bằng thuật toán Di truyền (Genetic Algorithm - GA) ở Backend (FastAPI).

**Khuyến nghị giải pháp:** **Nên tách biệt cách biểu diễn dữ liệu ở mức xử lý thuật toán (Paraphrase) nhưng giữ nguyên nguồn lưu trữ gốc dạng JSON ở Database.**

### Phân tích chi tiết:

#### A. Tại sao nên giữ JSON ở mức lưu trữ (Database & API)?
* **Linh hoạt cao**: Phù hợp để diễn tả các khung giờ phức tạp (ví dụ: mở nhiều ca trong ngày, đóng cửa nghỉ lễ, thứ 7 mở muộn hơn...).
* **Flutter App parse dễ dàng**: Flutter chỉ cần lấy chuỗi JSON về, hiển thị trực quan cho người dùng rất đơn giản mà không cần tính toán logic phức tạp.
* **Đơn giản hóa database**: Tránh việc tạo quá nhiều cột làm phình to bảng dữ liệu.

#### B. Tại sao BẮT BUỘC phải chuyển đổi (Paraphrase) khi chạy thuật toán GA?
* **Vấn đề hiệu năng**: Trong thuật toán GA (FastAPI), hàm đánh giá độ thích nghi (Fitness Function) sẽ được lặp đi lặp lại hàng triệu lần mỗi request để kiểm tra ràng buộc khung thời gian (Time Windows).
* **Nguy cơ nghẽn**: Nếu mỗi lần kiểm tra, Python phải thực hiện parse chuỗi JSON và xử lý logic ngày tháng/giờ của từng địa điểm, thuật toán sẽ bị nghẽn cổ chai (performance bottleneck) nghiêm trọng và thời gian phản hồi API có thể lên tới hàng chục giây.
* **Giải pháp tối ưu cho GA**: Trong bước tiền xử lý dữ liệu đầu vào (Pre-processing) trước khi chạy thuật toán tiến hóa, FastAPI nên chuyển đổi giờ mở/đóng cửa của ngày được chọn thành **số phút tính từ 0h** (ví dụ: `08:00` -> `480` phút, `22:00` -> `1320` phút). Nhờ đó, thuật toán GA chỉ cần so sánh các số nguyên (`visit_time >= open_minutes` và `visit_time + duration <= close_minutes`), tăng tốc độ xử lý gấp hàng trăm lần.

#### C. Chỗ tiền xử lý là xử lý khi nào? Lưu trữ như thế nào?

##### 1. Xử lý khi nào?
Quá trình tiền xử lý (Preprocessing) diễn ra **ngay sau khi nhận request** tại API Service / AI Service, trước khi thuật toán GA bắt đầu chạy. Cụ thể:
1. **Flutter** gửi yêu cầu tạo lịch trình (bao gồm ngày đi, ngày về).
2. **API Service (NestJS)** truy vấn các địa điểm ứng viên từ Supabase (có chuỗi JSON giờ mở cửa).
3. **NestJS** gửi payload (chứa danh sách địa điểm + ngày đi ngày về) sang **AI Service (FastAPI)**.
4. **FastAPI** parse dữ liệu đầu vào. Tại bước này, FastAPI sẽ xác định mỗi ngày trong chuyến đi tương ứng với thứ mấy trong tuần (ví dụ: Ngày 1 là Thứ Hai, Ngày 2 là Thứ Ba...).
5. FastAPI chạy hàm tiền xử lý: Đọc chuỗi JSON giờ mở cửa của từng địa điểm, lọc ra khung giờ của ngày thứ tương ứng, và convert các chuỗi thời gian (`HH:MM:SS`) thành số nguyên (số phút từ 0h).

##### 2. Lưu trữ như thế nào?
Dữ liệu sau tiền xử lý **CHỈ lưu trữ tạm thời trên bộ nhớ RAM (In-memory)** trong suốt vòng đời của request đó. Bạn **không cần và không nên** lưu ngược lại Database.
* **Cấu trúc lưu trữ gợi ý trong code Python (FastAPI):**
  Bạn định nghĩa một class POI đại diện cho địa điểm tham quan khi đưa vào GA. Class này sẽ có thêm một thuộc tính là `trip_hours` dạng dict:
  ```python
  class POI:
      id: str
      name: str
      latitude: float
      longitude: float
      # trip_hours lưu: { chỉ_số_ngày_đi: (giờ_mở_phút, giờ_đóng_phút) }
      # Ví dụ chuyến đi 3 ngày:
      # day 1 (Thứ Hai): mở 08:00 - 22:00 -> 480 đến 1320 phút
      # day 2 (Thứ Ba): mở 08:00 - 22:00 -> 480 đến 1320 phút
      # day 3 (Thứ Tư): mở 08:00 - 23:00 -> 480 đến 1380 phút
      trip_hours: dict[int, tuple[int, int]] = {
          1: (480, 1320),
          2: (480, 1320),
          3: (480, 1380)
      }
  ```
* **Ưu điểm**: Cực kỳ gọn nhẹ, giải phóng bộ nhớ ngay sau khi API trả kết quả lịch trình về cho người dùng. Thuật toán GA khi chạy chỉ cần truy cập trực tiếp vào `poi.trip_hours[day]` để lấy nhanh cặp số nguyên so sánh.

#### D. Kết luận:
Bạn **không nên tách làm hai cột lưu trữ cứng trong database** (gây dư thừa dữ liệu). Thay vào đó, hãy lưu dạng JSON ở Database/Supabase, và thực hiện **chuyển đổi động (Dynamic Paraphrase) thành số phút ở Backend (FastAPI/NestJS) ngay trước khi gọi thuật toán GA**.