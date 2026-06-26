#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
review_filter_pipeline.py

Pipeline lọc đánh giá ngắn hạn — tích hợp vào ai-service FastAPI.
Được import bởi app/services/review_filter_service.py.

Nguồn gốc: review_filter_local.py (standalone CLI script).
Thay đổi: bỏ hàm main() CLI, giữ nguyên toàn bộ logic thuật toán.
"""

from __future__ import annotations

import json
import math
import os
import re
import unicodedata
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


# ============================================================================
# CONSTANTS
# ============================================================================

TTL_HOURS_BY_TOPIC: Dict[str, int] = {
    "traffic": 24,
    "weather": 24,
    "crowd": 48,
    "service": 72,
    "price": 72,
    "infra": 168,
    "food": 168,
    "atmosphere": 720,
    "activity": 168,
}

OBSERVATION_RULES: Dict[str, Any] = {
    "traffic": {"window_days": 7,  "threshold": 3, "sim_threshold": 0.62},
    "crowd":   {"window_days": 14, "threshold": 3, "sim_threshold": 0.62},
    "service": {"window_days": 14, "threshold": 3, "sim_threshold": 0.62},
    "infra":   {"window_days": 30, "threshold": 2, "sim_threshold": 0.58},
    "weather": {"window_days": 7,  "threshold": 3, "sim_threshold": 0.62},
    "price":   {"window_days": 14, "threshold": 3, "sim_threshold": 0.62},
    "food":    {"window_days": 30, "threshold": 3, "sim_threshold": 0.62},
    "atmosphere": {"window_days": 90, "threshold": 2, "sim_threshold": 0.60},
    "activity":   {"window_days": 30, "threshold": 3, "sim_threshold": 0.62},
    "other":      {"window_days": 14, "threshold": 3, "sim_threshold": 0.65},
}

TRANSIENT_TOPICS = {"traffic", "weather", "crowd"}

TOPIC_KEYWORDS: Dict[str, List[str]] = {
    "traffic": [
        "ket xe", "giao thong", "duong pho", "di chuyen", "un tac", "tai nan",
        "cam duong", "ach tac", "tac duong", "ket duong", "dau xe", "bai do xe",
        "bai xe", "xe may", "o to", "xe bus", "phuong tien", "tac nghen",
        "vong xuyen", "hanh trinh", "di lai", "duong vao", "cung duong", "mo duong",
        "lan duong", "duong nho", "di bo", "gui xe", "giu xe", "phi gui xe",
        "bai giu xe", "oto", "xe om", "grab", "taxi", "xe dap",
    ],
    "weather": [
        "thoi tiet", "troi mua", "mua lon", "nang nong", "bao lon", "gio lon",
        "nong buc", "lanh gia", "am uot", "ngap nuoc", "lu lut", "kho han",
        "nong", "lanh", "mua", "nang", "ngap", "song gio", "thoi tiet xau",
        "troi dep", "troi lanh", "nang gay", "nang chieu", "mua phun", "se lanh",
        "mat me", "hanh", "hoi", "gio manh", "bao", "bao to", "troi u am",
        "troi quang", "troi tot", "khi hau", "nhiet do",
    ],
    "crowd": [
        "dong duc", "qua dong", "qua tai", "xep hang", "cho doi", "it khach",
        "kin cho", "het cho", "chen chuc", "nhieu nguoi", "day nguoi", "vang ve",
        "dong khach", "nhieu khach", "thieu khach", "hang dai", "cho lau",
        "trong vang", "chen lan", "khong con cho", "ghe trong", "ban trong",
        "gio cao diem", "cuoi tuan dong", "dong nguoi", "vang lanh", "doi hang",
        "doi vo", "cho hang tieng", "chen vao",
    ],
    "infra": [
        "sua chua", "nang cap", "dong cua", "xuong cap", "cai tao", "ha tang",
        "thang may", "nha ve sinh", "co so vat chat", "xay dung", "thi cong",
        "pha bo", "nha xuong", "may moc", "he thong dien", "cap nuoc", "ong nuoc",
        "roi dien", "co so", "trang thiet bi", "ket cau", "may lanh", "dieu hoa",
        "wifi", "internet", "man hinh", "ghe ngoi", "ban ghe", "am thanh", "loa",
        "anh sang", "bai cho", "toa nha", "khu vuc", "phong", "tang", "nha tam",
        "phong tam", "lavabo", "nuoc nong", "nuoc lanh", "may bom", "he thong nuoc",
        "dien nuoc",
    ],
    "service": [
        "nhan vien", "phuc vu", "thai do phuc vu", "cham soc khach hang",
        "quan ly", "trai nghiem", "ho tro", "lich su", "vo lich su", "dich vu",
        "phuc vu nhanh", "phuc vu cham", "than thien", "nhan vien thu",
        "giai quyet", "phan hoi", "nhan vien nhiet tinh", "phong cach phuc vu",
        "tiep don", "don tiep", "chao hoi", "huong dan", "xin loi", "giai thich",
        "xu ly", "khieu nai", "chuyen nghiep", "nhiet tinh", "vui ve", "niem no",
        "hach dich", "kinh dich", "co biec", "kho chiu", "chu quan", "quan chu",
        "nhan vien nu", "nhan vien nam", "phuc vu ban", "goi mon", "tinh tien",
        "thanh toan",
    ],
    "price": [
        "gia ca", "qua dat", "gia re", "khuyen mai", "giam gia", "le phi",
        "chi phi", "hoa don", "gia tien", "mien phi", "phi dich vu", "gia hop ly",
        "gia cao", "tien", "dat", "re", "phi vao cua", "gia ve", "gia phong",
        "gia menu", "gia niem yet", "gia co dinh", "tien ve", "tien phong",
        "tien an", "phi phat sinh", "gia tot", "gia binh dan", "binh dan",
        "sang chanh", "dang dong tien", "khong xung dang", "bo tui", "coupon",
        "voucher", "ma giam gia", "uu dai", "thanh toan", "tinh tien", "bill",
    ],
    "food": [
        "do an", "mon an", "thuc an", "am thuc", "bua an", "nuoc leo",
        "nuoc dung", "nuoc cham", "nuoc sot", "com", "pho", "bun", "banh",
        "chao", "lau", "nuong", "chay", "ngon", "do", "nhat", "man", "cay",
        "ngot", "chat", "beo", "khai vi", "trang mieng", "huong vi", "vi",
        "khau vi", "mui thom", "suong", "them", "an", "uong", "an uong",
        "menu", "thuc don", "mon chinh", "mon phu", "nguyen lieu", "tuoi song",
        "khan phan", "phan an", "suat an", "tra", "ca phe", "sinh to", "nuoc ep",
        "bia", "com tam", "bun bo", "bun rieu", "banh mi", "banh cuon", "goi cuon",
        "suon", "ga", "hai san", "chien", "hap", "xao", "kho", "luoc",
        "dau bep", "bep truong", "nau an", "che bien", "tuoi ngon",
    ],
    "atmosphere": [
        "khong khi", "canh quan", "phong canh", "bau khong khi", "check in",
        "check-in", "chup anh", "selfie", "thien nhien", "kien truc", "trang tri",
        "noi that", "decor", "khong gian dep", "anh sang dep", "nen nhac",
        "am nhac nen", "phong cach", "co kinh", "hien dai", "doc dao", "lang man",
        "hung vi", "huu tinh", "view dep", "view", "phong canh dep", "canh dep",
        "bau khong khi de chiu", "khong gian thoai mai", "khong gian yen tinh",
        "dep", "sang trong", "xu huong", "hot", "instagrammable", "khung canh",
        "ao ho", "song", "bien", "nui", "rung", "ban dem", "buoi toi",
        "ban ngay", "hoang hon", "romantic", "thoai mai", "thu gian", "yen tinh",
    ],
    "activity": [
        "khu vui choi", "tro choi", "khu choi", "choi game", "game", "van dong",
        "the thao", "hoat dong", "tham gia", "khu tro choi", "san choi",
        "khu van dong", "boi loi", "leo nui", "leo tuong", "cau long", "bong da",
        "yoga", "gym", "the duc", "fitness", "karaoke", "xem phim", "rap phim",
        "phim", "spa", "massage", "cham soc", "lam thu cong", "workshop",
        "ve tranh", "lam banh", "cau ca", "cam trai", "hiking", "trekking",
        "bieu dien", "xem bieu dien", "am nhac song", "bong chuyen", "tennis",
        "pickleball", "boi", "chay bo", "xe dap", "truot van", "golf", "bi a",
        "dart", "bowling", "nhay", "khieu vu", "zumba", "aerobic",
        "tro choi nuoc", "cau truot", "tham quan", "kham pha", "du lich",
    ],
}

TOPIC_LABEL_MAP_VI: Dict[str, str] = {
    "traffic":    "giao thong",
    "weather":    "thoi tiet",
    "crowd":      "dong duc",
    "infra":      "ha tang",
    "service":    "dich vu",
    "price":      "gia ca",
    "food":       "do an va thuc uong",
    "atmosphere": "khong khi va canh quan",
    "activity":   "hoat dong vui choi the thao giai tri",
}
TOPIC_LABEL_MAP_VI_REVERSE: Dict[str, str] = {v: k for k, v in TOPIC_LABEL_MAP_VI.items()}

TOPIC_PROTOTYPES: Dict[str, List[str]] = {
    "traffic": [
        "ket xe tac duong kho di chuyen den noi nay",
        "duong den day hay bi un tac rat kho di",
        "bai do xe rong rai de tim cho dau xe thuan tien",
        "khong co cho dau xe kho tim bai xe gan",
        "giao thong thong thoang di lai de dang",
        "khu vuc hay ket xe gio cao diem",
        "xe may o to di chuyen kho khan duong nho",
    ],
    "weather": [
        "troi mua lon duong ngap nuoc kho di lai",
        "nang nong kho buc khi hau khong de chiu",
        "thoi tiet dep troi mat me rat thich hop di tham quan",
        "thoi tiet xau bao gio lon nguy hiem",
        "mua nhieu am uot khong khi nong",
        "troi lanh gio nhieu can mac am khi den",
        "thoi tiet on hoa thich hop cho moi hoat dong",
    ],
    "crowd": [
        "qua dong duc nguoi nhieu chen chuc kho chiu",
        "xep hang doi lau mat rat nhieu thoi gian",
        "vang ve it khach khong phai doi vao",
        "kin cho nguoi day het cho ngoi",
        "dong khach vao dip cuoi tuan le tet",
        "it nguoi thoai mai khong gian rong rai",
        "hang doi dai phai cho ca tieng dong",
    ],
    "infra": [
        "dang sua chua xay dung nen on ao nhieu bui",
        "co so vat chat tot trang thiet bi hien dai moi",
        "nha ve sinh sach se thoai mai",
        "may lanh hong het dien co so xuong cap",
        "thang may hu phai di bo nhieu tang",
        "he thong am thanh anh sang tot dep",
        "co so vat chat cu ky can nang cap sua chua",
        "dang dong cua nang cap tam thoi khong phuc vu",
    ],
    "service": [
        "nhan vien phuc vu nhiet tinh than thien chuyen nghiep",
        "thai do nhan vien te rat toi khong han hoan",
        "phuc vu cham tre cho qua lau",
        "nhan vien lich su ho tro tot giai quyet nhanh",
        "chu quan hach dich kho tinh khong than thien",
        "dich vu cham soc khach hang chu dao tot",
        "nhan vien thieu chuyen nghiep khong biet xu ly",
        "quan ly tot chuyen giai quyet kieu nai nhanh chong",
    ],
    "price": [
        "gia ca hop ly xung dang voi chat luong dang dong tien",
        "qua dat gia cao khong xung dang voi nhung gi nhan duoc",
        "gia re tot co nhieu khuyen mai giam gia hap dan",
        "chi phi cao mat tien hoa don lon phi dich vu dat",
        "mien phi vao cua khong mat them phi",
        "gia binh dan phu hop tui tien",
        "dat qua so voi chat luong thuc te",
    ],
    "food": [
        "do an ngon huong vi dac trung dac sac kho quen",
        "mon an nhat vo vi khong ngon that vong ve do an",
        "nguyen lieu tuoi song nuoc leo dam da phan an vua du",
        "thuc don phong phu nhieu mon an da dang lua chon",
        "ca phe ngon tra thom banh mi don gian ma ngon",
        "bun pho com banh canh do uong sinh to nuoc ep",
        "phan an it qua so voi gia tien khau phan khiem ton",
        "mon an dac trung vung mien kho tim o noi khac",
        "nguoi nau bep gioi tay nghe dau bep chuyen nghiep",
    ],
    "atmosphere": [
        "view dep khung canh dep chup anh check in dep",
        "khong khi lang man yen tinh thoai mai de chiu",
        "kien truc dep doc dao phong cach co kinh hien dai",
        "canh quan thien nhien hung vi dep mat",
        "trang tri noi that decor sang trong dep",
        "am nhac nen nhe nhang bau khong khi thu vi",
        "khong gian rong rai thoang mat nhieu cay xanh",
    ],
    "activity": [
        "khu vui choi nhieu tro choi cho ca tre em nguoi lon",
        "hoat dong the thao van dong the duc gym yoga boi loi",
        "tro choi game dien tu arcade khu choi game",
        "spa massage cham soc suc khoe thu gian the chat",
        "workshop lam thu cong ve tranh lam banh hoat dong sang tao",
        "bieu dien am nhac live show su kien giai tri",
        "khu van dong lien hoan leo nui leo tuong cau long",
        "choi thoai mai khong chan co nhieu hoat dong da dang",
    ],
    "other": [
        "cam nhan chung tot binh thuong khong co gi noi bat",
        "kho nhan xet cu the chi biet la ok hoac khong ok",
        "danh gia tong the trung binh khong an tuong",
        "noi nay co nhieu diem can noi nhung kho phan loai cu the",
    ],
}

TOPIC_E5_DESCRIPTIONS: Dict[str, str] = {
    "traffic": (
        "Đánh giá đề cập đến giao thông, tắc đường, kẹt xe, khó di chuyển đến địa điểm, "
        "bãi đỗ xe, chỗ đậu xe, phương tiện, đường xá xung quanh."
    ),
    "weather": (
        "Đánh giá đề cập đến thời tiết như trời mưa, nắng nóng, lạnh giá, gió bão, "
        "ngập lụt, nhiệt độ hoặc khí hậu ảnh hưởng đến trải nghiệm."
    ),
    "crowd": (
        "Đánh giá đề cập đến mức độ đông người, xếp hàng chờ đợi, chen chúc, quá tải, "
        "vắng vẻ, ít khách, không gian chật hẹp hay rộng rãi."
    ),
    "infra": (
        "Đánh giá đề cập đến cơ sở vật chất, trang thiết bị, thang máy, nhà vệ sinh, "
        "hệ thống điện nước, đang sửa chữa, xây dựng, nâng cấp."
    ),
    "service": (
        "Đánh giá đề cập đến nhân viên, thái độ phục vụ, dịch vụ khách hàng, "
        "sự nhiệt tình hay hách dịch, tốc độ phục vụ, quản lý địa điểm."
    ),
    "price": (
        "Đánh giá đề cập đến giá cả, chi phí đắt hay rẻ, hóa đơn, khuyến mãi, "
        "có xứng đáng với tiền bỏ ra không, phí vào cửa, phí dịch vụ."
    ),
    "food": (
        "Đánh giá đề cập đến đồ ăn, món ăn, thức uống, hương vị, ngon hay dở, "
        "thực đơn, nguyên liệu, phần ăn, nước lèo, đầu bếp, cách nấu."
    ),
    "atmosphere": (
        "Đánh giá đề cập đến không khí, cảnh quan, view đẹp, phong cảnh thiên nhiên, "
        "kiến trúc, trang trí nội thất, decor, không gian lãng mạn hay yên tĩnh, "
        "địa điểm check-in chụp ảnh đẹp, âm nhạc nền, bầu không khí của địa điểm."
    ),
    "activity": (
        "Đánh giá đề cập đến các hoạt động vui chơi, giải trí, thể thao tại địa điểm: "
        "khu vui chơi, trò chơi, game, thể dục, yoga, bơi lội, spa, massage, "
        "workshop thủ công, biểu diễn nghệ thuật, leo núi, cắm trại, karaoke, xem phim."
    ),
    "other": (
        "Đánh giá chung chung, mơ hồ, không đề cập cụ thể đến bất kỳ khía cạnh nào "
        "như đồ ăn, dịch vụ, giá cả, cơ sở vật chất, giao thông, thời tiết, "
        "đám đông, không khí, cảnh quan hay hoạt động — chỉ bày tỏ cảm xúc tổng quát "
        "hoặc nhận xét quá ngắn để phân loại."
    ),
}

STRONG_SHORT_TIME_CUES: List[str] = [
    "hom nay", "bay gio", "hien tai", "hien nay", "luc nay", "ngay hom nay",
    "sang nay", "chieu nay", "toi nay", "dem nay", "hom qua", "hom truoc",
    "ngay qua", "vua qua", "moi day", "gan day", "gan nhat", "tuan nay",
    "tuan truoc", "tuan vua", "thang nay", "thang truoc", "thang vua",
    "tam thoi", "nhat thoi", "truoc mat", "hien gio", "dip nay", "thoi diem nay",
    "cuoi tuan nay", "dau tuan nay", "moi khai truong", "moi mo cua",
    "vua khai truong", "lan nay", "lan do", "chuyen nay", "lan nay thi",
    "lan nay la", "lan nay khac", "lan nay te hon", "lan nay tot hon",
    "lan truoc tot hon", "binh thuong ngon nhung", "binh thuong tot nhung",
    "moi lan truoc",
]

WEAK_SHORT_TIME_CUES: List[str] = [
    "dang co", "dang sua", "dang dong", "dang vang",
    "vua den", "vua an", "vua uong", "vua thu", "vua toi", "vua duoc",
    "moi toi", "moi den", "moi thu", "moi an",
]

LONG_TIME_CUES: List[str] = [
    "nhieu nam", "lau dai", "on dinh", "thuong xuyen", "luon luon",
    "xuyen suot", "truyen thong", "tu truoc", "bao lau nay", "may nam",
    "hang nam", "tu lau", "quen thuoc", "co dinh", "bao gio cung",
    "tu truoc den nay", "nhieu lan", "lan nao cung", "tuan nao cung",
    "thang nao cung", "ngay nao cung", "luon ngon", "luon tot", "luon te",
    "luon cham", "luon nhanh", "luon phuc vu", "luon co", "luon sach",
    "luon ban", "luon on ao", "luon vang ve", "luon dong khach",
    "moi lan", "luc nao cung", "thu lai", "tro lai", "quay lai",
    "nhung lan", "da nhieu lan", "noi nay luon", "quan nay luon", "cho nay luon",
]

FALSE_POSITIVE_LONG_CUES: List[str] = [
    "luon la", "di luon", "next luon", "bo luon", "thoi luon",
]
FALSE_POSITIVE_WEAK_CUES: List[str] = [
    "la vua", "vua la", "xong la vua",
]

POSITIVE_WORDS: List[str] = [
    "tot", "tuyet voi", "dep", "hai long", "de nghi", "than thien",
    "ngon", "rat tot", "an tuong", "de chiu", "tuyet", "xuat sac",
    "hoan hao", "chu dao", "yeu thich", "noi bat", "dang tien",
    "sang trong", "thoai mai", "sach se", "nhanh chong", "tich cuc",
    "hieu qua", "niem no", "chat luong tot", "dich vu tot", "lang man",
    "thu vi", "yen tinh", "hap dan", "an tam", "tin tuong", "phu hop",
    "ung y", "chuan", "dang dong tien", "rat ngon", "phuc vu tot",
    "nhan vien tot", "gia hop ly", "sach bong", "kha", "on", "duoc",
    "binh thuong on", "chap nhan duoc", "rat dep", "dep lam", "ngon lam",
    "tot lam", "rat hai long", "cuon hut", "an tuong manh", "chat luong",
    "uy tin", "chuyen nghiep", "nhiet tinh", "ve sinh", "sach", "nhanh",
    "hieu qua", "tien loi", "phong phu", "da dang", "nhieu lua chon",
    "gia tri", "xung dang", "xung tam", "tuyet hao", "rat thich",
    "quy lam", "se quay lai", "nhat dinh quay lai", "recommend",
    "goi y", "de xuat", "dang thu", "nen thu", "nen den",
]

NEGATIVE_WORDS: List[str] = [
    "te", "toi", "that vong", "xau", "kinh khung", "khong hai long",
    "qua dat", "cho lau", "om ao", "ban", "on ao", "kem chat luong",
    "that bai", "kem", "lua dao", "chan nan", "kho chiu", "bat man",
    "cham tre", "phuc vu kem", "nhan vien thu", "tho lo", "khong sach",
    "bat tien", "mat vi", "khong ngon", "nhieu loi", "hay hong", "qua on",
    "nguy hiem", "xu ly cham", "khong phu hop", "hon don", "lang phi",
    "cau tha", "vo cam", "kinh", "te hai", "kem qua", "chan", "buc boi",
    "that bai hoan toan", "qua te", "toi qua", "kem hon mong doi",
    "khong dang", "khong xung dang", "phung phi", "mat tien", "vo ich",
    "lang phi thoi gian", "mat thoi gian", "khong dang tin",
    "khong chuyen nghiep", "thieu chuyen mon", "hu hong", "xuong cap",
    "kem chat", "phuc vu do", "nhan vien te", "chu quan hu",
    "dat ma khong ngon", "dat ma kem", "dat vo ly", "ban biu", "ban thiu",
    "o ban", "khong ve sinh", "hoi", "con trung", "gian", "ruoi", "mut",
    "cho lau qua", "cho mai", "doi rat lau", "khong nhan", "tu choi",
    "vo ly", "lo lang", "kho chiu qua", "phat buc", "tuc gian", "that kinh",
]

DEFAULT_EMBEDDING_MODEL  = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DEFAULT_TOPIC_MODEL      = "intfloat/multilingual-e5-small"
DEFAULT_SENTIMENT_MODEL  = "lxyuan/distilbert-base-multilingual-cased-sentiments-student"
DEFAULT_ZEROSHOT_MODEL   = "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli"


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_aware_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def strip_accents(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


def normalize_text(text: str) -> str:
    text = strip_accents(text.lower())
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def simple_tokens(text: str) -> List[str]:
    return [tok for tok in text.split(" ") if tok]


def count_keyword_hits(text: str, keywords: List[str]) -> int:
    token_set = set(text.split())
    count = 0
    for kw in keywords:
        parts = kw.split()
        if len(parts) == 1:
            if kw in token_set:
                count += 1
        else:
            if kw in text:
                count += 1
    return count


_VI_NEG_TOKENS = frozenset({"khong", "chang", "chua", "dung", "khoi"})


def count_sentiment_hits_negation_aware(
    norm_text: str,
    positive_kws: List[str],
    negative_kws: List[str],
) -> Tuple[int, int]:
    token_list = norm_text.split()

    def _is_negated(tok_idx: int) -> bool:
        window = token_list[max(0, tok_idx - 3): tok_idx]
        return any(t in _VI_NEG_TOKENS for t in window)

    eff_pos = 0
    eff_neg = 0

    for kw in positive_kws:
        parts = kw.split()
        if len(parts) == 1:
            for i, tok in enumerate(token_list):
                if tok == kw:
                    if _is_negated(i):
                        eff_neg += 1
                    else:
                        eff_pos += 1
        else:
            if kw in norm_text:
                eff_pos += norm_text.count(kw)

    for kw in negative_kws:
        parts = kw.split()
        if len(parts) == 1:
            for i, tok in enumerate(token_list):
                if tok == kw:
                    if _is_negated(i):
                        eff_pos += 1
                    else:
                        eff_neg += 1
        else:
            if kw in norm_text:
                eff_neg += norm_text.count(kw)

    return eff_pos, eff_neg


_HABITUAL_LONG_PATTERNS = [
    re.compile(r'\b(tuan|thang|ngay|lan|dip|ky)\s+nao\b.{0,15}\bcung\b'),
    re.compile(r'\b(luc|khi|hoi)\s+nao\b.{0,15}\bcung\b'),
    re.compile(r'\bsuot\s+(ca\s+)?(tuan|thang|nam|ngay|doi|thoi\s+gian)\b'),
    re.compile(r'\bkhong\s+lan\s+nao\b.{0,10}\bkhong\b'),
]


def count_habitual_pattern_hits(norm_text: str) -> int:
    return sum(1 for pat in _HABITUAL_LONG_PATTERNS if pat.search(norm_text))


def hash_embedding(tokens: List[str], dim: int = 64) -> List[float]:
    vec = [0.0] * dim
    for tok in tokens:
        idx = hash(tok) % dim
        sign = 1.0 if (hash(tok + "_sign") % 2 == 0) else -1.0
        vec[idx] += sign
    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


def cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
    return max(-1.0, min(1.0, sum(a * b for a, b in zip(vec_a, vec_b))))


def to_iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return ensure_aware_utc(dt).isoformat()


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return ensure_aware_utc(datetime.fromisoformat(value))


def ensure_float_dict(payload: Dict[str, float]) -> Dict[str, float]:
    return {k: float(v) for k, v in payload.items()}


def ensure_nested_float_dict(payload: Dict[str, Dict[str, float]]) -> Dict[str, Dict[str, float]]:
    return {ok: ensure_float_dict(iv) for ok, iv in payload.items()}


def build_topic_sentiment_scores(
    base_sentiment: Dict[str, float],
    topic_scores: Dict[str, float],
) -> Dict[str, Dict[str, float]]:
    sentiment_by_topic: Dict[str, Dict[str, float]] = {}
    for topic, score in topic_scores.items():
        topic_score = float(score)
        if topic_score <= 0.0:
            continue
        sentiment_by_topic[topic] = {
            "positive": float(base_sentiment["positive"] * topic_score),
            "neutral":  float(base_sentiment["neutral"]  * topic_score),
            "negative": float(base_sentiment["negative"] * topic_score),
        }
    if not sentiment_by_topic:
        sentiment_by_topic["other"] = {"positive": 0.0, "neutral": 1.0, "negative": 0.0}
    return sentiment_by_topic


# ============================================================================
# CONFIG
# ============================================================================

@dataclass
class PipelineConfig:
    input_label: str
    output_dir: Path
    now: datetime
    use_pretrained_model: bool
    embedding_model_name: str
    use_pretrained_classifiers: bool
    sentiment_model_name: str
    zeroshot_model_name: str
    topic_model_name: str
    classifier_confidence_threshold: float
    classifier_ambiguity_margin: float
    topic_other_threshold: float
    candidate_mode: str
    top_k: int
    old_lookback_multiplier: int
    promotion_mode: str
    phobert_time_model_path: Optional[str] = None


# ============================================================================
# MODEL PROVIDERS
# ============================================================================

class EmbeddingProvider:
    def __init__(self, use_pretrained_model: bool, model_name: str):
        self.model_active = False
        self.model_error: Optional[str] = None
        self._model = None
        self._tokenizer = None
        self._torch = None

        if not use_pretrained_model:
            return

        try:
            import torch
            from transformers import AutoTokenizer, AutoModel
            _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            self._tokenizer = AutoTokenizer.from_pretrained(model_name)
            self._model = AutoModel.from_pretrained(model_name)
            self._model.to(_device)
            self._model.eval()
            self._torch = torch
            self._device = _device
            self.model_active = True
        except Exception as exc:
            self.model_error = str(exc)

    def _mean_pool(self, last_hidden_state, attention_mask):
        mask = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
        return (last_hidden_state * mask).sum(1) / mask.sum(1).clamp(min=1e-9)

    def embed(self, normalized_text: str, tokens: List[str]) -> List[float]:
        if self.model_active and self._model is not None and self._tokenizer is not None:
            try:
                inputs = self._tokenizer(
                    [normalized_text], return_tensors="pt",
                    padding=True, truncation=True, max_length=512,
                )
                inputs = {k: v.to(self._device) for k, v in inputs.items()}
                with self._torch.no_grad():
                    outputs = self._model(**inputs)
                embedding = self._mean_pool(outputs.last_hidden_state, inputs["attention_mask"])
                embedding = self._torch.nn.functional.normalize(embedding, p=2, dim=1)
                return [float(v) for v in embedding[0].cpu().tolist()]
            except Exception:
                return hash_embedding(tokens)
        return hash_embedding(tokens)

    def predict_topic_semantic(self, norm_text: str) -> Optional[Dict[str, float]]:
        if not self.model_active or self._model is None:
            return None

        if not hasattr(self, "_prototype_embs"):
            import numpy as _np
            cache: Dict[str, List] = {}
            for topic, phrases in TOPIC_PROTOTYPES.items():
                embs = []
                for phrase in phrases:
                    toks = phrase.split()
                    raw = self.embed(phrase, toks)
                    if raw:
                        embs.append(_np.array(raw, dtype="float32"))
                cache[topic] = embs
            self._prototype_embs = cache

        import numpy as _np
        review_arr = _np.array(self.embed(norm_text, norm_text.split()), dtype="float32")

        scores: Dict[str, float] = {}
        for topic, embs in self._prototype_embs.items():
            if not embs:
                scores[topic] = 0.0
                continue
            sims = [float(_np.dot(review_arr, e)) for e in embs]
            top_sims = sorted(sims, reverse=True)[:3]
            scores[topic] = float(sum(top_sims) / len(top_sims))

        min_s = min(scores.values())
        scores = {t: s - min_s for t, s in scores.items()}
        total = sum(scores.values()) or 1.0
        return {t: s / total for t, s in scores.items()}


class _DirectSentimentClassifier:
    def __init__(self, model_name: str, device):
        import torch
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        self._torch = torch
        self._tokenizer = AutoTokenizer.from_pretrained(model_name)
        self._model = AutoModelForSequenceClassification.from_pretrained(model_name)
        self._model.to(device)
        self._model.eval()
        self._id2label = {int(k): str(v) for k, v in self._model.config.id2label.items()}
        self._device = device

    def __call__(self, text: str, top_k=None):
        inputs = self._tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with self._torch.no_grad():
            logits = self._model(**inputs).logits
        probs = self._torch.nn.functional.softmax(logits, dim=-1)[0].cpu().tolist()
        results = [{"label": self._id2label[i], "score": float(p)} for i, p in enumerate(probs)]
        if top_k is not None:
            results = sorted(results, key=lambda x: x["score"], reverse=True)[:top_k]
        return results


class _DirectZeroShotClassifier:
    def __init__(self, model_name: str, device):
        import torch
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        self._torch = torch
        self._tokenizer = AutoTokenizer.from_pretrained(model_name)
        self._model = AutoModelForSequenceClassification.from_pretrained(model_name)
        self._model.to(device)
        self._model.eval()
        label2id = {str(v).lower(): int(k) for k, v in self._model.config.id2label.items()}
        self._entailment_id = label2id.get("entailment", 2)
        self._device = device

    def __call__(
        self,
        text: str,
        candidate_labels: List[str],
        hypothesis_template: str = "This example is {}.",
        multi_label: bool = False,
    ) -> Dict[str, Any]:
        scores: List[float] = []
        for label in candidate_labels:
            hypothesis = hypothesis_template.format(label)
            inputs = self._tokenizer(
                text, hypothesis, return_tensors="pt", truncation=True, max_length=512
            )
            inputs = {k: v.to(self._device) for k, v in inputs.items()}
            with self._torch.no_grad():
                logits = self._model(**inputs).logits
            probs = self._torch.nn.functional.softmax(logits, dim=-1)[0].cpu().tolist()
            scores.append(float(probs[self._entailment_id]))
        if not multi_label:
            total = sum(scores) or 1.0
            scores = [s / total for s in scores]
        pairs = sorted(zip(candidate_labels, scores), key=lambda x: x[1], reverse=True)
        sorted_labels, sorted_scores = zip(*pairs) if pairs else ([], [])
        return {"labels": list(sorted_labels), "scores": list(sorted_scores)}


class _PhoBERTTimeClassifier:
    def __init__(self, model_path: str, device):
        try:
            import sentencepiece  # noqa: F401
        except ImportError:
            import subprocess as _sp, sys as _sys
            _sp.run([_sys.executable, "-m", "pip", "install", "-q", "sentencepiece"], check=False)

        import importlib as _il
        _il.invalidate_caches()

        import torch
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        self._torch = torch

        try:
            self._tokenizer = AutoTokenizer.from_pretrained(model_path, use_fast=False)
        except Exception:
            self._tokenizer = AutoTokenizer.from_pretrained("vinai/phobert-base", use_fast=False)

        self._model = AutoModelForSequenceClassification.from_pretrained(model_path)
        self._model.to(device)
        self._model.eval()
        self._id2label = {int(k): str(v) for k, v in self._model.config.id2label.items()}
        self._device = device

    def __call__(self, text: str) -> Dict[str, float]:
        inputs = self._tokenizer(text, return_tensors="pt", truncation=True, max_length=256)
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with self._torch.no_grad():
            logits = self._model(**inputs).logits
        probs = self._torch.nn.functional.softmax(logits, dim=-1)[0].cpu().tolist()
        return {self._id2label[i]: float(p) for i, p in enumerate(probs)}


class TopicE5Classifier:
    def __init__(self, use_pretrained_classifiers: bool, model_name: str):
        self.active = False
        self.error: Optional[str] = None
        self._model = None
        self._tokenizer = None
        self._torch = None
        self._label_embs = None

        if not use_pretrained_classifiers:
            return
        try:
            import torch
            from transformers import AutoTokenizer, AutoModel
            _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            self._tokenizer = AutoTokenizer.from_pretrained(model_name)
            self._model = AutoModel.from_pretrained(model_name)
            self._model.to(_device)
            self._model.eval()
            self._torch = torch
            self._device = _device
            self.active = True
        except Exception as exc:
            self.error = str(exc)

    def _encode(self, texts: List[str]) -> "Any":
        inputs = self._tokenizer(
            texts, padding=True, truncation=True, max_length=512, return_tensors="pt"
        )
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with self._torch.no_grad():
            out = self._model(**inputs)
        mask = inputs["attention_mask"].unsqueeze(-1).float()
        pooled = (out.last_hidden_state * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        return self._torch.nn.functional.normalize(pooled, p=2, dim=1)

    def _get_label_embeddings(self):
        if self._label_embs is None:
            passages = [f"passage: {desc}" for desc in TOPIC_E5_DESCRIPTIONS.values()]
            embs = self._encode(passages)
            self._label_embs = {
                topic: embs[i] for i, topic in enumerate(TOPIC_E5_DESCRIPTIONS)
            }
        return self._label_embs

    def predict(self, raw_text: str) -> Optional[Dict[str, float]]:
        if not self.active or self._model is None:
            return None
        try:
            label_embs = self._get_label_embeddings()
            query_emb = self._encode([f"query: {raw_text}"])[0]
            raw_scores = {
                topic: float(self._torch.dot(query_emb, lemb).cpu())
                for topic, lemb in label_embs.items()
            }
            temperature = 0.07
            exp_scores = {t: math.exp(s / temperature) for t, s in raw_scores.items()}
            total = sum(exp_scores.values()) or 1.0
            return {t: v / total for t, v in exp_scores.items()}
        except Exception:
            return None


class ClassifierProvider:
    def __init__(
        self,
        use_pretrained_classifiers: bool,
        sentiment_model_name: str,
        zeroshot_model_name: str,
        topic_model_name: str,
        confidence_threshold: float,
        ambiguity_margin: float,
        phobert_time_model_path: Optional[str] = None,
    ):
        self.confidence_threshold = confidence_threshold
        self.ambiguity_margin = ambiguity_margin
        self.sentiment_pipeline = None
        self.zeroshot_pipeline = None
        self.topic_classifier: Optional[TopicE5Classifier] = None
        self.phobert_time_classifier: Optional[_PhoBERTTimeClassifier] = None
        self.sentiment_active = False
        self.zeroshot_active = False
        self.phobert_time_active = False
        self.sentiment_error: Optional[str] = None
        self.zeroshot_error: Optional[str] = None
        self.phobert_time_error: Optional[str] = None

        if not use_pretrained_classifiers:
            return

        import torch
        _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

        try:
            self.sentiment_pipeline = _DirectSentimentClassifier(sentiment_model_name, _device)
            self.sentiment_active = True
        except Exception as exc:
            self.sentiment_error = str(exc)

        try:
            self.zeroshot_pipeline = _DirectZeroShotClassifier(zeroshot_model_name, _device)
            self.zeroshot_active = True
        except Exception as exc:
            self.zeroshot_error = str(exc)

        self.topic_classifier = TopicE5Classifier(use_pretrained_classifiers, topic_model_name)

        if phobert_time_model_path:
            try:
                self.phobert_time_classifier = _PhoBERTTimeClassifier(
                    phobert_time_model_path, _device
                )
                self.phobert_time_active = True
            except Exception as exc:
                self.phobert_time_error = str(exc)

    def predict_sentiment(self, text: str) -> Optional[Dict[str, float]]:
        if not self.sentiment_active or self.sentiment_pipeline is None:
            return None
        try:
            raw = self.sentiment_pipeline(text, top_k=None)
            rows = (
                raw[0]
                if (isinstance(raw, list) and raw and isinstance(raw[0], list))
                else (raw if isinstance(raw, list) else [raw])
            )
            label_to_score: Dict[str, float] = {
                str(item.get("label", "")).lower().strip(): float(item.get("score", 0.0))
                for item in rows
            }
            pos = label_to_score.get("positive", 0.0)
            neu = label_to_score.get("neutral", 0.0)
            neg = label_to_score.get("negative", 0.0)
            total = pos + neu + neg
            if total > 0:
                return {"positive": pos / total, "neutral": neu / total, "negative": neg / total}
            star_scores = {
                i: label_to_score.get(f"{i} star{'s' if i > 1 else ''}", 0.0)
                for i in range(1, 6)
            }
            total = sum(star_scores.values())
            if total <= 0.0:
                return None
            negative = (star_scores[1] + star_scores[2]) / total
            neutral = star_scores[3] / total
            positive = (star_scores[4] + star_scores[5]) / total
            return {"positive": positive, "neutral": neutral, "negative": negative}
        except Exception:
            return None

    def predict_topic(self, text: str) -> Optional[Dict[str, float]]:
        if not self.zeroshot_active or self.zeroshot_pipeline is None:
            return None
        core_topics = list(TOPIC_LABEL_MAP_VI.keys())
        labels_vi = [TOPIC_LABEL_MAP_VI[t] for t in core_topics]
        try:
            result = self.zeroshot_pipeline(
                text, labels_vi,
                hypothesis_template="Nội dung chính của đánh giá này là về {}.",
                multi_label=True,
            )
            labels = [str(lbl).strip().lower() for lbl in result.get("labels", [])]
            scores = [float(s) for s in result.get("scores", [])]
            if not labels or not scores:
                return None
            topic_scores: Dict[str, float] = {k: 0.0 for k in core_topics}
            for lbl, score in zip(labels, scores):
                mapped = TOPIC_LABEL_MAP_VI_REVERSE.get(lbl)
                if mapped:
                    topic_scores[mapped] = score
            total = sum(topic_scores.values())
            if total > 0:
                topic_scores = {k: v / total for k, v in topic_scores.items()}
            return topic_scores
        except Exception:
            return None

    def predict_time_label(self, text: str) -> Optional[Tuple[str, Optional[Dict[str, str]]]]:
        if self.phobert_time_active and self.phobert_time_classifier is not None:
            try:
                scores = self.phobert_time_classifier(text)
                sorted_items = sorted(scores.items(), key=lambda x: x[1], reverse=True)
                top_label, top_score = sorted_items[0]
                second_score = sorted_items[1][1] if len(sorted_items) > 1 else 0.0
                margin = top_score - second_score
                if top_score < self.confidence_threshold:
                    return (
                        "amb",
                        {
                            "code": "weak_temporal_signal_phobert",
                            "message": f"PhoBERT không đủ tự tin (score={top_score:.2f}).",
                        },
                    )
                if margin < self.ambiguity_margin:
                    return (
                        "amb",
                        {
                            "code": "conflicting_time_anchor_phobert",
                            "message": f"PhoBERT không phân biệt rõ (margin={margin:.2f}).",
                        },
                    )
                return top_label, None
            except Exception:
                pass

        if not self.zeroshot_active or self.zeroshot_pipeline is None:
            return None

        label_short = "người viết kể về một lần ghé thăm hoặc trải nghiệm riêng lẻ có thể không đại diện"
        label_long  = "người viết nhận xét về đặc điểm thường thấy hoặc tính chất cố hữu của địa điểm"
        try:
            result = self.zeroshot_pipeline(
                text, [label_short, label_long],
                hypothesis_template="Trong đánh giá này, {}.",
                multi_label=False,
            )
            ranked_labels = [str(lbl).strip() for lbl in result.get("labels", [])]
            ranked_scores = [float(s) for s in result.get("scores", [])]
            if len(ranked_labels) < 2 or len(ranked_scores) < 2:
                return None
            top_label = ranked_labels[0]
            top_score = ranked_scores[0]
            margin = ranked_scores[0] - ranked_scores[1]
            mapped = "short-term" if top_label == label_short else "long-term"
            if top_score < self.confidence_threshold:
                return (
                    "amb",
                    {
                        "code": "weak_temporal_signal_model",
                        "message": f"Model không đủ tự tin (score={top_score:.2f}).",
                    },
                )
            if margin < self.ambiguity_margin:
                return (
                    "amb",
                    {
                        "code": "conflicting_time_anchor_model",
                        "message": f"Model không thể phân biệt rõ (margin={margin:.2f}).",
                    },
                )
            return mapped, None
        except Exception:
            return None


# ============================================================================
# PIPELINE
# ============================================================================

class ReviewFilteringPipeline:
    def __init__(self, config: PipelineConfig):
        self.config = config
        self.embedding_provider = EmbeddingProvider(
            use_pretrained_model=config.use_pretrained_model,
            model_name=config.embedding_model_name,
        )
        self.classifier_provider = ClassifierProvider(
            use_pretrained_classifiers=config.use_pretrained_classifiers,
            sentiment_model_name=config.sentiment_model_name,
            zeroshot_model_name=config.zeroshot_model_name,
            topic_model_name=config.topic_model_name,
            confidence_threshold=config.classifier_confidence_threshold,
            ambiguity_margin=config.classifier_ambiguity_margin,
            phobert_time_model_path=config.phobert_time_model_path,
        )

    def run(
        self, reviews: List[Dict[str, Any]]
    ) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]]]:
        contents = self.algorithm_1_classify_reviews(reviews)
        conflicts, algorithm2_meta = self.algorithm_2_detect_conflicts(contents)
        time_result = self.algorithm_small_time_management(contents, conflicts, algorithm2_meta)

        self._write_json("algorithm1_review_contents.json", contents)
        self._write_json("algorithm2_review_conflicts.json", conflicts)
        self._write_json("algorithm3_time_management.json", time_result)
        self._write_json("algorithm3_long_term_summaries.json", time_result["long_term_summaries"])

        report = {
            "input_label": self.config.input_label,
            "generated_at": to_iso(self.config.now),
            "total_reviews": len(reviews),
            "algorithm1_total_contents": len(contents),
            "algorithm2_total_conflicts": len(conflicts),
            "algorithm3_total_long_term_summaries": len(time_result["long_term_summaries"]),
            "algorithm3_total_hidden_reviews": len(time_result["hidden_review_ids"]),
            "embedding_model": {
                "requested": self.config.embedding_model_name,
                "active": self.embedding_provider.model_active,
                "fallback_reason": self.embedding_provider.model_error,
            },
            "classifier_models": {
                "enabled": self.config.use_pretrained_classifiers,
                "sentiment": {
                    "requested": self.config.sentiment_model_name,
                    "active": self.classifier_provider.sentiment_active,
                    "fallback_reason": self.classifier_provider.sentiment_error,
                },
                "zeroshot": {
                    "requested": self.config.zeroshot_model_name,
                    "active": self.classifier_provider.zeroshot_active,
                    "fallback_reason": self.classifier_provider.zeroshot_error,
                },
                "phobert_time": {
                    "requested": self.config.phobert_time_model_path,
                    "active": self.classifier_provider.phobert_time_active,
                    "fallback_reason": self.classifier_provider.phobert_time_error,
                },
            },
            "output_dir": str(self.config.output_dir),
            "output_files": [
                "algorithm1_review_contents.json",
                "algorithm2_review_conflicts.json",
                "algorithm3_time_management.json",
                "algorithm3_long_term_summaries.json",
                "run_report.json",
            ],
        }
        self._write_json("run_report.json", report)
        return report, contents, conflicts

    def _write_json(self, file_name: str, payload: Any) -> None:
        self.config.output_dir.mkdir(parents=True, exist_ok=True)
        output_path = self.config.output_dir / file_name
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

    def _resolve_review_created_at(self, review: Dict[str, Any], idx: int) -> datetime:
        raw = review.get("created_at")
        if isinstance(raw, str) and raw.strip():
            parsed = parse_iso(raw.strip())
            if parsed is not None:
                return parsed
        return self.config.now + timedelta(seconds=idx)

    # -------------------------------------------------------------------------
    # Algorithm 1
    # -------------------------------------------------------------------------

    def algorithm_1_classify_reviews(self, reviews: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        outputs: List[Dict[str, Any]] = []
        for idx, review in enumerate(reviews):
            try:
                if review.get("processing_status") != "pending":
                    continue

                raw_text = str(review.get("content", review.get("text_vi", "")))
                norm_text = normalize_text(raw_text)
                tokens = simple_tokens(norm_text)
                embedding = self.embedding_provider.embed(norm_text, tokens)
                review_created_at = self._resolve_review_created_at(review, idx)

                topic, topic_scores, topic_source = self._classify_topic(raw_text, norm_text)
                time_label, time_error_info = self._classify_time_label(raw_text, norm_text, topic)
                stars_raw = review.get("stars")
                base_sentiment = self._classify_sentiment(raw_text, norm_text, stars_raw)
                sentiment_scores = self._build_topic_sentiment_scores(raw_text, base_sentiment, topic_scores)
                expiration_dt = self._assign_ttl(time_label, topic, review_created_at)

                place_id = (
                    review.get("place_id")
                    or review.get("business_id")
                    or self.config.input_label
                )

                outputs.append({
                    "id": review.get("content_db_id") or str(uuid.uuid4()),
                    "review_id": review.get("review_id"),
                    "place_id": place_id,
                    "user_id": review.get("user_id"),
                    "content": raw_text,
                    "stars": stars_raw,
                    "created_at": to_iso(review_created_at),
                    "processing_status": "processed",
                    "time_label": time_label,
                    "expiration_date": to_iso(expiration_dt),
                    "main_topic": topic,
                    "topic_source": topic_source,
                    "topic_scores": ensure_float_dict(topic_scores),
                    "sentiment_scores": ensure_nested_float_dict(sentiment_scores),
                    "embedding": embedding,
                    "error_info": time_error_info,
                    "has_conflict": False,
                    "is_temporary": time_label == "short-term",
                })
            except Exception as exc:
                review_created_at = self._resolve_review_created_at(review, idx)
                outputs.append({
                    "id": review.get("content_db_id") or str(uuid.uuid4()),
                    "review_id": review.get("review_id"),
                    "place_id": review.get("place_id") or self.config.input_label,
                    "user_id": review.get("user_id"),
                    "content": str(review.get("content", "")),
                    "stars": review.get("stars"),
                    "created_at": to_iso(review_created_at),
                    "processing_status": "processed",
                    "time_label": "amb",
                    "expiration_date": None,
                    "main_topic": "other",
                    "topic_scores": {**{k: 0.0 for k in TOPIC_KEYWORDS}, "other": 1.0},
                    "sentiment_scores": {"other": {"positive": 0.0, "neutral": 1.0, "negative": 0.0}},
                    "embedding": [0.0] * 64,
                    "error_info": {"code": "processing_exception", "message": str(exc)},
                    "has_conflict": False,
                    "is_temporary": False,
                })
        return outputs

    def _classify_topic(self, raw_text: str, norm_text: str) -> Tuple[str, Dict[str, float], str]:
        keyword_raw: Dict[str, float] = {
            topic: float(count_keyword_hits(norm_text, keywords))
            for topic, keywords in TOPIC_KEYWORDS.items()
        }
        keyword_total = sum(keyword_raw.values())
        keyword_norm = {
            t: (s / keyword_total if keyword_total else 0.0)
            for t, s in keyword_raw.items()
        }

        tc = self.classifier_provider.topic_classifier
        e5_scores = tc.predict(raw_text) if (tc and tc.active) else None

        if e5_scores is not None:
            e5_other = float(e5_scores.get("other", 0.0))
            proto_scores = self.embedding_provider.predict_topic_semantic(norm_text)

            combined: Dict[str, float] = {}
            if proto_scores is not None:
                for topic in TOPIC_KEYWORDS:
                    combined[topic] = (
                        0.70 * float(e5_scores.get(topic, 0.0))
                        + 0.20 * float(proto_scores.get(topic, 0.0))
                        + 0.10 * keyword_norm.get(topic, 0.0)
                    )
                source = "e5+proto"
            else:
                for topic in TOPIC_KEYWORDS:
                    combined[topic] = (
                        0.85 * float(e5_scores.get(topic, 0.0))
                        + 0.15 * keyword_norm.get(topic, 0.0)
                    )
                source = "e5"

            best_combined = max(combined.values()) if combined else 0.0

            if e5_other > 0.35 or best_combined < self.config.topic_other_threshold:
                return "other", {**{k: 0.0 for k in TOPIC_KEYWORDS}, "other": 1.0}, source

            total = sum(combined.values()) or 1.0
            normalized = {t: s / total for t, s in combined.items()}
            normalized["other"] = 0.0
            best_topic = max(normalized.items(), key=lambda x: x[1])[0]
            return best_topic, ensure_float_dict(normalized), source

        if keyword_total == 0.0:
            return "other", {**{k: 0.0 for k in TOPIC_KEYWORDS}, "other": 1.0}, "keyword"
        score_payload = {k: v / keyword_total for k, v in keyword_raw.items()}
        score_payload["other"] = 0.0
        best_topic = max(score_payload.items(), key=lambda x: x[1])[0]
        return best_topic, score_payload, "keyword"

    def _classify_time_label_rule(
        self, norm_text: str, main_topic: str
    ) -> Tuple[str, Optional[Dict[str, str]]]:
        strong = count_keyword_hits(norm_text, STRONG_SHORT_TIME_CUES)
        weak   = count_keyword_hits(norm_text, WEAK_SHORT_TIME_CUES)
        long_hits = count_keyword_hits(norm_text, LONG_TIME_CUES)

        weak      = max(0, weak      - count_keyword_hits(norm_text, FALSE_POSITIVE_WEAK_CUES))
        long_hits = max(0, long_hits - count_keyword_hits(norm_text, FALSE_POSITIVE_LONG_CUES))
        long_hits += count_habitual_pattern_hits(norm_text)

        if strong > 0 and long_hits == 0:
            return "short-term", None
        if strong > 0 and long_hits > 0:
            return (
                "amb",
                {"code": "mixed_temporal_signals",
                 "message": "Từ chỉ thời điểm cụ thể và tín hiệu dài hạn cùng xuất hiện."},
            )
        if main_topic in TRANSIENT_TOPICS and weak > 0:
            return "short-term", None
        if weak >= 2:
            return "short-term", None
        if long_hits > 0 and weak == 0:
            return "long-term", None
        if strong == 0 and weak == 0 and long_hits == 0:
            return "long-term", None
        if weak > 0 and long_hits > 0:
            return (
                "amb",
                {"code": "conflicting_time_anchor",
                 "message": "Tín hiệu ngắn hạn và dài hạn xung đột."},
            )
        return (
            "amb",
            {"code": "weak_temporal_signal",
             "message": "Tín hiệu thời gian yếu, không đủ để phân loại."},
        )

    def _classify_time_label(
        self, raw_text: str, norm_text: str, main_topic: str
    ) -> Tuple[str, Optional[Dict[str, str]]]:
        rule_label, rule_error = self._classify_time_label_rule(norm_text, main_topic)
        if rule_label != "amb":
            return rule_label, None

        model_result = self.classifier_provider.predict_time_label(raw_text)
        if model_result is not None:
            model_label, model_error = model_result
            if model_label != "amb":
                return model_label, None
            return "amb", model_error or rule_error

        return "amb", rule_error

    def _classify_sentiment(self, raw_text: str, norm_text: str, stars) -> Dict[str, float]:
        model_result = self.classifier_provider.predict_sentiment(raw_text)
        if model_result is not None:
            return model_result

        stars_int = int(stars) if stars is not None else None
        if stars_int is None:
            base_pos, base_neu, base_neg = 0.33, 0.34, 0.33
        elif stars_int >= 4:
            base_pos, base_neu, base_neg = 0.70, 0.20, 0.10
        elif stars_int <= 2:
            base_pos, base_neu, base_neg = 0.10, 0.20, 0.70
        else:
            base_pos, base_neu, base_neg = 0.25, 0.50, 0.25

        eff_pos, eff_neg = count_sentiment_hits_negation_aware(
            norm_text, POSITIVE_WORDS, NEGATIVE_WORDS
        )
        keyword_total = eff_pos + eff_neg

        if keyword_total > 0:
            kw_ratio = (eff_pos - eff_neg) / keyword_total
            if kw_ratio > 0.3:
                pos = min(0.90, base_pos + 0.15)
                neg = max(0.02, base_neg - 0.10)
            elif kw_ratio < -0.3:
                pos = max(0.02, base_pos - 0.10)
                neg = min(0.90, base_neg + 0.15)
            else:
                pos, neg = base_pos, base_neg
            neu = max(0.02, 1.0 - pos - neg)
            total = pos + neu + neg
            return {"positive": pos / total, "neutral": neu / total, "negative": neg / total}

        return {"positive": base_pos, "neutral": base_neu, "negative": base_neg}

    def _split_sentences(self, raw_text: str) -> List[str]:
        text = raw_text
        for conj in ["tuy nhiên", "tuy nhien", "mặc dù", "mac du", "nhưng", "nhung"]:
            text = re.sub(r'(?i)\b' + re.escape(conj) + r'\b', '\x00', text)
        text = re.sub(r'(?i)\bsong\b(?=\s+\S)', '\x00', text)
        parts = re.split(r'[.!?;,\x00]+', text)
        return [p.strip() for p in parts if p and len(p.strip()) > 5]

    def _build_topic_sentiment_scores(
        self,
        raw_text: str,
        base_sentiment: Dict[str, float],
        topic_scores: Dict[str, float],
    ) -> Dict[str, Dict[str, float]]:
        sentences = self._split_sentences(raw_text)
        if len(sentences) < 2:
            return build_topic_sentiment_scores(base_sentiment, topic_scores)

        tc = self.classifier_provider.topic_classifier
        sent_data: List[Tuple[Dict[str, float], Dict[str, float]]] = []
        for sent in sentences:
            sent_topic: Dict[str, float] = (
                (tc.predict(sent) or {}) if (tc and tc.active) else {}
            )
            sent_sentiment = self.classifier_provider.predict_sentiment(sent) or base_sentiment
            sent_data.append((sent_topic, sent_sentiment))

        result: Dict[str, Dict[str, float]] = {}
        for topic, ts in topic_scores.items():
            topic_score = float(ts)
            total_weight = sum(st.get(topic, 0.0) for st, _ in sent_data)
            if total_weight < 1e-9:
                if topic_score <= 0.0:
                    continue
                result[topic] = {
                    "positive": float(base_sentiment["positive"] * topic_score),
                    "neutral":  float(base_sentiment["neutral"]  * topic_score),
                    "negative": float(base_sentiment["negative"] * topic_score),
                }
                continue
            pos = sum(ss["positive"] * st.get(topic, 0.0) for st, ss in sent_data) / total_weight
            neu = sum(ss["neutral"]  * st.get(topic, 0.0) for st, ss in sent_data) / total_weight
            neg = sum(ss["negative"] * st.get(topic, 0.0) for st, ss in sent_data) / total_weight
            result[topic] = {
                "positive": float(pos * topic_score),
                "neutral":  float(neu * topic_score),
                "negative": float(neg * topic_score),
            }
        if not result:
            result["other"] = {"positive": 0.0, "neutral": 1.0, "negative": 0.0}
        return result

    def _assign_ttl(self, time_label: str, topic: str, base_time: datetime) -> Optional[datetime]:
        if time_label != "short-term":
            return None
        ttl_hours = TTL_HOURS_BY_TOPIC.get(topic, 48)
        return base_time + timedelta(hours=ttl_hours)

    # -------------------------------------------------------------------------
    # Algorithm 2
    # -------------------------------------------------------------------------

    def algorithm_2_detect_conflicts(
        self, contents: List[Dict[str, Any]]
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        conflicts: List[Dict[str, Any]] = []
        review_news = [c for c in contents if c.get("time_label") == "short-term"]
        review_olds = [c for c in contents if c.get("time_label") == "long-term"]

        olds_by_group: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
        for old in review_olds:
            key = (str(old.get("place_id")), str(old.get("main_topic")))
            olds_by_group[key].append(old)

        total_pairs_examined = 0
        for content in sorted(review_news, key=lambda c: c["created_at"]):
            key = (str(content.get("place_id")), str(content.get("main_topic")))
            raw_candidates = [
                old for old in olds_by_group.get(key, [])
                if parse_iso(old.get("created_at"))
                and parse_iso(old["created_at"]) <= parse_iso(content["created_at"])
            ]

            ttl_hours = TTL_HOURS_BY_TOPIC.get(content.get("main_topic"), 72)
            lookback_hours = ttl_hours * max(1, self.config.old_lookback_multiplier)
            ref_time = parse_iso(content["created_at"])
            if ref_time is not None:
                boundary = ref_time - timedelta(hours=lookback_hours)
                raw_candidates = [
                    old for old in raw_candidates
                    if parse_iso(old["created_at"])
                    and parse_iso(old["created_at"]) >= boundary
                ]

            candidates = self._select_algorithm2_candidates(content, raw_candidates)
            total_pairs_examined += len(candidates)

            for old in candidates:
                sim = cosine_similarity(content["embedding"], old["embedding"])
                if sim < 0.5:
                    continue

                conflict_topic = content["main_topic"]
                topic_conf = (
                    content["topic_scores"].get(conflict_topic, 0.3)
                    + old["topic_scores"].get(conflict_topic, 0.3)
                ) / 2.0
                adjusted_sim = sim * (0.5 + 0.5 * topic_conf)
                nli_label, p_contra = self._infer_nli(content, old, sim, conflict_topic)
                sentiment_gap = self._sentiment_distance_for_topic(content, old, conflict_topic)
                conflict_score = 0.45 * adjusted_sim + 0.25 * sentiment_gap + 0.30 * p_contra

                if sim >= 0.8 or (sim >= 0.5 and nli_label == "contradiction"):
                    if conflict_score >= 0.65:
                        conflicts.append({
                            "id": str(uuid.uuid4()),
                            "new_content_id": content["id"],
                            "old_content_id": old["id"],
                            "conflict_score": float(round(conflict_score, 4)),
                            "conflict_topic": content["main_topic"],
                            "created_at": content["created_at"],
                        })
                        content["has_conflict"] = True
                        old["has_conflict"] = True

        meta = {
            "review_new_count": len(review_news),
            "review_old_count": len(review_olds),
            "total_pairs_examined": total_pairs_examined,
            "candidate_mode": self.config.candidate_mode,
            "top_k": self.config.top_k,
            "lookback_multiplier": self.config.old_lookback_multiplier,
        }
        return conflicts, meta

    def _select_algorithm2_candidates(
        self,
        review_new: Dict[str, Any],
        raw_candidates: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        if self.config.candidate_mode == "all":
            return raw_candidates

        ref_time = parse_iso(review_new.get("created_at"))

        def candidate_rank(old: Dict[str, Any]) -> Tuple[float, float]:
            old_time = parse_iso(old.get("created_at"))
            age_hours = 0.0
            if ref_time is not None and old_time is not None:
                age_hours = max(0.0, (ref_time - old_time).total_seconds() / 3600.0)
            sim = cosine_similarity(review_new["embedding"], old["embedding"])
            return (-sim, age_hours)

        ranked = sorted(raw_candidates, key=candidate_rank)
        return ranked[: max(1, self.config.top_k)]

    def _infer_nli(
        self,
        a: Dict[str, Any],
        b: Dict[str, Any],
        similarity: float,
        conflict_topic: Optional[str] = None,
    ) -> Tuple[str, float]:
        def _topic_polarity(review: Dict[str, Any]) -> float:
            if conflict_topic:
                t = review["sentiment_scores"].get(conflict_topic, {})
                tot = t.get("positive", 0.0) + t.get("neutral", 0.0) + t.get("negative", 0.0)
                if tot > 0:
                    return (t.get("positive", 0.0) - t.get("negative", 0.0)) / tot
            flat = self._flatten_sentiment(review["sentiment_scores"])
            return flat["positive"] - flat["negative"]

        a_pol = _topic_polarity(a)
        b_pol = _topic_polarity(b)
        pol_product = a_pol * b_pol
        pol_distance = abs(a_pol - b_pol)

        if pol_product < 0:
            p_contra = 0.40 + 0.45 * (pol_distance / 2.0)
            return "contradiction", round(p_contra, 3)
        elif pol_product > 0:
            p_contra = max(0.02, 0.20 - 0.15 * similarity)
            return "entailment", round(p_contra, 3)
        else:
            p_contra = 0.15 + 0.15 * (pol_distance / 2.0)
            return "neutral", round(p_contra, 3)

    def _flatten_sentiment(self, sentiment: Dict[str, Any]) -> Dict[str, float]:
        if "positive" in sentiment and "neutral" in sentiment and "negative" in sentiment:
            return {
                "positive": float(sentiment["positive"]),
                "neutral":  float(sentiment["neutral"]),
                "negative": float(sentiment["negative"]),
            }
        pos = neg = neu = 0.0
        for item in sentiment.values():
            if not isinstance(item, dict):
                continue
            pos += float(item.get("positive", 0.0))
            neu += float(item.get("neutral", 0.0))
            neg += float(item.get("negative", 0.0))
        total = pos + neu + neg
        if total <= 0.0:
            return {"positive": 0.0, "neutral": 1.0, "negative": 0.0}
        return {"positive": pos / total, "neutral": neu / total, "negative": neg / total}

    def _sentiment_distance_for_topic(
        self, a: Dict[str, Any], b: Dict[str, Any], topic: str
    ) -> float:
        def _extract_normalized(review: Dict[str, Any]) -> Dict[str, float]:
            t = review["sentiment_scores"].get(topic, {})
            tot = t.get("positive", 0.0) + t.get("neutral", 0.0) + t.get("negative", 0.0)
            if tot <= 0:
                return self._flatten_sentiment(review["sentiment_scores"])
            return {
                "positive": t.get("positive", 0.0) / tot,
                "neutral":  t.get("neutral",  0.0) / tot,
                "negative": t.get("negative", 0.0) / tot,
            }

        a_sent = _extract_normalized(a)
        b_sent = _extract_normalized(b)
        distance = (
            abs(a_sent["positive"] - b_sent["positive"])
            + abs(a_sent["neutral"]  - b_sent["neutral"])
            + abs(a_sent["negative"] - b_sent["negative"])
        ) / 3.0
        return float(min(1.0, max(0.0, distance)))

    # -------------------------------------------------------------------------
    # Algorithm 3 (time management)
    # -------------------------------------------------------------------------

    def algorithm_small_time_management(
        self,
        contents: List[Dict[str, Any]],
        conflicts: List[Dict[str, Any]],
        algorithm2_meta: Dict[str, Any],
    ) -> Dict[str, Any]:
        now = self.config.now
        hidden_review_ids: List[str] = []
        notifications: List[Dict[str, Any]] = []

        for content in contents:
            expiration = parse_iso(content.get("expiration_date"))
            if content.get("is_temporary") and expiration and expiration < now:
                hidden_review_ids.append(content["id"])
                notifications.append({
                    "review_content_id": content["id"],
                    "review_id": content.get("review_id"),
                    "message": "Review ngắn hạn đã hết hạn và được ẩn khỏi đánh giá tổng thể.",
                    "notified_at": to_iso(now),
                })

        conflict_ids = (
            {c["new_content_id"] for c in conflicts}
            | {c["old_content_id"] for c in conflicts}
        )
        long_term_summaries, promoted_ids = self._derive_long_term_summaries(contents, conflict_ids)

        return {
            "generated_at": to_iso(now),
            "hidden_review_ids": hidden_review_ids,
            "notifications": notifications,
            "long_term_summaries": long_term_summaries,
            "promoted_review_content_ids": promoted_ids,
            "algorithm2_input_summary": algorithm2_meta,
            "promotion_mode": self.config.promotion_mode,
        }

    def _derive_long_term_summaries(
        self,
        contents: List[Dict[str, Any]],
        conflict_ids: set,
    ) -> Tuple[List[Dict[str, Any]], List[str]]:
        by_group: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
        for content in contents:
            if content.get("time_label") != "short-term":
                continue
            key = (str(content.get("place_id")), str(content.get("main_topic")))
            by_group[key].append(content)

        summaries: List[Dict[str, Any]] = []
        promoted_content_ids: List[str] = []

        for (place_id, topic), group_items in by_group.items():
            rule = OBSERVATION_RULES.get(topic, OBSERVATION_RULES["other"])
            window_days  = int(rule["window_days"])
            threshold    = int(rule["threshold"])
            sim_threshold = float(rule["sim_threshold"])
            window_start = self.config.now - timedelta(days=window_days)

            candidates = [
                item for item in group_items
                if parse_iso(item["created_at"])
                and parse_iso(item["created_at"]) >= window_start
                and item["id"] not in conflict_ids
            ]

            if len(candidates) < threshold:
                continue

            clusters: List[List[Dict[str, Any]]] = []
            for item in sorted(candidates, key=lambda x: x["created_at"]):
                placed = False
                for cluster in clusters:
                    if cosine_similarity(item["embedding"], cluster[0]["embedding"]) >= sim_threshold:
                        cluster.append(item)
                        placed = True
                        break
                if not placed:
                    clusters.append([item])

            for cluster in clusters:
                if len(cluster) < threshold:
                    continue
                representative = max(
                    cluster,
                    key=lambda x: (x.get("stars", 0) or 0, len(x.get("content", "")))
                )
                sentiment_counter = Counter(
                    self._sentiment_label(item["sentiment_scores"]) for item in cluster
                )
                summaries.append({
                    "id": str(uuid.uuid4()),
                    "place_id": place_id,
                    "topic": topic,
                    "representative_review_id": representative["review_id"],
                    "representative_review_content_id": representative["id"],
                    "representative_text": representative["content"],
                    "derived_from_review_ids": [item["review_id"] for item in cluster],
                    "derived_from_review_content_ids": [item["id"] for item in cluster],
                    "observation_window_days": window_days,
                    "support_count": len(cluster),
                    "sentiment_distribution": {
                        "positive": int(sentiment_counter.get("positive", 0)),
                        "neutral":  int(sentiment_counter.get("neutral",  0)),
                        "negative": int(sentiment_counter.get("negative", 0)),
                    },
                    "long_term_derived_at": to_iso(self.config.now),
                })
                targets = cluster if self.config.promotion_mode == "all" else [representative]
                for target in targets:
                    target["time_label"]    = "long-term"
                    target["is_temporary"]  = False
                    target["expiration_date"] = None
                    promoted_content_ids.append(target["id"])

        return summaries, promoted_content_ids

    def _sentiment_label(self, sentiment: Dict[str, Any]) -> str:
        flat = self._flatten_sentiment(sentiment)
        if flat["positive"] >= flat["neutral"] and flat["positive"] >= flat["negative"]:
            return "positive"
        if flat["negative"] >= flat["neutral"] and flat["negative"] >= flat["positive"]:
            return "negative"
        return "neutral"


# ============================================================================
# SUPABASE INTEGRATION
# ============================================================================

def _create_supabase_client():
    try:
        from supabase import create_client
    except ImportError:
        raise ImportError("supabase-py not installed. Run: pip install supabase")

    url = os.environ.get("SUPABASE_URL", "").strip()
    key = os.environ.get("SUPABASE_KEY", "").strip()

    if not url or not key:
        raise ValueError("SUPABASE_URL and SUPABASE_KEY must be set in .env")

    return create_client(url, key)


def fetch_pending_reviews(client, limit: Optional[int] = None) -> List[Dict[str, Any]]:
    query = (
        client
        .schema("review_ai")
        .from_("review_contents")
        .select(
            "id, content, processing_status, review_id, "
            "reviews!inner(id, place_id, created_at, rating, status)"
        )
        .eq("processing_status", "pending")
        .eq("reviews.status", "approved")
    )
    if limit:
        query = query.limit(limit)

    result = query.execute()

    reviews: List[Dict[str, Any]] = []
    for row in result.data or []:
        review_info = row.get("reviews") or {}
        if isinstance(review_info, list):
            review_info = review_info[0] if review_info else {}

        reviews.append({
            "content_db_id":     row.get("id"),
            "review_id":         review_info.get("id"),
            "place_id":          review_info.get("place_id"),
            "created_at":        review_info.get("created_at"),
            "content":           row.get("content", ""),
            "processing_status": row.get("processing_status", "pending"),
            "user_id":           None,
            "stars":             review_info.get("rating"),
        })

    return reviews


def mark_reviews_processed(client, review_ids: List[str], status: str = "processed") -> None:
    if not review_ids:
        return
    (
        client
        .schema("review_ai")
        .from_("review_contents")
        .update({"processing_status": status})
        .in_("review_id", review_ids)
        .execute()
    )


def _to_pgvector(embedding: Optional[List[float]]) -> Optional[str]:
    if embedding is None:
        return None
    return "[" + ",".join(f"{v:.8f}" for v in embedding) + "]"


_DB_BATCH = 50


def write_contents_to_db(client, contents: List[Dict[str, Any]]) -> None:
    if not contents:
        return

    rows = []
    for c in contents:
        rows.append({
            "id":                c["id"],
            "processing_status": c.get("processing_status", "processed"),
            "time_label":        c.get("time_label"),
            "expiration_date":   c.get("expiration_date"),
            "main_topic":        c.get("main_topic"),
            "topic_scores":      c.get("topic_scores"),
            "sentiment_scores":  c.get("sentiment_scores"),
            "embedding":         _to_pgvector(c.get("embedding")),
            "error_info":        c.get("error_info"),
            "has_conflict":      c.get("has_conflict", False),
            "is_temporary":      c.get("is_temporary", False),
        })

    for i in range(0, len(rows), _DB_BATCH):
        chunk = rows[i : i + _DB_BATCH]
        (
            client
            .schema("review_ai")
            .from_("review_contents")
            .upsert(chunk, on_conflict="id")
            .execute()
        )


def write_conflicts_to_db(client, conflicts: List[Dict[str, Any]]) -> None:
    if not conflicts:
        return

    rows = [
        {
            "id":              c["id"],
            "new_content_id":  c["new_content_id"],
            "old_content_id":  c["old_content_id"],
            "conflict_score":  c["conflict_score"],
            "conflict_topic":  c["conflict_topic"],
            "created_at":      c["created_at"],
        }
        for c in conflicts
    ]

    for i in range(0, len(rows), _DB_BATCH):
        chunk = rows[i : i + _DB_BATCH]
        (
            client
            .schema("review_ai")
            .from_("review_conflicts")
            .upsert(chunk, on_conflict="id")
            .execute()
        )
