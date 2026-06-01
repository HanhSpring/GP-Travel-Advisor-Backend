import torch
import torch.nn as nn


class ReviewClassifier(nn.Module):
    """
    Phân loại review thành ngắn hạn (short_term) hoặc dài hạn (long_term).

    Logic cốt lõi:
    - Short-term: review mô tả trạng thái tạm thời ("hôm nay đông", "đang giảm giá")
    - Long-term: review mô tả đặc trưng ổn định ("luôn đông", "giá hợp lý")

    Input: embedding vector của review text (từ BGE-M3 hoặc tương tự)
    Output: xác suất [short_term, long_term]
    """

    def __init__(self, input_dim: int = 1024, hidden_dim: int = 256):
        super().__init__()
        self.classifier = nn.Sequential(
            nn.Linear(input_dim, hidden_dim),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(hidden_dim, 2),
        )

    def forward(self, x):
        return self.classifier(x)
