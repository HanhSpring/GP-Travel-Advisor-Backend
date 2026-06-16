# Đặc tả Thiết kế Thuật toán: GA theo Ngày (Daily GA + Pre-allocation)

Tài liệu này định nghĩa chi tiết đặc tả kỹ thuật, công thức toán học và thiết kế thuật toán cho việc cấu trúc lại lõi tối ưu hóa lịch trình du lịch của phân hệ AI Service (FastAPI) từ **Global GA + Rollover** sang **Daily GA + Pre-allocation** kết hợp **Tối ưu Tiện ích** và **Tự động co giãn thời gian**.

---

## 1. Tổng quan Kiến trúc

Trong mô hình này, việc phân phối địa điểm được thực hiện theo 2 giai đoạn tách biệt:
1.  **Phân bổ trước (Pre-allocation)**: Các địa điểm được chia cụm địa lý và phân bổ cứng về các ngày trước khi GA chạy.
2.  **Tối ưu hóa theo Ngày (Daily GA)**: Chạy thuật toán di truyền độc lập trên từng ngày dựa trên danh sách địa điểm đã được phân bổ cho ngày đó.

```
[Danh sách Ứng viên (Attractions + Restaurants)]
                     │
                     ▼
       ┌───────────────────────────┐
       │   Phân bổ trước địa lý    │
       │     (Pre-allocation)      │
       └─────────────┬─────────────┘
                     │ (Chia đều nhà hàng & Gom cụm điểm tham quan)
         ┌───────────┼───────────┐
         ▼           ▼           ▼
     ┌───────┐   ┌───────┐   ┌───────┐
     │Ngày 1 │   │Ngày 2 │   │Ngày 3 │ (Cụm điểm riêng biệt)
     └───┬───┘   └───┬───┘   └───┬───┘
         ▼           ▼           ▼
     ┌───────┐   ┌───────┐   ┌───────┐
     │ GA 1  │   │ GA 2  │   │ GA 3  │ (Tối ưu hóa độc lập)
     └───┬───┘   └───┬───┘   └───┬───┘
         ▼           ▼           ▼
     ┌───────────────────────────┐
     │  Tổng hợp Lịch trình 3D   │
     └───────────────────────────┘
```

---

## 2. Chi tiết Thuật toán Gom cụm & Phân bổ (Pre-allocation)

Trước khi bắt đầu vòng lặp GA, lớp `MultiDayTripPlanner` sẽ chia tập hợp các địa điểm ứng viên vào các ngày dựa trên nguyên tắc địa lý và phân bổ đều dịch vụ:

### A. Phân chia nhà hàng (`restaurant`)
- Phân chia đều các nhà hàng ứng viên vào các ngày dựa trên thứ hạng (rank) để đảm bảo mỗi ngày có đúng 1 nhà hàng làm bữa ăn trưa (nếu số lượng nhà hàng đầu vào đủ cung cấp).

### B. Phân chia điểm tham quan (`attraction`)
- Sử dụng tọa độ GPS của Khách sạn du khách chọn làm gốc tọa độ.
- Tính toán góc radian $\theta_i$ và khoảng cách bán kính $d_i$ của từng địa điểm $i$ so với khách sạn.
- Gom nhóm các điểm tham quan gần nhau hoặc cùng hướng di chuyển vào các ngày để đảm bảo cự ly di chuyển chặng trong ngày ngắn nhất.
- Ví dụ phân phối cho hành trình 3 ngày:
  - **Ngày 1**: Các địa điểm thuộc hướng Đông-Bắc.
  - **Ngày 2**: Các địa điểm thuộc hướng Tây-Nam.
  - **Ngày 3**: Các địa điểm thuộc hướng Đông-Nam.

### C. Cân bằng tải (Load Balancing)
- Áp dụng cơ chế điều phối nếu xảy ra hiện tượng lệch tải lớn (ví dụ: ngày quá nhiều điểm, ngày trống điểm). Đảm bảo mỗi ngày có ít nhất 1 điểm tham quan và tổng số điểm mỗi ngày không vượt quá giới hạn cứng:
  $$\text{max\_pois\_per\_day} = \max\left(1, \lceil \text{Tổng số điểm} / \text{Số ngày} \rceil\right)$$

---

## 3. Lõi Thuật toán GA theo Ngày & Co giãn Thời gian

