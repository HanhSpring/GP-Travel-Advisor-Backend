# Colab Retrain Flow

Folder Google Drive dùng để lưu data train và kết quả tạm:

```text
https://drive.google.com/drive/folders/1kJJlAiUdW-mi0GdPLuDhCH0V3n4CIYse
```

Folder ID:

```text
1kJJlAiUdW-mi0GdPLuDhCH0V3n4CIYse
```

## 1. Chuẩn bị Drive

Trong Google Drive, mở folder trên rồi chọn:

```text
Organize -> Add shortcut -> My Drive
```

Đặt tên shortcut/folder là:

```text
GP-Retrain
```

Sau khi mount Drive trong Colab, folder này phải truy cập được tại:

```text
/content/drive/MyDrive/GP-Retrain
```

Tạo cấu trúc:

```text
GP-Retrain/
  state/
  input/
  output/
    data/
    recommender_artifacts/
  logs/
```

File quan trọng nhất là:

```text
GP-Retrain/state/tourist_user_map.csv
```

Không xóa file này. Nó giữ mapping:

```text
tourist_id UUID -> numeric_id
```

CF personalization cho user thật phụ thuộc vào mapping này.

## 2. Colab setup

Trong Colab Pro:

```python
from google.colab import drive
drive.mount("/content/drive")

DRIVE_ROOT = "/content/drive/MyDrive/GP-Retrain"
```

Cài package:

```python
!pip install -q supabase boto3 sentence-transformers scikit-surprise
```

Clone repo hoặc upload repo vào Colab runtime:

```python
!git clone <YOUR_REPO_URL> /content/GP-Travel-Advisor-Backend
%cd /content/GP-Travel-Advisor-Backend/ai-service/retrain
```

Nếu repo private, có thể upload folder `ai-service/retrain` thủ công lên Colab runtime.

## 3. Chạy retrain trên Colab

Nếu muốn chạy Colab và upload R2 luôn, mở notebook:

```text
GP_Retrain_Colab.ipynb
```

Notebook này mặc định chạy:

```python
!python colab_retrain_pipeline.py --force
```

Nó train, ghi kết quả vào Drive và upload artifact lên R2 nếu R2 env đã cấu hình. Sau đó notebook sẽ hiển thị:

```text
snapshot.json
metrics.val_rmse / metrics.test_rmse
num_users / num_items / n_factors
danh sách artifact
tourist_user_map.csv
```

Nếu chỉ muốn kiểm tra mà không upload R2, dùng cell dry-run cuối notebook.

Tạo env trong notebook trước khi chạy:

```python
import os

os.environ["SUPABASE_URL"] = "<supabase-url>"
os.environ["SUPABASE_KEY"] = "<supabase-service-or-anon-key>"

os.environ["R2_ENDPOINT_URL"] = "<cloudflare-r2-endpoint>"
os.environ["R2_ACCESS_KEY_ID"] = "<r2-access-key>"
os.environ["R2_SECRET_ACCESS_KEY"] = "<r2-secret-key>"
os.environ["R2_BUCKET_NAME"] = "ai-artifacts"

os.environ["COLAB_RETRAIN_DRIVE_ROOT"] = "/content/drive/MyDrive/GP-Retrain"
```

Chạy train và upload R2:

```python
!python colab_retrain_pipeline.py --force
```

Nếu chỉ muốn kiểm tra không upload R2:

```python
!python colab_retrain_pipeline.py --force --dry-run
```

## 4. Sau khi upload R2

Restart `ai-service` để service tải artifact mới từ R2.

Nếu service có cache local, xóa cache trước khi restart hoặc đảm bảo pipeline đã xóa cache ở server chạy service:

```text
ARTIFACT_CACHE_DIR/recommender_artifacts
ARTIFACT_CACHE_DIR/data
```

## 5. Kiểm tra personalization

Mở:

```text
GP-Retrain/state/tourist_user_map.csv
```

Chọn một dòng:

```csv
tourist_id,numeric_id
<uuid>,1000000000
```

Gọi AI service với numeric id:

```text
/recommend/places/<place_id>/recommendations?user_id=1000000000&k=10
```

Nếu output có `source = "CF"` hoặc `"BOTH"` thì CF personalization đã tham gia.
