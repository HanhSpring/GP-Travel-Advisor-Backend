import torch
import torch.nn as nn


class TwoTowerModel(nn.Module):
    def __init__(self, user_dim: int = 64, item_dim: int = 64, embed_dim: int = 128):
        super().__init__()
        self.user_tower = nn.Sequential(
            nn.Linear(user_dim, 256),
            nn.ReLU(),
            nn.Linear(256, embed_dim),
        )
        self.item_tower = nn.Sequential(
            nn.Linear(item_dim, 256),
            nn.ReLU(),
            nn.Linear(256, embed_dim),
        )

    def forward(self, user_feat, item_feat):
        u = self.user_tower(user_feat)
        i = self.item_tower(item_feat)
        return torch.cosine_similarity(u, i, dim=-1)