Mỗi ngày du lịch $D$ sẽ chạy một bộ máy GA `TSP_TW_GA` độc lập trên tập con địa điểm được chỉ định từ Bước 2. Trong quá trình giả lập lịch trình của nhiễm sắc thể (`_objective`):

### A. Tự động co giãn thời gian (Dynamic Duration Expansion)
Để giải quyết xung đột giữa việc đi ít điểm và thời gian chờ rỗng, thuật toán thực hiện:
- Nếu đến sớm trước giờ mở cửa của điểm tiếp theo (Wait Time > 0) hoặc dư dôi thời gian rảnh rỗi trước giờ kết thúc ngày (Idle Time > 0):
- **Tự động cộng thêm khoảng thời gian trống này vào thời lượng tham quan (visit_duration) của địa điểm hiện tại**.
- Đảm bảo:
  $$\text{Thời lượng thực tế} = \text{visit\_duration} + \text{Slack Time (Tối đa thêm 60 - 120 phút)}$$
- Giúp lịch trình đầy đặn trên timeline UI một cách tự nhiên.

### B. Giới hạn cuối ngày
- Nếu thời gian rời khỏi địa điểm cộng chặng về khách sạn vượt quá thời gian kết thúc ngày du lịch (ví dụ: 21:00), GA sẽ ngắt hành trình ngày đó tại điểm trước đó. Các điểm còn lại trong nhiễm sắc thể của ngày hôm đó sẽ bị loại bỏ.

---

## 4. Hàm Fitness tối ưu hóa Tiện ích (Utility-based Fitness)

Hàm Fitness mới loại bỏ toàn bộ các tham số phạt thời gian rảnh rỗi hoặc chờ đợi bằng trọng số tùy ý, thay vào đó tối ưu hóa **Tiện ích du khách (Tourist Utility)** và phạt ràng buộc cứng bằng phương pháp phạt **Big-M**:

$$\text{Min } \text{Fitness} = \text{Feasibility Penalty} + (0.5 \times T_{\text{travel}}) - \sum_{i \in \text{visited}} \text{Utility}_i$$

### A. Tiện ích địa điểm ($\text{Utility}_i$)
Được lượng hóa trên thang điểm 100:
$$\text{Utility}_i = 100 \times \left( 0.7 \times R_i + 0.3 \times \frac{\text{Rating}_i}{5.0} \right)$$
- **Trong đó**:
  - $R_i = 1.0 - \frac{\text{rank}_i}{N}$: Điểm độ tương đồng cá nhân hóa từ mô hình học sâu Two-Tower & MMR.
  - $\frac{\text{Rating}_i}{5.0}$: Điểm chất lượng dịch vụ cộng đồng.

### B. Chi phí di chuyển ($0.5 \times T_{\text{travel}}$)
- Thể hiện chi phí sức khỏe/mệt mỏi của du khách. Cứ mỗi phút di chuyển trên đường sẽ làm giảm mất $0.5$ điểm tiện ích của chuyến đi.

### C. Hình phạt ràng buộc cứng (Feasibility Penalty)
- Phạt trễ giờ đóng cửa: $100,000$ điểm cho mỗi địa điểm vi phạm.
- Phạt thiếu bữa trưa (khung giờ 11:30 - 13:30): $100,000$ điểm.

---

## 5. Kế hoạch Kiểm thử (Verification)

Hãy chạy trực tiếp lõi thuật toán bằng python script local trên tập dữ liệu CSV mẫu để kiểm tra tính chính xác của thuật toán:
```powershell
python ai-service/app/services/itinerary/planner.py --days 3 --start 08:00 --end 21:00 --source csv --limit 15
```

### Tiêu chí kiểm tra:
1. **Kiểm tra Pre-allocation**: In ra console danh sách ứng viên của từng ngày trước khi chạy GA, xác nhận các địa điểm đã được gom cụm địa lý (Đông/Tây/Nam/Bắc) rõ ràng.
2. **Kiểm tra Co giãn thời gian**: Kiểm tra cột thời lượng tham quan trong bảng kết quả, xác nhận các địa điểm có thời gian tham quan thực tế co giãn thông minh (ví dụ: tăng lên 120 phút hoặc 150 phút thay vì cố định 90 phút) để loại bỏ khoảng thời gian chờ/rảnh.
3. **Kiểm tra Hội tụ GA**: Điểm fitness của lộ trình qua các thế hệ phải giảm dần và không bị dồn hết địa điểm về Ngày 1.
