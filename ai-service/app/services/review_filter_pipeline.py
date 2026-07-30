# -*- coding: utf-8 -*-
"""Local review filtering pipeline backed by Supabase.

Configuration is loaded from .env. No JSON or CSV output files are created.
"""

import os
import sys
sys.setrecursionlimit(5000)

def _from_pretrained_safe(auto_cls, model_name_or_path, **kwargs):
    """Load a Hugging Face model/tokenizer using the installed local runtime."""
    return auto_cls.from_pretrained(model_name_or_path, **kwargs)

import json
import math
import re
import unicodedata
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    from supabase import create_client
except ImportError:
    create_client = None


TTL_HOURS_BY_TOPIC: Dict[str, int] = {
    "traffic": 24,
    "weather": 24,
    "crowd": 48,
    "service": 72,
    "price": 72,
    "infra": 168,
    "cleanliness": 168,
    "food": 168,
    "atmosphere": 720,   # cảnh quan/không khí rất ổn định, ít thay đổi
    "activity":   168,
    "other": 48,   # chất lượng hoạt động tương đối ổn định
}


OBSERVATION_RULES: Dict[str, Any] = {
    "traffic": {"window_days": 7,  "threshold": 3, "sim_threshold": 0.62},
    "crowd":   {"window_days": 14, "threshold": 3, "sim_threshold": 0.62},
    "service": {"window_days": 14, "threshold": 3, "sim_threshold": 0.62},
    "infra":   {"window_days": 30, "threshold": 2, "sim_threshold": 0.58},
    "cleanliness": {"window_days": 30, "threshold": 3, "sim_threshold": 0.62},
    "weather": {"window_days": 7,  "threshold": 3, "sim_threshold": 0.62},
    "price":   {"window_days": 14, "threshold": 3, "sim_threshold": 0.62},
    "food":    {"window_days": 30, "threshold": 3, "sim_threshold": 0.62},
    "atmosphere": {"window_days": 90,  "threshold": 2, "sim_threshold": 0.60},
    "activity":   {"window_days": 30,  "threshold": 3, "sim_threshold": 0.62},
    "other":      {"window_days": 14,  "threshold": 3, "sim_threshold": 0.65},
}

# A promoted short-term cluster hides conflicting long-term reviews only when
# the repeated new evidence is stronger than the minimum promotion condition.
REPLACEMENT_EXTRA_SUPPORT = 1
REPLACEMENT_CONFLICT_SCORE_THRESHOLD = 0.75
REPLACEMENT_SENTIMENT_CONSISTENCY_THRESHOLD = 0.80
REPLACEMENT_COHESION_MARGIN = 0.03

# Algorithm 2 should not miss obvious same-topic contradictions just because
# the sentiment model assigns both sides the same coarse polarity.
ALGORITHM2_MIN_SIMILARITY = 0.50
ALGORITHM2_STRONG_POLARITY_GAP = 0.45
ALGORITHM2_STRONG_CONTRADICTION_THRESHOLD = 0.62
ALGORITHM2_LEXICAL_POLARITY_MIN = 0.25
ALGORITHM2_ASPECT_CONTRADICTION_MIN_SIMILARITY = 0.35
ALGORITHM2_ASPECT_CONTRADICTION_THRESHOLD = 0.50
ALGORITHM2_ASPECT_TOPIC_FOCUS_MIN = 0.25
ALGORITHM2_ASPECT_POLARITY_GAP_MIN = 0.20

ALGORITHM2_LOOKBACK_MULTIPLIER_BY_TOPIC: Dict[str, int] = {
    "traffic": 3,
    "weather": 3,
    "crowd": 6,
    "service": 6,
    "price": 6,
    "food": 6,
    "cleanliness": 6,
    "infra": 12,
    "atmosphere": 12,
    "activity": 12,
    "other": 6,
}

TOPIC_CONTRAST_PHRASES: Dict[str, Dict[str, List[str]]] = {
    "service": {
        "positive": ["phuc vu nhanh", "nhan vien nhanh", "nhanh hon", "kha nhanh", "chu dong", "ho tro", "nhiet tinh", "tu van ro", "hai long", "phuc vu tot", "dich vu tot", "cai thien", "on", "rat tot", "khong phai cho qua lau", "khong phai doi lau"],
        "negative": ["phuc vu cham", "nhan vien cham", "cham tre", "cho lau", "doi lau", "phai cho", "thieu chu dong", "chua nhiet tinh", "khong nhiet tinh", "ho tro cham", "giai quyet cham", "thai do te", "phuc vu kem", "dich vu kem"],
    },
    "cleanliness": {"positive": ["sach se", "sach", "don dep", "gon gang", "ve sinh tot"], "negative": ["ban", "khong sach", "mat ve sinh", "mui hoi", "rac", "am moc"]},
    "crowd": {"positive": ["vang ve", "it khach", "khong dong", "khong phai doi", "thoai mai"], "negative": ["dong duc", "qua dong", "xep hang", "cho doi", "chen chuc", "qua tai"]},
    "traffic": {"positive": ["de di", "de tim", "thuan tien", "thong thoang", "bai do xe rong"], "negative": ["ket xe", "tac duong", "kho di", "kho tim", "duong xau", "khong co cho dau"]},
    "infra": {"positive": ["moi", "hien dai", "tot", "on dinh", "day du", "nang cap xong"], "negative": ["xuong cap", "hong", "dang sua", "dang thi cong", "cu ky", "can nang cap"]},
    "price": {"positive": ["gia hop ly", "gia re", "dang tien", "xung dang", "khong qua dat"], "negative": ["qua dat", "dat qua", "gia cao", "khong xung dang", "mat tien"]},
    "food": {"positive": ["ngon", "rat ngon", "vua mieng", "tuoi", "dam da", "thom"], "negative": ["khong ngon", "nhat", "te", "do", "nguoi", "that vong"]},
    "weather": {"positive": ["troi dep", "mat me", "thoi tiet dep", "de chiu"], "negative": ["mua lon", "nang nong", "ngap", "gio lon", "bao", "oi buc"]},
}

# Transient topics: a single weak time signal is enough to classify as short-term.
TRANSIENT_TOPICS = {"traffic", "weather", "crowd"}

TOPIC_KEYWORDS: Dict[str, List[str]] = {
    "traffic": [
        "ket xe", "giao thong", "duong pho", "di chuyen", "un tac", "tai nan",
        "cam duong", "ach tac", "tac duong", "ket duong", "dau xe", "bai do xe",
        "bai xe", "xe may", "o to", "xe bus", "phuong tien", "tac nghen",
        "vong xuyen", "hanh trinh", "di lai",
        "duong vao", "cung duong", "mo duong", "lan duong", "duong nho",
        "di bo", "gui xe", "giu xe", "phi gui xe", "bai giu xe",
        "oto", "xe om", "grab", "taxi", "xe dap",
        "ket cung", "nhich tung chut", "xe ra vao", "dung giua duong",
    ],
    "weather": [
        "thoi tiet", "troi mua", "mua lon", "nang nong", "bao lon", "gio lon",
        "nong buc", "lanh gia", "am uot", "ngap nuoc", "lu lut",
        "kho han", "troi nong", "troi lanh", "troi nang", "troi ngap", "song gio",
        "thoi tiet xau", "troi dep", "troi lanh",
        "nang gay", "nang chieu", "mua phun", "se lanh", "mat me",
        "gio manh", "bao to", "con bao", "troi u am", "troi quang",
        "troi tot", "khi hau", "nhiet do", "do am", "oi buc",
        "mua bat chot", "mua tam ta", "nang gat", "ret", "lanh buot",
        # NOTE: no-diacritic collisions to avoid here: "mua qua" (mua quà),
        # "gio qua" (bao giờ quay lại), "dinh mua"/"doi mua" (định/đòi mua).
        "am u", "troi am u", "xam xit", "mua rao", "mua to",
        "mua bat ngo", "nang qua", "nang kinh khung", "troi trong",
    ],
    "crowd": [
        "dong duc", "qua dong", "qua tai", "xep hang", "cho doi", "it khach",
        "kin cho", "het cho", "chen chuc", "nhieu nguoi", "day nguoi",
        "vang ve", "dong khach", "nhieu khach", "thieu khach",
        "hang dai", "cho lau", "trong vang",
        "chen lan", "qua tai", "khong con cho", "ghe trong", "ban trong",
        "gio cao diem", "cuoi tuan dong", "dong nguoi", "vang lanh",
        "doi hang", "doi vo", "cho hang tieng", "chen vao",
        "dong lam", "rat dong", "cang dong", "dong hon", "nguoi dong",
        "dong du khach", "dong nghet", "dong kin", "nuom nuop",
        "hon ca tieng", "gan ca tieng", "cho ca tieng", "doi ca tieng",
        "nguoi voi nguoi", "dong cuc",
    ],
    "infra": [
        "sua chua", "nang cap", "dong cua", "xuong cap", "cai tao",
        "ha tang", "thang may", "co so vat chat",
        "xay dung", "thi cong", "pha bo", "nha xuong", "may moc",
        "he thong dien", "cap nuoc", "ong nuoc hong", "roi dien",
        "co so vat chat", "trang thiet bi", "ket cau",
        "may lanh", "dieu hoa", "wifi", "internet", "man hinh",
        "ghe ngoi", "ban ghe", "am thanh", "loa", "anh sang",
        "bai cho", "toa nha", "phong oc", "tang lau",
        "lavabo", "nuoc nong", "nuoc lanh",
        "may bom", "he thong nuoc", "dien nuoc",
        "duong di", "duong vao", "duong len", "loi vao",
        "bang chi dan", "bien chi dan", "chi dan", "bien bao",
        "duong kho", "duong xau", "ghep ghenh", "doc dung",
        "khong co bang", "khong co bien", "kho tim duong",
        "hoi duong", "de tim", "kho tim", "hem nho", "ngo nho",
        "duong nho", "duong da", "da tang", "duong sat", "duong tron",
        "loi di", "cong vao", "cua vao", "bai xe", "bai do xe",
        "cho dau xe", "cho do xe", "ham xe",
        "cau thang", "hanh lang", "san nha", "san vuon", "mat san", "mai che",
        "khuon vien", "quy hoach", "trung tam thuong mai",
        # Generic descriptions of physical buildings/facilities. Aesthetic
        # judgements such as "kien truc dep" are still handled by atmosphere.
        "cong trinh", "kien truc", "trung tu", "khang trang", "quy mo",
        "gian chinh", "chinh dien", "khu trung bay", "nha luu niem",
        "khu tuong niem", "san rong", "tang tret", "tang ham",
    ],
    "cleanliness": [
        "sach se", "ve sinh", "mat ve sinh", "khong ve sinh", "kem ve sinh",
        "ban thiu", "ban biu", "dinh ban", "do vat ban",
        "mui hoi", "hoi ham", "hoi thoi", "co mui", "mui kho chiu",
        "nha ve sinh", "toilet", "wc", "nha tam", "phong tam",
        "ban ghe ban", "san ban", "san nha ban", "kinh ban", "khay ban",
        "chen dia ban", "dua muong ban", "ly ban", "coc ban",
        "rac", "rac thai", "thung rac", "rac day", "rac tran",
        "ruoi", "muoi", "kien bo", "gian bo", "con trung", "sau bo",
        "am moc", "nam moc", "buibam", "bui bam", "bụi",
        "lau don", "don dep", "chua don", "khong don", "don phong",
        "ga giuong", "chan ga", "khan tam", "khan ban", "nem ban",
        "nuoc ban", "nuoc duc", "ho boi ban", "be boi ban",
    ],
    "service": [
        "nhan vien", "phuc vu", "thai do phuc vu", "cham soc khach hang",
        "quan ly", "ho tro khach", "ho tro khach hang", "lich su voi khach", "vo lich su",
        "dich vu cham soc", "phuc vu nhanh", "phuc vu cham", "than thien",
        "nhan vien thu", "giai quyet", "phan hoi",
        "nhan vien nhiet tinh", "phong cach phuc vu",
        "tiep don", "don tiep", "chao hoi", "huong dan",
        "huong dan vien", "tour guide", "tai xe",
        "xin loi", "giai thich", "xu ly", "khieu nai",
        "chuyen nghiep", "nhiet tinh", "vui ve", "niem no",
        "hach dich", "kinh dich", "co biec", "kho chiu",
        "tiep vien", "ban hang", "chao moi", "tu van",
        "chu quan", "quan chu", "nhan vien nu", "nhan vien nam",
        "phuc vu ban", "goi mon", "len mon", "ra mon",
        "order", "dat ban", "dat cho", "tiep khach",
        "doi mon", "nham mon", "quen mon", "mang mon",
    ],
    "price": [
        "gia ca", "qua dat", "gia re", "khuyen mai", "giam gia", "le phi",
        "chi phi", "hoa don", "gia tien", "mien phi", "phi dich vu",
        "gia hop ly", "muc gia cao", "gia hoi cao", "gia qua cao",
        "phi vao cua", "gia ve", "gia phong", "gia menu",
        "gia vao", "ve vao", "ve tham quan", "mat phi", "ton tien",
        "bao nhieu tien", "ngan dong", "nghin dong", "trieu dong", "k 1 bat", "k mot bat",
        "gia niem yet", "gia ninh yet", "gia co dinh",
        "tien ve", "tien phong", "tien an", "phi phat sinh",
        "gia tot", "gia binh dan", "binh dan",
        "dang dong tien", "khong xung dang", "bo tui", "so voi ngay thuong", "muc gia",
        "coupon", "voucher", "ma giam gia", "uu dai",
        "tinh tien", "bill",
    ],
    "food": [
        "do an", "mon an", "thuc an", "am thuc", "bua an",
        "nuoc leo", "nuoc dung", "nuoc cham", "nuoc sot",
        "com", "to pho", "mon pho", "bun", "banh mi", "banh cuon", "chao", "mon lau", "do nuong", "mon chay",
        "mon ngon", "an ngon", "do an ngon", "do uong ngon",
        "mon nhat", "mon man", "mon cay", "mon ngot", "vi chat", "vi beo",
        "khai vi", "trang mieng", "trang mong",
        "huong vi", "vi mon", "khau vi", "mui thom",
        "an uong", "do uong", "thuc uong",
        "menu", "thuc don", "mon chinh", "mon phu",
        "nguyen lieu", "tuoi song", "che bien", "nau",
        "khan phan", "phan an", "suat an", "khau phan",
        "dac san", "mam", "mam thai", "trai cay", "dau tam",
        "banh chung", "gio cha", "cha ca", "sua chua", "xoi",
        "pho ngon", "pho bo", "bat pho", "quay ngon", "nuoc dung",
        "tra sua", "ca phe", "sinh to", "nuoc ep", "bia",
        "com tam", "bun bo", "bun rieu", "banh mi", "banh cuon",
        "goi cuon", "bi tet", "suon", "ga", "hai san",
        "mon chien", "mon hap", "mon xao", "mon kho", "mon luoc",
        "dau bep", "bep truong", "nau an", "che bien",
        "tươi ngon", "tuoi ngon",
        "do ngot", "do man", "do chua", "do cay",
        "banh ngot", "chè", "mon che", "nuoc uong",
    ],
    "atmosphere": [
        "khong khi", "canh quan", "phong canh", "bau khong khi",
        "diem check in", "diem check-in", "goc chup anh", "selfie",
        "thien nhien", "kien truc dep", "trang tri dep", "noi that dep", "decor dep",
        "khong gian dep", "anh sang dep", "nen nhac", "am nhac nen",
        "phong cach", "co kinh", "hien dai", "doc dao", "lang man",
        "hung vi", "huu tinh", "view dep", "view",
        "phong canh dep", "canh dep", "bau khong khi de chiu",
        "khong gian thoai mai", "khong gian yen tinh",
        "sang trong", "xu huong", "dang hot", "instagrammable",
        "khung canh dep", "ao sao", "hoa dep", "vuon hoa", "cay xanh",
        "ao ho dep", "song nuoc dep", "bien dep", "nui dep", "rung dep",
        "ban dem", "buoi toi", "ban ngay", "hoang hon",
        "romantic", "khong gian thu gian", "yen tinh",
        "phong cach rieng", "tao nha", "mo ao",
        "on ao", "yen ang", "thoang mat", "am cung", "sang chanh",
    ],
    "activity": [
        "khu vui choi", "tro choi", "khu choi", "choi game", "game",
        "van dong", "the thao", "hoat dong", "tham gia",
        "khu tro choi", "san choi", "khu van dong",
        "boi loi", "leo nui", "leo tuong", "cau long", "bong da",
        "yoga", "gym", "the duc", "fitness",
        "karaoke", "xem phim", "rap phim", "phim",
        "spa", "massage", "cham soc",
        "lam thu cong", "workshop", "ve tranh", "lam banh",
        "cau ca", "cam trai", "hiking", "trekking",
        "bieu dien", "xem bieu dien", "am nhac song",
        "bong chuyen", "tennis", "pickleball", "boi",
        "chay bo", "xe dap", "truot van", "truot bang",
        "golf", "bi a", "dart", "bowling",
        "nhay", "khieu vu", "zumba", "aerobic",
        "xem phim ngoai troi", "phim cuoi tuan",
        "tro choi nuoc", "cau truot", "tu quay",
        "tham quan", "di tham quan", "chuyen di", "tour", "di tour",
        "kham pha", "du lich", "phuot", "tham du",
        "trai nghiem", "di chuyen tham quan", "di thuyen", "di tau",
        "thue tau", "ngoi tau", "cheo thuyen", "lenh denh",
        "tu do tham quan", "tu hai", "hai trai", "cho ca an",
        "ngam canh", "di dao", "dao quanh", "leo len", "di bo tham quan",
        "vao vuon", "di vuon", "tham quan vuon", "vuon dau",
        "xem coi", "thu nghiem",
    ],
}

# Vietnamese topic labels for zero-shot classification.
TOPIC_LABEL_MAP_VI: Dict[str, str] = {
    "traffic": "giao thong",
    "weather": "thoi tiet",
    "crowd": "dong duc",
    "infra": "ha tang",
    "cleanliness": "ve sinh sach se",
    "service": "dich vu",
    "price": "gia ca",
    "food": "do an va thuc uong",
    "atmosphere": "khong khi va canh quan",
    "activity": "hoat dong vui choi the thao giai tri",
}
TOPIC_LABEL_MAP_VI_REVERSE: Dict[str, str] = {v: k for k, v in TOPIC_LABEL_MAP_VI.items()}

# Prototype sentences for semantic topic classification.
# Each list contains normalized Vietnamese sentences (no diacritics) representing
# both positive and negative aspects of the topic. The embedding model maps reviews
# to the same space as these prototypes; cosine similarity determines topic scores.
# More prototypes = more robust coverage. Add domain-specific ones as needed.
TOPIC_PROTOTYPES: Dict[str, List[str]] = {
    "traffic": [
        "ket xe tac duong kho di chuyen den noi nay",
        "duong den day hay bi un tac rat kho di",
        "bai do xe rong rai de tim cho dau xe thuan tien",
        "khong co cho dau xe kho tim bai xe gan",
        "giao thong thong thoang di lai de dang",
        "khu vuc hay ket xe gio cao diem",
        "xe may o to di chuyen kho khan duong nho",
        "xe co dong duc di chuyen mat nhieu thoi gian",
        "duong dan vao ket xe o to xe may noi duoi",
    ],
    "weather": [
        "troi mua lon duong ngap nuoc kho di lai",
        "troi nang nong oi buc khi hau khong de chiu",
        "thoi tiet dep troi mat me rat thich hop di tham quan",
        "thoi tiet xau bao gio lon nguy hiem khong nen di",
        "mua nhieu am uot duong tron anh huong chuyen di",
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
        "khach qua dong phai chen lan va cho doi lau",
        "khong gian qua tai het cho ngoi va phai xep hang",
    ],
    "infra": [
        "dang sua chua xay dung nen on ao nhieu bui",
        "co so vat chat tot trang thiet bi hien dai moi",
        "may lanh hong het dien co so xuong cap",
        "thang may hu phai di bo nhieu tang",
        "he thong am thanh anh sang tot dep",
        "co so vat chat cu ky can nang cap sua chua",
        "dang dong cua nang cap tam thoi khong phuc vu",
        "duong len dia diem kho di doc dung va nhieu da tang",
        "duong vao nho kho tim khong co bien chi dan ro rang",
        "bai do xe cho dau xe va loi vao khong thuan tien",
        "khuon vien phong oc ban ghe thiet bi can duoc nang cap",
        "trung tam thuong mai toa nha moi xay co quy hoach ro rang",
        "bai xe nho kho gui xe va khong du cho dau xe",
        "loi vao cau thang hanh lang bang chi dan khong ro",
        "wifi may lanh ban ghe am thanh anh sang can nang cap",
    ],
    "cleanliness": [
        "nha ve sinh ban hoi kho chiu mat ve sinh",
        "khong gian sach se duoc don dep gon gang",
        "ban ghe chen dia ly coc deu sach se",
        "phong tam co mui hoi san nha ban",
        "co ruoi muoi con trung lam trai nghiem te",
        "ga giuong khan tam khong sach co mui am moc",
        "rac thai day chua duoc don dep kip thoi",
        "ho boi va khu vuc chung sach se an tam",
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
        "goi mon bi quen nhan vien xu ly cham",
        "dat ban thanh toan va ho tro khach hang rat nhanh",
        "thai do nhan vien kem do loi cho khach va xu ly thieu chuyen nghiep",
        "ship hang giao dung gio dong goi can than nhung giao vao khu nha cham",
        "nhan vien ban hang tu van va chao moi khach hang",
    ],
    "price": [
        "gia ca hop ly xung dang voi chat luong dang dong tien",
        "qua dat gia cao khong xung dang voi nhung gi nhan duoc",
        "gia re tot co nhieu khuyen mai giam gia hap dan",
        "chi phi cao mat tien hoa don lon phi dich vu dat",
        "mien phi vao cua khong mat them phi",
        "gia binh dan phu hop tui tien",
        "dat qua so voi chat luong thuc te",
        "muc gia cao hon ngay thuong va kha mac vao dip le",
        "mot bat pho gia 40k khong qua dat so voi chat luong",
        "gia ca phu hop voi mat bang chung khong phai la qua dat",
        "gia ve phi vao cua va hoa don cao hon mong doi",
        "mua hang khong dang tien vi gia cao ma chat luong binh thuong",
        "co khuyen mai giam gia nen chi phi kha hop ly",
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
        "do uong nhat huong vi khong ro that vong",
        "mon an duoc nem vua mieng hop khau vi",
        "pho bo ngon nuoc dung ngot thit mem gan mem va nhieu topping",
        "banh chung gio cha cha ca ngon mem thom dat ship ve nha",
        "xoi nong an vua vi goi nhieu suat khong thieu do",
        "do an dat qua ung dung ship dong goi can than van ngon",
        "cua hang ban dac san mam gio cha banh chung va mon an mang ve",
    ],
    "atmosphere": [
        "view dep khung canh dep chup anh check in dep",
        "khong khi lang man yen tinh thoai mai de chiu",
        "kien truc dep doc dao phong cach co kinh hien dai",
        "canh quan thien nhien hung vi dep mat",
        "trang tri noi that decor sang trong dep",
        "am nhac nen nhe nhang bau khong khi thu vi",
        "khong gian rong rai thoang mat nhieu cay xanh",
        "khong gian on ao am nhac qua lon kho noi chuyen",
        "anh sang va cach bai tri tao cam giac am cung",
        "phong canh song nuoc nui rung bien ho dep mat",
        "noi that va decor tao cam giac rat rieng",
        "bao quat ve cam giac de chiu yen binh va thu gian cua noi nay",
        "dia diem co nhieu goc chup anh dep va bau khong khi rieng",
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
        "di thuyen tham quan lang be trai nghiem song nuoc",
        "di tour kham pha di dao quanh dia diem du lich",
        "tu hai trai cay cho ca an va tham gia trai nghiem tai cho",
        "tham quan di bo chup hinh va trai nghiem cac hoat dong",
    ],
    "other": [
        "cam nhan chung chung khong noi ro khia canh nao",
        "chi noi ok binh thuong khong co thong tin cu the",
        "danh gia rat ngan khong de cap do an phuc vu gia ca hay canh quan",
        "noi nay cung duoc khong co gi de nhan xet them",
        "se quay lai hoac khong quay lai nhung khong neu ly do cu the",
    ],
}

# Single-sentence descriptions for E5-small topic classification.
# E5 convention: queries use "query: " prefix, passages use "passage: " prefix.
# Keep these as natural Vietnamese WITH diacritics — E5 understands them.
# One description per topic is enough; E5 handles semantic coverage internally.
TOPIC_E5_DESCRIPTIONS: Dict[str, str] = {
    "traffic": (
        "Đánh giá đề cập đến giao thông, tắc đường, kẹt xe, khó di chuyển đến địa điểm, "
        "xe cộ đông, giờ cao điểm, phương tiện và tình trạng lưu thông trên đường. "
        "Nếu chỉ nói về bãi đỗ xe, chỗ đậu xe, biển chỉ dẫn hoặc lối vào vật lý thì thuộc infra."
    ),
    "weather": (
        "Đánh giá đề cập đến điều kiện thời tiết bên ngoài như trời mưa, nắng nóng, "
        "lạnh giá, gió bão, ngập lụt, nhiệt độ, độ ẩm hoặc khí hậu làm ảnh hưởng "
        "đến việc di chuyển, tham quan hay trải nghiệm tại địa điểm."
    ),
    "crowd": (
        "Đánh giá đề cập đến mức độ đông người, xếp hàng chờ đợi, chen chúc, quá tải, "
        "vắng vẻ, ít khách, không gian chật hẹp hay rộng rãi."
    ),
    "infra": (
        "Đánh giá đề cập đến cơ sở vật chất và hạ tầng như trang thiết bị, thang máy, "
        "điện nước, wifi, máy lạnh, bàn ghế, phòng ốc, khu vực đang sửa chữa, "
        "xây dựng hoặc nâng cấp. Không bao gồm nhận xét về sạch bẩn hay mùi hôi."
    ),
    "cleanliness": (
        "Đánh giá đề cập đến vệ sinh và mức độ sạch sẽ: nhà vệ sinh, toilet, phòng tắm, "
        "bàn ghế, chén đĩa, ly cốc, sàn nhà, phòng, ga giường, khăn, hồ bơi có sạch hay bẩn; "
        "rác, bụi, mùi hôi, ẩm mốc, ruồi muỗi, kiến gián hoặc côn trùng."
    ),
    "service": (
        "Đánh giá đề cập đến con người và quy trình phục vụ: nhân viên, quản lý, lễ tân, "
        "thái độ, sự nhiệt tình hay hách dịch, tốc độ phục vụ, hỗ trợ khách hàng, "
        "gọi món, lên món, đặt bàn, thanh toán, xử lý khiếu nại. Nếu review chủ yếu nói "
        "về hương vị hoặc chất lượng món ăn thì thuộc food, không phải service."
    ),
    "price": (
        "Đánh giá đề cập đến giá cả, chi phí đắt hay rẻ, hóa đơn, khuyến mãi, "
        "có xứng đáng với tiền bỏ ra không, phí vào cửa, phí dịch vụ."
    ),
    "food": (
        "Đánh giá đề cập đến đồ ăn và thức uống: món ăn, đồ uống, hương vị, ngon hay dở, "
        "độ mặn ngọt cay, nguyên liệu, khẩu phần, thực đơn, nước lèo, cách nấu, đầu bếp. "
        "Nếu review chủ yếu nói về thái độ nhân viên, gọi món chậm hoặc thanh toán thì thuộc service."
    ),
    "atmosphere": (
        "Đánh giá đề cập đến không gian và bầu không khí của địa điểm: view, cảnh quan, "
        "phong cảnh thiên nhiên, kiến trúc, trang trí, decor, ánh sáng, âm nhạc nền, "
        "mức độ yên tĩnh hay ồn ào, cảm giác lãng mạn, thoải mái, check-in chụp ảnh. "
        "Không dùng topic này chỉ vì review kể các hoạt động đã làm; nếu trọng tâm là đi tour, "
        "tham quan, đi thuyền, chơi trò chơi hoặc trải nghiệm tại chỗ thì thuộc activity."
    ),
    "activity": (
        "Đánh giá đề cập đến những việc du khách làm tại địa điểm: tham quan, đi tour, "
        "đi thuyền, đi tàu, khám phá, đi dạo, tự hái, cho cá ăn, chơi trò chơi, "
        "giải trí, thể thao, spa, massage, workshop, biểu diễn nghệ thuật, leo núi, "
        "cắm trại, karaoke, xem phim. Nếu review chỉ mô tả view, cảnh quan, decor hoặc "
        "bầu không khí mà không nói đến hoạt động thì thuộc atmosphere."
    ),
    "other": (
        "Đánh giá chung chung hoặc quá ngắn, không thuộc bất kỳ topic cụ thể nào trong hệ thống. "
        "Ví dụ chỉ nói 'ok', 'bình thường', 'tạm được', 'không có gì đặc biệt', "
        "'sẽ quay lại' hoặc 'không quay lại' nhưng không nêu rõ lý do. Không dùng other "
        "nếu review có nhắc rõ đồ ăn, phục vụ, giá cả, vệ sinh, hạ tầng, thời tiết, "
        "đông đúc, hoạt động hoặc không gian/cảnh quan."
    ),
}

TOPIC_E5_DESCRIPTIONS.update({
    "infra": (
        "Danh gia ve ha tang va co so vat chat huu hinh cua dia diem: duong vao, duong len, "
        "loi di, bai do xe, cho dau xe, bien chi dan, bang chi dan, thang may, dien nuoc, wifi, "
        "may lanh, ban ghe, phong oc, khuon vien, toa nha, trang thiet bi, khu vuc dang sua chua, "
        "xay dung hoac nang cap. Neu review noi duong kho di, doc, da tang, kho tim duong thi la infra. "
        "Khong bao gom dia chi de tim trong review do an, cam giac dep, lang man, yen tinh, view hay bau khong khi."
    ),
    "service": (
        "Danh gia ve nhan vien, chu quan, tiep vien, shipper, tu van, thai do phuc vu, xu ly loi, "
        "goi mon, len mon, thanh toan, giao hang dung gio, dong goi can than hoac cham soc khach. "
        "Neu review chu yeu noi mon an ngon, huong vi, banh, pho, gio cha, xoi, do uong thi la food, "
        "du co nhac phu den ship hoac phuc vu."
    ),
    "price": (
        "Danh gia ve gia ca, muc gia, chi phi, hoa don, dat re, khuyen mai, gia cao so voi ngay thuong, "
        "40k mot bat, khong qua dat, xung dang voi tien. Khong nham voi cum 'danh gia cao' vi do la khen/nhan xet, "
        "khong phai noi ve gia tien."
    ),
    "food": (
        "Danh gia ve do an thuc uong va mon cu the: pho, bun, com, xoi, banh chung, gio cha, cha ca, "
        "sua chua, mam, dac san, nuoc dung, thit, gan, huong vi, ngon do, mem, thom, khau phan. "
        "Neu review dat online qua app, ship ve nha, dong goi can than nhung trong tam van la mon an thi la food."
    ),
    "atmosphere": (
        "Danh gia ve cam giac khong gian va bau khong khi cua dia diem: view dep, canh quan dep, "
        "phong canh thien nhien, kien truc dep, decor dep, anh sang dep, am nhac nen, yen tinh, "
        "on ao, lang man, thoai mai, am cung, diem check-in chup anh. Chi chon atmosphere khi "
        "trong tam la trai nghiem tham my hoac cam xuc ve khong gian. Neu review noi ve duong vao, "
        "loi di, bai xe, bien chi dan, thiet bi, phong oc, sua chua hay co so vat chat thi la infra."
    ),
    "activity": (
        "Danh gia ve nhung viec du khach lam tai dia diem: tham quan, di tour, di thuyen, di tau, "
        "kham pha, di dao, tu hai, cho ca an, choi tro choi, giai tri, the thao, spa, massage, "
        "workshop, bieu dien nghe thuat, leo nui, cam trai, karaoke, xem phim. Neu review chi mo ta "
        "view, canh quan, decor hoac bau khong khi ma khong noi den hanh dong/trai nghiem thi la atmosphere."
    ),
})

# Strong time references: a single hit conclusively indicates short-term.
STRONG_SHORT_TIME_CUES: List[str] = [
    "hom nay", "bay gio", "hien tai", "hien nay", "luc nay", "ngay hom nay",
    "sang nay", "chieu nay", "toi nay", "dem nay",
    "hom qua", "hom truoc", "ngay qua", "vua qua", "moi day", "gan day", "gan nhat",
    "tuan nay", "tuan truoc", "tuan vua", "thang nay", "thang truoc", "thang vua",
    "tam thoi", "nhat thoi", "truoc mat", "hien gio",
    "dip nay", "thoi diem nay", "cuoi tuan nay", "dau tuan nay",
    "moi khai truong", "moi mo cua", "vua khai truong",
    # Explicit one-time visit framing (Cách A)
    "lan nay", "lan do", "chuyen nay", "lan nay thi", "lan nay la",
    # Contrast with previous experience (suggests this visit was unusual)
    "lan nay khac", "lan nay te hon", "lan nay tot hon", "lan truoc tot hon",
    "binh thuong ngon nhung", "binh thuong tot nhung", "moi lan truoc",
]

# Weak time markers: require >= 2 hits, or topic is transient (1 hit enough).
# Only multi-word phrases here to avoid polysemy false positives.
# "vua" and "moi" as standalone tokens are too ambiguous — use specific phrases instead.
WEAK_SHORT_TIME_CUES: List[str] = [
    "dang co",        # đang có (currently has)
    "dang sua",       # đang sửa (currently repairing)
    "dang dong",      # đang đông (currently crowded)
    "dang vang",      # đang vắng (currently quiet)
    "vua den",        # vừa đến (just arrived)
    "vua an",         # vừa ăn (just ate)
    "vua uong",       # vừa uống (just drank)
    "vua thu",        # vừa thử (just tried)
    "vua toi",        # vừa tới (just got here)
    "vua duoc",       # vừa được (just got)
    "moi toi",        # mới tới (just arrived)
    "moi den",        # mới đến (just got here)
    "moi thu",        # mới thử (just tried)
    "moi an",         # mới ăn (just ate)
]

# Long-term signals: indicate stable/recurring observations.
# Removed standalone "luon" — too polysemous ("Next luôn" ≠ habitual "always").
LONG_TIME_CUES: List[str] = [
    "nhieu nam", "lau dai", "on dinh", "thuong xuyen", "luon luon",
    "xuyen suot", "truyen thong", "tu truoc", "bao lau nay", "may nam",
    "hang nam", "tu lau", "quen thuoc", "co dinh", "bao gio cung",
    "tu truoc den nay", "nhieu lan", "lan nao cung",
    "tuan nao cung", "thang nao cung", "ngay nao cung",
    # Habitual "luôn" only when followed by a verb/adjective phrase
    "luon ngon", "luon tot", "luon te", "luon cham", "luon nhanh",
    "luon phuc vu", "luon co", "luon sach", "luon ban",
    "luon on ao", "luon vang ve", "luon dong khach",
    # Recurring visit / repeated-attempt patterns
    "moi lan", "luc nao cung", "thu lai", "tro lai", "quay lai",
    "nhung lan", "da nhieu lan",
    # General characteristic framing (Cách A: describes the place, not a visit)
    "noi nay luon", "quan nay luon", "cho nay luon",
]

# Context-aware false positive corrections:
# These phrases look like temporal cues but are colloquial/non-temporal in Vietnamese.
FALSE_POSITIVE_LONG_CUES: List[str] = [
    "luon la",        # "luôn là" at end = "that's it/done" (e.g. "Next luôn là vừa")
    "di luon",        # "đi luôn" = leave/skip permanently, not "always"
    "next luon",      # "Next luôn" = skip/pass, not temporal "always"
    "bo luon",        # "bỏ luôn" = just drop it, not temporal
    "thoi luon",      # "thôi luôn" = just forget it
]
FALSE_POSITIVE_WEAK_CUES: List[str] = [
    "la vua",         # "là vừa" = "that's enough/just right", not "just happened"
    "vua la",         # "vừa là" = same colloquial usage
    "xong la vua",    # "xong là vừa" = done, that's it
]

POSITIVE_WORDS: List[str] = [
    "tot", "tuyet voi", "dep", "hai long", "de nghi", "than thien",
    "ngon", "rat tot", "an tuong", "de chiu", "tuyet", "xuat sac",
    "hoan hao", "chu dao", "yeu thich", "noi bat", "dang tien",
    "sang trong", "thoai mai", "sach se", "nhanh chong", "tich cuc",
    "hieu qua", "niem no", "chat luong tot", "dich vu tot",
    "lang man", "thu vi", "yen tinh", "hap dan", "an tam", "tin tuong",
    "phu hop", "ung y", "chuan", "dang dong tien", "rat ngon",
    "phuc vu tot", "nhan vien tot", "gia hop ly", "sach bong",
    # Expanded
    "kha", "on", "duoc", "binh thuong on", "chap nhan duoc",
    "rat dep", "dep lam", "ngon lam", "tot lam", "rat hai long",
    "cuon hut", "an tuong manh", "khong the quen", "dang nho",
    "chat luong", "uy tin", "chuyen nghiep", "nhiet tinh", "niem no",
    "kha on", "phuc vu kha on", "phuc vu nhanh", "chu dong",
    "ho tro nhiet tinh", "khong phai cho qua lau", "khong phai doi lau",
    "ve sinh", "sach", "nhanh", "hieu qua", "tien loi",
    "phong phu", "da dang", "da chon lua", "nhieu lua chon",
    "gia tri", "xung dang", "xung tam", "tuyet hao",
    "rat thich", "thich lam", "quy lam", "quy",
    "rat dang", "se quay lai", "nhat dinh quay lai", "recommend",
    "goi y", "de xuat", "dang thu", "nen thu", "nen den",
    "ok", "rat la ok", "rong rai", "thoang mat", "nhon nhip",
    "mat me", "khong khi trong lanh", "nhieu hoat dong",
]

NEGATIVE_WORDS: List[str] = [
    "te", "toi", "that vong", "xau", "kinh khung", "khong hai long",
    "qua dat", "cho lau", "om ao", "ban", "on ao", "kem chat luong",
    "that bai", "kem", "lua dao", "chan nan", "kho chiu", "bat man",
    "cham tre", "phuc vu kem", "nhan vien thu", "tho lo",
    "khong sach", "bat tien", "khong ngon", "nhieu loi",
    "hay hong", "qua on", "nguy hiem", "xu ly cham",
    "khong phu hop", "hon don", "lang phi", "cau tha", "vo cam",
    # Expanded
    "kinh", "te hai", "kem qua", "chan", "buc boi",
    "that bai hoan toan", "qua te", "toi qua", "kem hon mong doi",
    "khong dang", "khong xung dang", "phung phi", "mat tien",
    "vo ich", "lang phi thoi gian", "mat thoi gian",
    "khong dang tin", "khong chuyen nghiep", "thieu chuyen mon",
    "hu hong", "xuong cap", "kem chat", "kem luong",
    "phuc vu do", "nhan vien te", "chu quan hu",
    "phuc vu cham", "thieu chu dong", "chua nhiet tinh", "thieu ho tro",
    "dat ma khong ngon", "dat ma kem", "dat vo ly",
    # NOTE: "o ban" (ở bẩn) removed — collides with "cô bán / chỗ bán";
    # "mat vi" (mất vị) removed — collides with "thoáng mát, vị trí".
    "ban biu", "ban thiu", "khong ve sinh",
    "mui hoi", "hoi ham", "hoi thoi", "co mui", "mui kho chiu",
    "con trung", "ruoi",
    "cho lau qua", "cho mai", "doi rat lau",
    "khong nhan", "tu choi", "vo ly", "lo lang",
    "kho chiu qua", "phat buc", "tuc gian", "that kinh",
    "mat hung", "khong yen", "khong duoc nhu mong doi", "khong nhu mong doi",
    "xam xit", "gio manh", "gio lon", "lanh buot", "gio tat",
    "khong thoai mai", "nguoi ngat", "nguoi lanh", "met", "met moi",
    "qua met", "kha oai", "oai", "am anh", "tut han", "tut tam trang",
    "ket xe", "dong nghet", "dong qua", "qua dong", "chen chuc",
    "hit khoi bui", "khoi bui", "coi chung", "khong nen den",
    "khong nen mua", "khong dang tien", "khong bat mat", "ngan lam",
    # "gia cao" alone collides with "đánh giá cao" — only qualified forms.
    "qua ngot", "khong thay re", "mac", "gia mac",
    "gia qua cao", "gia rat cao", "gia kha cao", "muc gia cao",
    "cao hon gap doi", "gap doi", "hang gia", "khong that",
    "coc can", "duoi khach", "lam nhu xin an", "khong muon ban",
    # Expanded from common review complaint vocabulary
    "buc minh", "cau gat", "mat cau co", "lo di", "phot lo",
    "kinh tom", "dang so", "ban thiu", "nho nhop", "hoi tanh",
    "lua dao", "bi lua", "quyt tien", "dan canh", "cheo keo",
    "chat chem", "cat co", "xot thuong", "cam thu",
    "bang hoang", "lam xau", "tra hinh",
]

# Stronger phrase-level sentiment cues. These are intentionally longer than the
# base lexicon because they should override model optimism in mixed reviews
# ("view dep nhung gio manh qua...") without making generic words too negative.
STRONG_NEGATIVE_SENTIMENT_PHRASES: List[str] = [
    "khong nen den", "khong nen mua", "khong dang tien", "khong xung dang",
    "khong duoc nhu mong doi", "khong nhu mong doi", "khong thoai mai",
    "mat hung", "that vong", "te vo cung", "qua te", "rat te",
    "phuc vu khong vui tinh", "coc can", "duoi khach", "lam nhu xin an",
    "khong muon ban", "khong ngon", "khong thay re", "hang gia",
    # "gia cao" alone collides with "đánh giá cao" — qualified forms only.
    "khong that", "cao hon gap doi", "gia qua cao", "gia rat cao",
    "gia kha cao", "muc gia cao", "qua dat",
    "ket xe qua met", "dong nghet", "xe may chen chuc", "o to noi duoi",
    "hit khoi bui", "gio manh qua", "gio lon qua", "gio tat lien tuc",
    "lanh buot", "xam xit", "anh sang toi", "len hinh khong dep",
    "tam trang luc toi noi tut", "tut han luon",
    "khong quay lai", "khong muon quay lai", "khong hai long",
    "thieu chuyen nghiep", "thai do te", "nhan vien te",
    "phuc vu kem", "phuc vu cham", "doi rat lau", "cho rat lau",
    "do an te", "do an do", "mon an te", "mon an do",
    "chat luong kem", "khong hop ly", "khong de xuat",
    "khong tot", "khong dep", "khong vui", "khong thich",
    # "rat chan"/"chan that" collide with "rất chân thật/chân chất" — dropped.
    "khong on chut nao", "khong on lam", "qua chan",
    "do te", "tham hai", "chua hai long",
    "bat tien", "bat on", "phai doi lau", "phai cho lau",
    "phai ve som", "khong bang mong doi", "khong nhu ky vong",
    # Staff-attitude and scam complaints (generalized from labeled data).
    # NOTE: bare "qua toi" collides with "qua tới" (arrive), and bare
    # "thuong tam" with "bình thường tầm" — only prefixed forms are safe.
    "rat toi", "cuc ki toi", "cuc ky toi",
    "thai do qua toi", "nhan vien qua toi", "phuc vu qua toi",
    "thai do toi", "thai do kem", "thai do te", "thai do rat chan",
    "coi thuong khach", "noi nang kho nghe", "kho nghe", "cuc tuc",
    "mat cau co", "cang ngay cang kem", "khong mot loi xin loi",
    "kinh tom", "dang so", "ban thiu", "nho nhop", "mat ve sinh",
    "lua dao", "bi lua", "quyt tien", "dan canh", "tra hinh",
    "gia cat co", "chat chem", "nhap vien", "ngo doc",
    "tut het cam xuc", "tut mood", "te hai",
    "khong bao gio quay lai", "khong co y thuc",
    # Grief/tragedy vocabulary — memorial-site reviews the annotators mark negative
    "am anh", "rat thuong tam", "qua thuong tam", "that thuong tam",
    "xot thuong", "cam thu", "bang hoang",
    "lam xau", "cau gat",
    # Trip-ruined phrasing common in traffic/weather complaints
    "mat vui", "ket cung", "dong khung khiep", "chon chan",
]

MILD_NEGATIVE_SENTIMENT_PHRASES: List[str] = [
    "hoi lanh", "hoi met", "kha met", "kha oai", "khong yen",
    "khong de chiu", "khong on", "kho di", "kho chiu", "doi lau",
    "mat thoi gian", "mau nguoi", "ngoi chua lau da phai ve",
    "sai ngay", "cao diem", "mua khong ky", "co vat hay khong",
    "co vat hay khong lay", "co vat hay khong lay thi van tinh thue",
    "hoi dat", "hoi mac", "kha dat", "kha mac", "khong re",
    # "chua duoc" alone collides with "chùa được xây..." — qualified forms only;
    # same for bare "khong duoc" ("không được nói to" etc. is not sentiment).
    "khong duoc dep", "khong duoc tot", "khong duoc ngon",
    "khong duoc sach", "khong duoc nhu", "khong duoc thoai mai",
    "chua duoc dep", "chua duoc tot", "chua duoc ngon",
    "chua duoc sach", "chua duoc nhu", "chua duoc ve sinh",
    "tam thoi", "binh thuong",
    "khong co gi dac biet", "khong nhu ky vong", "duoc moi cai",
    "tru diem", "diem tru", "hoi that vong", "khong an tuong",
    "hoi te", "khong ro", "khong bang", "khong nhu", "qua lau",
    "lau qua", "phai doi", "phai cho", "khong muon", "khong thich",
    "khong dep", "khong ngon lam", "khong tot lam", "hoi chan",
    "kha te", "hoi kem", "khong con dep", "khong bang truoc",
    "buc minh", "lo di", "khong chu y", "cham chap", "kha chan",
    "khong con thoai mai", "lon xon", "lam lem", "muon hon du tinh",
    "tre hon du tinh",
]

STRONG_POSITIVE_SENTIMENT_PHRASES: List[str] = [
    "rat la ok", "rat ok", "la ok", "rat tuyet", "rat dep", "rat ngon",
    "rong rai", "thoang mat", "nhon nhip", "nhieu hoat dong",
    "khong khi trong lanh", "rat mat", "de chiu",
    "khong qua dat", "khong qua mac", "gia ca binh thuong",
]

# Negated/praise phrases that CONTAIN a strong-negative substring. Each
# occurrence cancels one strong-negative hit: "không quá đắt" contains
# "qua dat" but is praise; "đánh giá cao" contains "gia cao"-like praise.
STRONG_NEGATIVE_OVERRIDE_PHRASES: List[str] = [
    "khong qua dat", "khong qua mac", "khong qua te", "khong thay dat",
    "khong he dat", "khong bi dat", "danh gia cao",
]

# Lighter models chosen for best accuracy-to-size trade-off on Vietnamese text.
# paraphrase-multilingual-MiniLM-L12-v2: ~420MB, strong multilingual sentence embeddings.
DEFAULT_EMBEDDING_MODEL  = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DEFAULT_TOPIC_MODEL      = "intfloat/multilingual-e5-small"
# lxyuan/distilbert-base-multilingual-cased-sentiments-student: ~260MB (DistilBERT),
# outputs positive/neutral/negative directly — simpler and lighter than star-rating models.
DEFAULT_SENTIMENT_MODEL = "5CD-AI/Vietnamese-Sentiment-visobert"
# Zero-shot NLI is disabled by default. The current pipeline uses E5 for topic
# classification and fine-tuned PhoBERT for time_label classification.
DEFAULT_ZEROSHOT_MODEL = None

SENTIMENT_TOKENIZER_FALLBACKS_BY_MODEL: Dict[str, List[str]] = {
    # This fine-tuned model is XLM-R based. In some transformers/tokenizers
    # combinations, its tokenizer.json raises:
    #   argument 'vocab': 'dict' object cannot be converted to 'Sequence'
    # Reusing the canonical XLM-R tokenizer avoids that broken metadata path.
    "5cd-ai/vietnamese-sentiment-visobert": [
        "FacebookAI/xlm-roberta-base",
        "xlm-roberta-base",
    ],
}


# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

def _from_pretrained_safe(model_cls, model_name_or_path: str, **kwargs):
    try:
        return model_cls.from_pretrained(model_name_or_path, **kwargs)
    except TypeError:
        kwargs.pop("use_safetensors", None)
        return model_cls.from_pretrained(model_name_or_path, **kwargs)

def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def ensure_aware_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def strip_accents(text: str) -> str:
    text = text.replace("đ", "d").replace("Đ", "D")
    normalized = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


# Common Vietnamese review shorthands. Canonicalising them lets the
# negation-aware sentiment counter and every keyword matcher treat
# "k tot", "ko ngon", "nhan dc" the same as their full spellings.
_SHORTHAND_REPLACEMENTS: List[Tuple[re.Pattern, str]] = [
    # standalone "k"/"ko" = "khong". Amounts like "30k" are a single token and
    # unaffected; the lookbehinds also protect the rarer "30 k" spelling.
    (re.compile(r"(?<!\d)(?<!\d )\bk\b"), "khong"),
    (re.compile(r"\bko\b"), "khong"),
    (re.compile(r"\bhok\b"), "khong"),
    (re.compile(r"\bkhg\b"), "khong"),
    (re.compile(r"\bdc\b"), "duoc"),
    (re.compile(r"\bnv\b"), "nhan vien"),
]


def normalize_text(text: str) -> str:
    text = strip_accents(text.lower())
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    for pattern, replacement in _SHORTHAND_REPLACEMENTS:
        text = pattern.sub(replacement, text)
    return text


def simple_tokens(text: str) -> List[str]:
    return [tok for tok in text.split(" ") if tok]


def resolve_torch_device(torch_module, preference: str = "cpu"):
    """Resolve model device.

    Default to CPU because CUDA device-side asserts can poison later model calls.
    Pass --model-device cuda/auto only when explicitly benchmarking GPU execution.
    """
    pref = str(preference or "cpu").strip().lower()
    if pref in {"cuda", "gpu", "auto"} and torch_module.cuda.is_available():
        return torch_module.device("cuda")
    return torch_module.device("cpu")


SIMILARITY_STOPWORDS = frozenset({
    "va", "la", "thi", "co", "cua", "cho", "minh", "toi", "ban", "nay",
    "mot", "trong", "khi", "voi", "rat", "kha", "da", "duoc", "bi", "o",
    "vao", "ra", "ve", "nhung", "neu", "cung", "cac", "nhu", "hon", "luc",
    "vi", "de", "nen", "roi", "van", "qua", "lam", "thay", "nguoi",
})


def content_token_set(text: str) -> set[str]:
    return {
        tok for tok in simple_tokens(normalize_text(text))
        if len(tok) > 1 and tok not in SIMILARITY_STOPWORDS
    }


def count_keyword_hits(text: str, keywords: List[str]) -> int:
    """Count keyword matches with word-boundary check for single-word keywords."""
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


def count_strong_negative_hits(text: str) -> int:
    """Strong-negative phrase count with negated-praise compensation.

    "không quá đắt" contains the strong phrase "qua dat" but is praise;
    subtract one hit per override occurrence so such reviews are not
    treated as explicit complaints.
    """
    hits = count_keyword_hits(text, STRONG_NEGATIVE_SENTIMENT_PHRASES)
    overrides = count_keyword_hits(text, STRONG_NEGATIVE_OVERRIDE_PHRASES)
    return max(0, hits - overrides)


# Vietnamese negation tokens (normalized/no-diacritic form).
# Only unambiguous negators are safe after accent stripping.  ``chùa/chưa``,
# ``đứng/đừng`` and ``khói/khỏi`` collapse to the same normalized tokens;
# treating them as generic negators flips ordinary praise in reviews about temples
# ("chùa được xây..." -> negative).  Qualified ``chua ...`` complaints are
# already covered by the phrase lexicons below.
_VI_NEG_TOKENS = frozenset({"khong", "chang"})

def count_sentiment_hits_negation_aware(
    norm_text: str,
    positive_kws: List[str],
    negative_kws: List[str],
) -> Tuple[int, int]:
    """Return (effective_pos, effective_neg) with polarity flipped for negated keywords.

    "không ngon" → the "ngon" hit moves from positive to negative.
    "không tệ"   → the "tệ" hit moves from negative to positive.
    Only single-token keywords after the negation are detected; multi-word phrases
    rely on the standard count (negation of multi-word phrases is uncommon).
    """
    token_list = norm_text.split()

    def _is_negated(tok_idx: int) -> bool:
        window = token_list[max(0, tok_idx - 3): tok_idx]
        return any(t in _VI_NEG_TOKENS for t in window)

    def _has_noisy_positive_context(tok_idx: int, kw: str) -> bool:
        prev_tok = token_list[tok_idx - 1] if tok_idx > 0 else ""
        next_tok = token_list[tok_idx + 1] if tok_idx + 1 < len(token_list) else ""
        next_two = " ".join(token_list[tok_idx + 1: tok_idx + 3])
        if kw == "on" and next_tok == "ao":
            return True
        if kw == "kha" and (
            next_tok in {"cao", "mac", "dat", "met", "oai", "lanh", "te", "chan", "toi", "ban"}
            or next_two in {"cao hon", "la cao", "la mac"}
        ):
            return True
        if kw == "duoc" and prev_tok in {"khong", "chua", "chang"}:
            return False
        return False

    def _has_noisy_negative_context(tok_idx: int, kw: str) -> bool:
        prev_tok = token_list[tok_idx - 1] if tok_idx > 0 else ""
        next_tok = token_list[tok_idx + 1] if tok_idx + 1 < len(token_list) else ""
        if kw == "toi":
            return not (
                prev_tok in {"rat", "qua", "te", "that", "sieu"}
                or next_tok in {"qua", "te"}
            )
        if kw == "ban":
            dirty_context = {"bui", "thiu", "biu", "do", "qua", "lem", "nhem"}
            return prev_tok not in dirty_context and next_tok not in dirty_context
        if kw == "mac":
            return prev_tok not in {"qua", "hoi", "kha", "rat", "gia", "cung", "ban"} and next_tok != "qua"
        if kw == "chan":
            # "chân" (foot/genuine): chân thật, chân chất, chân núi, chân gà...
            return (
                next_tok in {"that", "thanh", "chat", "tinh", "ga", "nui", "tay", "dung", "ly", "troi"}
                or prev_tok in {"duoi", "khoi", "ban"}
            )
        if kw == "kem":
            # "kem" (ice cream / kem chống nắng) vs "kém" (poor).
            return (
                prev_tok in {"an", "ban", "mua", "thoa", "boi", "cay", "mon", "vi", "ly"}
                or next_tok in {"chong", "rainbow", "tuoi", "op", "dua", "socola", "vani", "sua", "flan"}
            )
        return False

    eff_pos = 0
    eff_neg = 0

    for kw in positive_kws:
        parts = kw.split()
        if len(parts) == 1:
            for i, tok in enumerate(token_list):
                if tok == kw:
                    if _has_noisy_positive_context(i, kw):
                        continue
                    if _is_negated(i):
                        eff_neg += 1  # "không ngon" → negative
                    else:
                        eff_pos += 1
        else:
            if kw in norm_text:
                eff_pos += norm_text.count(kw)  # multi-word: no negation flip

    for kw in negative_kws:
        parts = kw.split()
        if len(parts) == 1:
            for i, tok in enumerate(token_list):
                if tok == kw:
                    if _has_noisy_negative_context(i, kw):
                        continue
                    if _is_negated(i):
                        eff_pos += 1  # "không tệ" → positive
                    else:
                        eff_neg += 1
        else:
            if kw in norm_text:
                eff_neg += norm_text.count(kw)

    return eff_pos, eff_neg


# Regex patterns for habitual phrases where filler words may interrupt the anchor.
# E.g. "tuần nào 2 bé cũng đòi đi" — "nào" and "cũng" separated by "2 bé".
# Each pattern must match a LONG-TERM habitual signal.
_HABITUAL_LONG_PATTERNS = [
    re.compile(r'\b(tuan|thang|ngay|lan|dip|ky)\s+nao\b.{0,15}\bcung\b'),
    re.compile(r'\b(luc|khi|hoi)\s+nao\b.{0,15}\bcung\b'),
    re.compile(r'\bsuot\s+(ca\s+)?(tuan|thang|nam|ngay|doi|thoi\s+gian)\b'),
    re.compile(r'\bkhong\s+lan\s+nao\b.{0,10}\bkhong\b'),  # "không lần nào ... không"
]


def count_habitual_pattern_hits(norm_text: str) -> int:
    """Count habitual long-term patterns that simple substring matching misses."""
    return sum(1 for pat in _HABITUAL_LONG_PATTERNS if pat.search(norm_text))


DEFAULT_EMBEDDING_DIM = 384


def hash_embedding(tokens: List[str], dim: int = DEFAULT_EMBEDDING_DIM) -> List[float]:
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
    return {outer_k: ensure_float_dict(inner_v) for outer_k, inner_v in payload.items()}


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
            "neutral": float(base_sentiment["neutral"] * topic_score),
            "negative": float(base_sentiment["negative"] * topic_score),
        }
    if not sentiment_by_topic:
        sentiment_by_topic["other"] = {"positive": 0.0, "neutral": 1.0, "negative": 0.0}
    return sentiment_by_topic


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

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
    old_lookback_multiplier: int
    promotion_mode: str
    conflict_score_threshold: float = 0.65
    max_candidates_per_review: Optional[int] = None
    ttl_hours_by_topic: Optional[Dict[str, int]] = None
    observation_rules: Optional[Dict[str, Any]] = None
    lookback_multiplier_by_topic: Optional[Dict[str, int]] = None
    phobert_time_model_path: Optional[str] = None
    supabase_url: Optional[str] = None
    supabase_key: Optional[str] = None
    supabase_schema: str = "review_ai"
    supabase_batch_size: int = 500
    supabase_limit: Optional[int] = None
    save_json: bool = False


# ---------------------------------------------------------------------------
# Model providers
# ---------------------------------------------------------------------------

class EmbeddingProvider:
    def __init__(self, use_pretrained_model: bool, model_name: str, model_device: str = "cpu"):
        self.model_active = False
        self.model_error: Optional[str] = None
        self.model_last_error: Optional[str] = None
        self._model = None
        self._tokenizer = None
        self._torch = None

        if not use_pretrained_model:
            return

        try:
            import torch
            from transformers import AutoTokenizer, AutoModel
            _device = resolve_torch_device(torch, model_device)
            self._tokenizer = AutoTokenizer.from_pretrained(model_name)
            self._model = _from_pretrained_safe(AutoModel, model_name)
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

    def _move_to_cpu(self) -> bool:
        if self._torch is None or self._model is None:
            return False
        if str(getattr(self, "_device", "")) == "cpu":
            return False
        try:
            self._device = self._torch.device("cpu")
            self._model.to(self._device)
            return True
        except Exception as exc:
            self.model_last_error = str(exc)
            return False

    def _embed_pretrained(self, normalized_text: str) -> List[float]:
        inputs = self._tokenizer(
            [normalized_text],
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=512,
        )
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with self._torch.no_grad():
            outputs = self._model(**inputs)
        embedding = self._mean_pool(outputs.last_hidden_state, inputs["attention_mask"])
        embedding = self._torch.nn.functional.normalize(embedding, p=2, dim=1)
        return [float(v) for v in embedding[0].cpu().tolist()]

    def embed(self, normalized_text: str, tokens: List[str]) -> List[float]:
        if self.model_active and self._model is not None and self._tokenizer is not None:
            try:
                self.model_last_error = None
                return self._embed_pretrained(normalized_text)
            except Exception as exc:
                self.model_last_error = str(exc)
                if self._move_to_cpu():
                    try:
                        self.model_last_error = None
                        return self._embed_pretrained(normalized_text)
                    except Exception as exc2:
                        self.model_last_error = str(exc2)
                return hash_embedding(tokens)
        return hash_embedding(tokens)

    def predict_topic_semantic(self, norm_text: str) -> Optional[Dict[str, float]]:
        """Compute cosine similarity between the review and each topic's prototype sentences.

        Prototype embeddings are computed once and cached. Because both the review and
        prototypes are embedded by the same L2-normalized model, dot product = cosine sim.
        Returns a dict {topic: max_similarity} ready for blending in _classify_topic().
        """
        if not self.model_active or self._model is None:
            return None

        # Lazy-initialise prototype embeddings (once per pipeline lifetime).
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
            self._prototype_embs = cache  # type: ignore[attr-defined]

        import numpy as _np
        review_arr = _np.array(
            self.embed(norm_text, norm_text.split()), dtype="float32"
        )

        scores: Dict[str, float] = {}
        for topic, embs in self._prototype_embs.items():
            if not embs:
                scores[topic] = 0.0
                continue
            # Dot product of L2-normalised vectors == cosine similarity.
            sims = [float(_np.dot(review_arr, e)) for e in embs]
            # Use mean of top-3 prototypes to balance coverage vs. noise.
            top_sims = sorted(sims, reverse=True)[:3]
            scores[topic] = float(sum(top_sims) / len(top_sims))

        # Shift to [0, 1]: cosine similarity can be negative; subtract min first.
        min_s = min(scores.values())
        scores = {t: s - min_s for t, s in scores.items()}
        total = sum(scores.values()) or 1.0
        return {t: s / total for t, s in scores.items()}


class _DirectSentimentClassifier:
    """Wraps AutoModelForSequenceClassification for text-classification without using pipeline()."""
    def __init__(self, model_name: str, device):
        import torch
        from transformers import AutoModelForSequenceClassification
        self._torch = torch
        self._tokenizer = self._load_tokenizer(model_name)
        self._model = _from_pretrained_safe(AutoModelForSequenceClassification, model_name)
        self._sync_tokenizer_and_model_vocab()
        self._model.to(device)
        self._model.eval()
        self._id2label = {int(k): str(v) for k, v in self._model.config.id2label.items()}
        self._device = device

    def _tokenizer_vocab_size(self) -> int:
        try:
            return int(len(self._tokenizer))
        except Exception:
            return int(getattr(self._tokenizer, "vocab_size", 0) or 0)

    def _model_vocab_size(self) -> int:
        try:
            embeddings = self._model.get_input_embeddings()
            return int(getattr(embeddings, "num_embeddings", 0) or 0)
        except Exception:
            return 0

    def _resize_token_embeddings(self, required_size: int) -> None:
        current_size = self._model_vocab_size()
        if required_size > current_size:
            raise ValueError(
                "Sentiment tokenizer/model vocab mismatch: "
                f"tokenizer_vocab_size={required_size}, model_vocab_size={current_size}. "
                "Refusing to resize the pretrained model because it can exhaust memory "
                "and the tokenizer would not be semantically compatible with the model."
            )

    def _sync_tokenizer_and_model_vocab(self) -> None:
        tokenizer_size = self._tokenizer_vocab_size()
        if tokenizer_size > 0:
            self._resize_token_embeddings(tokenizer_size)

    def _ensure_input_ids_fit_model(self, inputs: Dict[str, Any]) -> None:
        if "input_ids" not in inputs:
            return
        model_vocab_size = self._model_vocab_size()
        if model_vocab_size <= 0:
            return
        max_token_id = int(inputs["input_ids"].max().item())
        if max_token_id < model_vocab_size:
            return

        raise ValueError(
            "Sentiment tokenizer/model vocab mismatch: "
            f"max_input_id={max_token_id}, model_vocab_size={model_vocab_size}, "
            f"tokenizer_vocab_size={self._tokenizer_vocab_size()}."
        )

    def _move_to_cpu(self) -> bool:
        if str(getattr(self, "_device", "")) == "cpu":
            return False
        try:
            self._device = self._torch.device("cpu")
            self._model.to(self._device)
            return True
        except Exception:
            return False

    def _load_tokenizer(self, model_name: str):
        """Load sentiment tokenizer with fallbacks for ViSoBERT/XLM-R tokenizer metadata."""
        from transformers import AutoTokenizer, XLMRobertaTokenizer, XLMRobertaTokenizerFast

        model_key = model_name.lower()
        fallback_sources = SENTIMENT_TOKENIZER_FALLBACKS_BY_MODEL.get(model_key, [])
        # Always prefer the tokenizer shipped with the fine-tuned model. A
        # fallback tokenizer is only accepted when its vocabulary is genuinely
        # compatible; _sync_tokenizer_and_model_vocab enforces that invariant.
        tokenizer_sources = [model_name, *fallback_sources]

        attempts = [
            *[
                (lambda src=src: AutoTokenizer.from_pretrained(
                    src, use_fast=False, tokenizer_file=None
                ))
                for src in tokenizer_sources
            ],
            *[
                (lambda src=src: XLMRobertaTokenizer.from_pretrained(
                    src, tokenizer_file=None
                ))
                for src in tokenizer_sources
            ],
            *[
                (lambda src=src: AutoTokenizer.from_pretrained(src))
                for src in tokenizer_sources
            ],
            *[
                (lambda src=src: XLMRobertaTokenizerFast.from_pretrained(src))
                for src in tokenizer_sources
            ],
        ]

        last_error = None
        for load in attempts:
            try:
                return load()
            except Exception as exc:
                last_error = exc

        try:
            import sentencepiece  # noqa: F401
        except ImportError as exc:
            raise RuntimeError("sentencepiece is required by the configured tokenizer") from exc

        for load in attempts:
            try:
                return load()
            except Exception as exc:
                last_error = exc
        raise last_error

    def __call__(self, text: str, top_k=None):
        try:
            inputs = self._tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
            self._ensure_input_ids_fit_model(inputs)
            inputs = {k: v.to(self._device) for k, v in inputs.items()}
            with self._torch.no_grad():
                logits = self._model(**inputs).logits
        except Exception:
            if not self._move_to_cpu():
                raise
            inputs = self._tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
            self._ensure_input_ids_fit_model(inputs)
            inputs = {k: v.to(self._device) for k, v in inputs.items()}
            with self._torch.no_grad():
                logits = self._model(**inputs).logits
        probs = self._torch.nn.functional.softmax(logits, dim=-1)[0].cpu().tolist()
        results = [{"label": self._id2label[i], "score": float(p)} for i, p in enumerate(probs)]
        if top_k is not None:
            results = sorted(results, key=lambda x: x["score"], reverse=True)[:top_k]
        return results


class _DirectZeroShotClassifier:
    """NLI-based zero-shot classifier without using pipeline()."""
    def __init__(self, model_name: str, device):
        import torch
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        self._torch = torch
        self._tokenizer = AutoTokenizer.from_pretrained(model_name)
        self._model = _from_pretrained_safe(AutoModelForSequenceClassification, model_name)
        self._model.to(device)
        self._model.eval()
        label2id = {str(v).lower(): int(k) for k, v in self._model.config.id2label.items()}
        self._entailment_id = label2id.get("entailment", 2)
        self._device = device

    def __call__(self, text: str, candidate_labels: List[str], hypothesis_template: str = "This example is {}.", multi_label: bool = False) -> Dict[str, Any]:
        scores: List[float] = []
        for label in candidate_labels:
            hypothesis = hypothesis_template.format(label)
            inputs = self._tokenizer(text, hypothesis, return_tensors="pt", truncation=True, max_length=512)
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
    """Fine-tuned PhoBERT classifier for time_label (short-term / long-term).

    Loaded from the local model path configured in .env.
    When unavailable, the pipeline returns "amb" for time_label.
    """

    def __init__(self, model_path: str, device):
        # sentencepiece is required by PhoBERT's BPE tokenizer
        import sentencepiece  # noqa: F401

        import torch
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        self._torch = torch

        # HuggingFace Trainer không tự lưu tokenizer, nên thư mục fine-tuned
        # có thể thiếu tokenizer_config.json / vocab.txt / bpe.codes.
        # Fine-tuning không thay đổi vocabulary → dùng base tokenizer là đúng.
        self._requested_device = device
        # Time-label inference is small, and CUDA device-side asserts poison the
        # whole notebook runtime. Keep this classifier on CPU so tokenizer/model
        # mismatches surface as readable Python errors instead of CUDA asserts.
        self._device = torch.device("cpu")
        self._tokenizer_source = model_path

        try:
            self._tokenizer = AutoTokenizer.from_pretrained(model_path, use_fast=False)
        except Exception:
            self._tokenizer_source = "vinai/phobert-base"
            self._tokenizer = AutoTokenizer.from_pretrained("vinai/phobert-base", use_fast=False)

        self._model = _from_pretrained_safe(AutoModelForSequenceClassification, model_path)
        self._model.to(self._device)
        self._model.eval()
        self._id2label = {int(k): str(v) for k, v in self._model.config.id2label.items()}
        embeddings = self._model.get_input_embeddings()
        self._model_vocab_size = int(getattr(embeddings, "num_embeddings", 0) or 0)
        self._tokenizer_vocab_size = int(getattr(self._tokenizer, "vocab_size", 0) or 0)

    def __call__(self, text: str) -> Dict[str, float]:
        inputs = self._tokenizer(text, return_tensors="pt", truncation=True, max_length=256)
        if self._model_vocab_size and "input_ids" in inputs:
            max_token_id = int(inputs["input_ids"].max().item())
            if max_token_id >= self._model_vocab_size:
                raise ValueError(
                    "PhoBERT tokenizer/model vocab mismatch: "
                    f"max_input_id={max_token_id}, "
                    f"model_vocab_size={self._model_vocab_size}, "
                    f"tokenizer_source={self._tokenizer_source}, "
                    f"tokenizer_vocab_size={self._tokenizer_vocab_size}. "
                    "Save the tokenizer with the fine-tuned checkpoint, or use the "
                    "same base tokenizer that was used during training."
                )
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with self._torch.no_grad():
            logits = self._model(**inputs).logits
        probs = self._torch.nn.functional.softmax(logits, dim=-1)[0].cpu().tolist()
        return {self._id2label[i]: float(p) for i, p in enumerate(probs)}


class TopicE5Classifier:
    """Zero-shot topic classifier using intfloat/multilingual-e5-small.

    E5 models are trained for query-document retrieval, which maps directly to
    "does this review belong to this topic?" — a much better fit than NLI entailment
    or paraphrase detection. No fine-tuning required; topic descriptions in Vietnamese
    with full diacritics give good zero-shot accuracy across domains.
    """

    def __init__(
        self,
        use_pretrained_classifiers: bool,
        model_name: str,
        model_device: str = "cpu",
    ):
        self.active = False
        self.error: Optional[str] = None
        self.last_error: Optional[str] = None
        self._model = None
        self._tokenizer = None
        self._torch = None
        self._label_embs = None  # cached after first call

        if not use_pretrained_classifiers:
            return
        try:
            import torch
            from transformers import AutoTokenizer, AutoModel
            _device = resolve_torch_device(torch, model_device)
            self._tokenizer = AutoTokenizer.from_pretrained(model_name)
            self._model = _from_pretrained_safe(AutoModel, model_name)
            self._model.to(_device)
            self._model.eval()
            self._torch = torch
            self._device = _device
            self.active = True
        except Exception as exc:
            self.error = str(exc)

    def _move_to_cpu(self) -> bool:
        if self._torch is None or self._model is None:
            return False
        if str(getattr(self, "_device", "")) == "cpu":
            return False
        try:
            self._device = self._torch.device("cpu")
            self._model.to(self._device)
            self._label_embs = None
            return True
        except Exception as exc:
            self.last_error = str(exc)
            return False

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
            # Pre-compute once; "passage: " prefix per E5 convention.
            passages = [f"passage: {desc}" for desc in TOPIC_E5_DESCRIPTIONS.values()]
            embs = self._encode(passages)
            self._label_embs = {
                topic: embs[i] for i, topic in enumerate(TOPIC_E5_DESCRIPTIONS)
            }
        return self._label_embs

    def predict(self, raw_text: str) -> Optional[Dict[str, float]]:
        """Return softmax-normalised topic scores using E5 cosine similarity."""
        if not self.active or self._model is None:
            return None
        try:
            import math
            label_embs = self._get_label_embeddings()
            raw_scores = self._score_document(raw_text, label_embs)
            # Temperature-scaled softmax. Lower temperature = more concentrated distribution
            # (winner-take-all). With topic labels plus "other" and E5 cosine similarities
            # clustered in [0.78, 0.92], T=0.07 gives the winner ~30-60% probability,
            # which is necessary so the score clears the topic_other_threshold check.
            # T=0.15 spreads scores too evenly (~15-25% for winner), causing most reviews
            # to fall below the threshold and be misclassified as "other".
            temperature = 0.07
            exp_scores = {t: math.exp(s / temperature) for t, s in raw_scores.items()}
            total = sum(exp_scores.values()) or 1.0
            return {t: v / total for t, v in exp_scores.items()}
        except Exception as exc:
            self.last_error = str(exc)
            if self._move_to_cpu():
                try:
                    import math
                    label_embs = self._get_label_embeddings()
                    raw_scores = self._score_document(raw_text, label_embs)
                    temperature = 0.07
                    exp_scores = {t: math.exp(s / temperature) for t, s in raw_scores.items()}
                    total = sum(exp_scores.values()) or 1.0
                    self.last_error = None
                    return {t: v / total for t, v in exp_scores.items()}
                except Exception as exc2:
                    self.last_error = str(exc2)
            return None

    def _score_document(self, raw_text: str, label_embs) -> Dict[str, float]:
        """Score a review hierarchically instead of truncating it as one document.

        Reviews frequently start with access/location details and discuss the real
        experience later.  A single 512-token embedding therefore overweights the
        beginning and can turn an activity/atmosphere review into ``infra``.  We
        embed coherent chunks, then combine document-level context with the best
        and average chunk evidence.  This is domain-independent and also preserves
        short-review behaviour (there is only one chunk in that case).
        """
        text = (
            str(raw_text or "")
            .replace("\\r\\n", "\n")
            .replace("\\n", "\n")
            .strip()
        )
        if not text:
            return {topic: 0.0 for topic in label_embs}

        paragraphs = [p.strip() for p in re.split(r"\n\s*\n+", text) if p.strip()]
        chunks: List[str] = []
        for paragraph in paragraphs or [text]:
            sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", paragraph) if s.strip()]
            current = ""
            for sentence in sentences or [paragraph]:
                if current and len(current) + len(sentence) > 700:
                    chunks.append(current)
                    current = sentence
                else:
                    current = f"{current} {sentence}".strip()
            if current:
                chunks.append(current)
        chunks = chunks[:12] or [text]

        # Keep a full-document vector for global context and chunk vectors for
        # late/local evidence.  The full text is deliberately capped by tokenizer.
        queries = [f"query: {text}"] + [f"query: {chunk}" for chunk in chunks]
        embeddings = self._encode(queries)
        scores: Dict[str, float] = {}
        for topic, label_emb in label_embs.items():
            document_score = float(self._torch.dot(embeddings[0], label_emb).cpu())
            chunk_scores = [
                float(self._torch.dot(chunk_emb, label_emb).cpu())
                for chunk_emb in embeddings[1:]
            ]
            best = max(chunk_scores)
            top = sorted(chunk_scores, reverse=True)[: min(3, len(chunk_scores))]
            top_mean = sum(top) / len(top)
            scores[topic] = 0.40 * document_score + 0.35 * top_mean + 0.25 * best
        return scores


class ClassifierProvider:
    def __init__(
        self,
        use_pretrained_classifiers: bool,
        sentiment_model_name: str,
        zeroshot_model_name: Optional[str],
        topic_model_name: str,
        confidence_threshold: float,
        ambiguity_margin: float,
        phobert_time_model_path: Optional[str] = None,
        model_device: str = "cpu",
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
        self.sentiment_last_error: Optional[str] = None
        self.zeroshot_error: Optional[str] = None
        self.phobert_time_error: Optional[str] = None
        self.phobert_time_last_error: Optional[str] = None

        if not use_pretrained_classifiers:
            return

        import torch
        _device = resolve_torch_device(torch, model_device)

        try:
            self.sentiment_pipeline = _DirectSentimentClassifier(sentiment_model_name, _device)
            self.sentiment_active = True
        except Exception as exc:
            self.sentiment_error = str(exc)

        if zeroshot_model_name:
            try:
                self.zeroshot_pipeline = _DirectZeroShotClassifier(zeroshot_model_name, _device)
                self.zeroshot_active = True
            except Exception as exc:
                self.zeroshot_error = str(exc)

        # E5 topic classifier loads independently — a failure doesn't block sentiment.
        self.topic_classifier = TopicE5Classifier(
            use_pretrained_classifiers,
            topic_model_name,
            model_device=model_device,
        )

        # Fine-tuned PhoBERT for time_label — optional, loaded only when path is given.
        if phobert_time_model_path:
            try:
                self.phobert_time_classifier = _PhoBERTTimeClassifier(phobert_time_model_path, _device)
                self.phobert_time_active = True
            except Exception as exc:
                self.phobert_time_error = str(exc)

    def predict_sentiment(self, text: str) -> Optional[Dict[str, float]]:
        """Supports models that output positive/neutral/negative labels directly."""
        if not self.sentiment_active or self.sentiment_pipeline is None:
            return None
        try:
            self.sentiment_last_error = None
            raw = self.sentiment_pipeline(text, top_k=None)
            rows = raw[0] if (isinstance(raw, list) and raw and isinstance(raw[0], list)) else (raw if isinstance(raw, list) else [raw])

            label_to_score: Dict[str, float] = {
                str(item.get("label", "")).lower().strip(): float(item.get("score", 0.0))
                for item in rows
            }

            # Direct pos/neu/neg output. Supports labels used by ViSoBERT
            # (Negative/Positive/Neutral), PhoBERT sentiment (NEG/POS/NEU),
            # and fallback LABEL_0/1/2 configs where 0=negative, 1=positive, 2=neutral.
            pos = (
                label_to_score.get("positive", 0.0)
                + label_to_score.get("pos", 0.0)
                + label_to_score.get("label_1", 0.0)
            )
            neu = (
                label_to_score.get("neutral", 0.0)
                + label_to_score.get("neu", 0.0)
                + label_to_score.get("label_2", 0.0)
            )
            neg = (
                label_to_score.get("negative", 0.0)
                + label_to_score.get("neg", 0.0)
                + label_to_score.get("label_0", 0.0)
            )
            total = pos + neu + neg
            if total > 0:
                return {"positive": pos / total, "neutral": neu / total, "negative": neg / total}

            # Fallback: star-rating output (e.g. nlptown/bert-base-multilingual-uncased-sentiment).
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
        except Exception as exc:
            self.sentiment_last_error = str(exc)
            return None

    def predict_topic(self, text: str) -> Optional[Dict[str, float]]:
        if not self.zeroshot_active or self.zeroshot_pipeline is None:
            return None

        core_topics = list(TOPIC_LABEL_MAP_VI.keys())
        labels_vi = [TOPIC_LABEL_MAP_VI[t] for t in core_topics]
        try:
            result = self.zeroshot_pipeline(
                text,
                labels_vi,
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

    def _canonical_time_label(self, label: str) -> Optional[str]:
        norm = normalize_text(str(label).replace("_", " ").replace("-", " "))
        if norm in {"short term", "shortterm", "ngan han", "temporary"}:
            return "short-term"
        if norm in {"long term", "longterm", "dai han", "stable"}:
            return "long-term"
        return None

    def predict_time_label(self, text: str) -> Optional[Tuple[str, Optional[Dict[str, str]]]]:
        """Returns (time_label, error_info), or None only when PhoBERT is not loaded."""
        if not self.phobert_time_active or self.phobert_time_classifier is None:
            return None
        try:
            self.phobert_time_last_error = None
            scores = self.phobert_time_classifier(text)
            sorted_items = sorted(scores.items(), key=lambda x: x[1], reverse=True)
            top_label, top_score = sorted_items[0]
            second_score = sorted_items[1][1] if len(sorted_items) > 1 else 0.0
            margin = top_score - second_score
            canonical_label = self._canonical_time_label(top_label)

            if canonical_label is None:
                return (
                    "amb",
                    {
                        "code": "unknown_phobert_label",
                        "predicted_label": str(top_label),
                        "score": f"{top_score:.4f}",
                        "all_scores": json.dumps(scores, ensure_ascii=False),
                        "message": "PhoBERT đã chạy nhưng nhãn trả về không phải short-term/long-term. Kiểm tra id2label trong config của checkpoint.",
                    },
                )

            required_confidence = self.confidence_threshold

            if top_score < required_confidence:
                return (
                    "amb",
                    {
                        "code": "weak_temporal_signal_phobert",
                        "predicted_label": canonical_label,
                        "raw_label": str(top_label),
                        "score": f"{top_score:.4f}",
                        "required_confidence": f"{required_confidence:.4f}",
                        "message": f"PhoBERT không đủ tự tin (score={top_score:.2f}) để phân loại ngắn hạn hay dài hạn.",
                    },
                )
            if margin < self.ambiguity_margin:
                return (
                    "amb",
                    {
                        "code": "conflicting_time_anchor_phobert",
                        "predicted_label": canonical_label,
                        "raw_label": str(top_label),
                        "score": f"{top_score:.4f}",
                        "second_score": f"{second_score:.4f}",
                        "required_margin": f"{self.ambiguity_margin:.4f}",
                        "message": f"PhoBERT không phân biệt rõ (margin={margin:.2f}) ngắn hạn hay dài hạn.",
                    },
                )
            return canonical_label, None
        except Exception as exc:
            self.phobert_time_last_error = str(exc)
            return (
                "amb",
                {
                    "code": "phobert_inference_error",
                    "message": "PhoBERT đã load nhưng lỗi khi chạy inference time_label.",
                    "detail": str(exc),
                },
            )


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

class ReviewFilteringPipeline:
    def __init__(
        self,
        config: PipelineConfig,
        supabase_client: Optional[Any] = None,
        embedding_provider: Optional[EmbeddingProvider] = None,
        classifier_provider: Optional[ClassifierProvider] = None,
    ):
        self.config = config
        self.supabase = supabase_client
        if self.supabase is None and config.supabase_url and config.supabase_key:
            if create_client is None:
                raise ImportError("supabase-py not installed. Run: pip install supabase")
            self.supabase = create_client(config.supabase_url, config.supabase_key)
        self.embedding_provider = embedding_provider or EmbeddingProvider(
            use_pretrained_model=config.use_pretrained_model,
            model_name=config.embedding_model_name,
        )
        self.classifier_provider = classifier_provider or ClassifierProvider(
            use_pretrained_classifiers=config.use_pretrained_classifiers,
            sentiment_model_name=config.sentiment_model_name,
            zeroshot_model_name=config.zeroshot_model_name,
            topic_model_name=config.topic_model_name,
            confidence_threshold=config.classifier_confidence_threshold,
            ambiguity_margin=config.classifier_ambiguity_margin,
            phobert_time_model_path=config.phobert_time_model_path,
        )
        # These two settings can change in the database without invalidating
        # the cached model weights.
        self.classifier_provider.confidence_threshold = config.classifier_confidence_threshold
        self.classifier_provider.ambiguity_margin = config.classifier_ambiguity_margin
        self.algorithm3_historical_updates: List[Dict[str, Any]] = []
        self.algorithm3_result: Dict[str, Any] = {}

    def _table(self, name: str):
        if self.supabase is None:
            raise RuntimeError("Supabase client is not configured for this pipeline instance")
        return self.supabase.schema(self.config.supabase_schema).table(name)

    def run(
        self,
        reviews: Optional[List[Dict[str, Any]]] = None,
    ) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]]]:
        owns_io = reviews is None
        if reviews is None:
            reviews = self._read_input_reviews()

        contents = self.algorithm_1_classify_reviews(reviews)
        conflicts, algorithm2_meta = self.algorithm_2_detect_conflicts(contents)
        time_result = self.algorithm_small_time_management(contents, conflicts, algorithm2_meta)
        # Keep the detailed Algorithm 3 decisions available to the service
        # layer. The public run response only contains aggregate counters, but
        # persistence needs the exact expired, hidden and promoted content IDs.
        self.algorithm3_result = time_result

        if owns_io:
            self._upsert_review_contents(contents)
            self._insert_review_conflicts(conflicts)
            self._mark_conflicted_contents(conflicts)

        if self.config.save_json:
            self._write_json("algorithm1_review_contents.json", contents)
            self._write_json("algorithm2_review_conflicts.json", conflicts)
            self._write_json("algorithm3_time_management.json", time_result)

        report = {
            "generated_at": to_iso(self.config.now),
            "input_label": self.config.input_label,
            "output_dir": str(self.config.output_dir),
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
            "algorithm2_input_summary": algorithm2_meta,
            "algorithm3_promotion_mode": self.config.promotion_mode,
        }
        return report, contents, conflicts

    def _write_json(self, file_name: str, payload: Any) -> None:
        self.config.output_dir.mkdir(parents=True, exist_ok=True)
        output_path = self.config.output_dir / file_name
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

    def _ttl_hours_for_topic(self, topic: str, fallback: int = 48) -> int:
        values = self.config.ttl_hours_by_topic or TTL_HOURS_BY_TOPIC
        return int(values.get(topic, fallback))

    def _observation_rule_for_topic(self, topic: str) -> Dict[str, Any]:
        values = self.config.observation_rules or OBSERVATION_RULES
        return values.get(topic, values.get("other", OBSERVATION_RULES["other"]))

    def _lookback_multiplier_for_topic(self, topic: str) -> int:
        values = self.config.lookback_multiplier_by_topic or ALGORITHM2_LOOKBACK_MULTIPLIER_BY_TOPIC
        return int(values.get(topic, self.config.old_lookback_multiplier))

    def _max_observation_window_days(self) -> int:
        rules = self.config.observation_rules or OBSERVATION_RULES
        return max(1, max(int(rule.get("window_days", 1)) for rule in rules.values()))

    def _load_recent_short_terms_for_algorithm3(self) -> List[Dict[str, Any]]:
        """Load DB history already bounded by Algorithm 3's largest window."""
        if self.supabase is None:
            return []

        lower_bound = self.config.now - timedelta(
            days=self._max_observation_window_days()
        )
        rows: List[Dict[str, Any]] = []
        offset = 0
        batch_size = max(1, int(self.config.supabase_batch_size))

        while True:
            response = (
                self._table("review_contents")
                .select(
                    "id,content,processing_status,time_label,expiration_date,main_topic,"
                    "topic_scores,sentiment_scores,embedding,error_info,has_conflict,"
                    "is_temporary,reviews!inner(id,place_id,created_at,rating)"
                )
                .eq("time_label", "short-term")
                .gte("reviews.created_at", to_iso(lower_bound))
                .range(offset, offset + batch_size - 1)
                .execute()
            )
            payload = response.data or []
            if not payload:
                break
            for row in payload:
                if not row.get("embedding"):
                    continue
                review_row = row.get("reviews") or {}
                if isinstance(review_row, list):
                    review_row = review_row[0] if review_row else {}
                rows.append(self._map_db_content_row(row, review_row))
            if len(payload) < batch_size:
                break
            offset += batch_size

        return rows

    def _read_input_reviews(self) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        offset = 0
        batch_size = max(1, int(self.config.supabase_batch_size))
        limit = self.config.supabase_limit

        while True:
            end = offset + batch_size - 1
            if limit is not None:
                remaining = int(limit) - len(rows)
                if remaining <= 0:
                    break
                end = offset + min(batch_size, remaining) - 1

            response = (
                self._table("review_contents")
                .select("id,content,processing_status,reviews!inner(id,place_id,created_at,rating)")
                .eq("processing_status", "pending")
                .range(offset, end)
                .execute()
            )
            payload = response.data or []
            if not payload:
                break

            for row in payload:
                review_row = row.get("reviews") or {}
                if isinstance(review_row, list):
                    review_row = review_row[0] if review_row else {}
                rows.append({
                    "content_db_id": row.get("id"),
                    "content": row.get("content"),
                    "processing_status": row.get("processing_status"),
                    "review_id": review_row.get("id"),
                    "place_id": review_row.get("place_id"),
                    "created_at": review_row.get("created_at"),
                    "stars": review_row.get("rating"),
                })

            if len(payload) < (end - offset + 1):
                break
            offset = end + 1

        return rows

    def _load_historical_long_terms(self) -> List[Dict[str, Any]]:
        if self.supabase is None:
            return []
        rows: List[Dict[str, Any]] = []
        offset = 0
        batch_size = max(1, int(self.config.supabase_batch_size))

        while True:
            response = (
                self._table("review_contents")
                .select(
                    "id,content,processing_status,time_label,expiration_date,main_topic,"
                    "topic_scores,sentiment_scores,embedding,error_info,has_conflict,"
                    "is_temporary,reviews!inner(id,place_id,created_at,rating)"
                )
                .eq("time_label", "long-term")
                .range(offset, offset + batch_size - 1)
                .execute()
            )
            payload = response.data or []
            if not payload:
                break
            for row in payload:
                if not row.get("embedding"):
                    continue
                review_row = row.get("reviews") or {}
                if isinstance(review_row, list):
                    review_row = review_row[0] if review_row else {}
                rows.append(self._map_db_content_row(row, review_row))
            if len(payload) < batch_size:
                break
            offset += batch_size

        return rows

    def _map_db_content_row(
        self,
        row: Dict[str, Any],
        review_row: Dict[str, Any],
    ) -> Dict[str, Any]:
        return {
            "id": str(row.get("id")),
            "content_db_id": row.get("id"),
            "review_id": review_row.get("id"),
            "place_id": review_row.get("place_id"),
            "user_id": None,
            "content": row.get("content"),
            "stars": review_row.get("rating"),
            "created_at": review_row.get("created_at"),
            "processing_status": row.get("processing_status"),
            "time_label": row.get("time_label"),
            "expiration_date": row.get("expiration_date"),
            "main_topic": row.get("main_topic"),
            "topic_scores": row.get("topic_scores") or {},
            "sentiment_scores": row.get("sentiment_scores") or {},
            "embedding": self._coerce_embedding(row.get("embedding")),
            "error_info": row.get("error_info"),
            "has_conflict": bool(row.get("has_conflict")),
            "is_temporary": bool(row.get("is_temporary")),
        }

    def _coerce_embedding(self, value: Any) -> List[float]:
        if value is None:
            return []
        if isinstance(value, list):
            return [float(v) for v in value]
        if isinstance(value, str):
            stripped = value.strip().strip("[]")
            if not stripped:
                return []
            return [float(v) for v in stripped.split(",") if v.strip()]
        return []

    def _upsert_review_contents(self, contents: List[Dict[str, Any]]) -> None:
        payloads = []
        for content in contents:
            content_db_id = content.get("content_db_id") or content.get("id")
            if not content_db_id:
                continue
            payloads.append({
                "id": content_db_id,
                "time_label": content.get("time_label"),
                "expiration_date": content.get("expiration_date"),
                "main_topic": content.get("main_topic"),
                "topic_scores": content.get("topic_scores"),
                "sentiment_scores": content.get("sentiment_scores"),
                "embedding": content.get("embedding"),
                "error_info": content.get("error_info"),
                "has_conflict": bool(content.get("has_conflict")),
                "is_temporary": bool(content.get("is_temporary")),
                "processing_status": "processed",
            })

        for start in range(0, len(payloads), self.config.supabase_batch_size):
            chunk = payloads[start:start + self.config.supabase_batch_size]
            if chunk:
                self._table("review_contents").upsert(chunk, on_conflict="id").execute()

    def _insert_review_conflicts(self, conflicts: List[Dict[str, Any]]) -> None:
        if not conflicts:
            return
        payloads = [
            {
                "id": conflict.get("id") or str(uuid.uuid4()),
                "new_content_id": conflict.get("new_content_id"),
                "old_content_id": conflict.get("old_content_id"),
                "conflict_score": conflict.get("conflict_score"),
                "conflict_topic": conflict.get("conflict_topic"),
                "created_at": conflict.get("created_at"),
            }
            for conflict in conflicts
        ]
        for start in range(0, len(payloads), self.config.supabase_batch_size):
            chunk = payloads[start:start + self.config.supabase_batch_size]
            self._table("review_conflicts").insert(chunk).execute()

    def _mark_conflicted_contents(self, conflicts: List[Dict[str, Any]]) -> None:
        conflict_ids = {
            cid
            for conflict in conflicts
            for cid in (conflict.get("new_content_id"), conflict.get("old_content_id"))
            if cid
        }
        for content_id in conflict_ids:
            (
                self._table("review_contents")
                .update({"has_conflict": True})
                .eq("id", content_id)
                .execute()
            )

    def _resolve_review_created_at(self, review: Dict[str, Any], idx: int) -> datetime:
        raw_created_at = review.get("created_at")
        if isinstance(raw_created_at, str) and raw_created_at.strip():
            parsed = parse_iso(raw_created_at.strip())
            if parsed is not None:
                return parsed
        return self.config.now + timedelta(seconds=idx)

    # --- Algorithm 1: Classify reviews ---

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

                place_id = review.get("place_id") or review.get("business_id")

                outputs.append({
                    "id": str(review["content_db_id"]),
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
                    "id": str(review["content_db_id"]),
                    "review_id": review.get("review_id"),
                    "place_id": review.get("place_id") or review.get("business_id"),
                    "user_id": review.get("user_id"),
                    "content": str(review.get("content", review.get("text_vi", ""))),
                    "stars": review.get("stars"),
                    "created_at": to_iso(review_created_at),
                    "processing_status": "processed",
                    "time_label": "amb",
                    "expiration_date": None,
                    "main_topic": "other",
                    "topic_scores": {**{k: 0.0 for k in TOPIC_KEYWORDS}, "other": 1.0},
                    "sentiment_scores": {"other": {"positive": 0.0, "neutral": 1.0, "negative": 0.0}},
                    "embedding": [0.0] * DEFAULT_EMBEDDING_DIM,
                    "error_info": {
                        "code": "processing_exception",
                        "message": str(exc),
                        "detail": "Lỗi xử lý review. Không thể xác định time_label.",
                    },
                    "has_conflict": False,
                    "is_temporary": False,
                })
        return outputs

    def _apply_topic_decision_adjustments(
        self,
        scores: Dict[str, float],
        keyword_raw: Dict[str, float],
        norm_text: str = "",
        title_norm: str = "",
    ) -> Dict[str, float]:
        """Use strong lexical evidence to break close E5/prototype topic ties.

        E5 often spreads probability across semantically related travel topics
        (activity, atmosphere, food). Keyword evidence is sparse but precise, so
        we use it as a conservative post-blend correction rather than replacing
        the semantic classifier.
        """
        adjusted = dict(scores)

        def ev(topic: str) -> float:
            return float(keyword_raw.get(topic, 0.0))

        activity = ev("activity")
        atmosphere = ev("atmosphere")
        food = ev("food")
        service = ev("service")
        price = ev("price")
        infra = ev("infra")
        crowd = ev("crowd")
        traffic = ev("traffic")
        weather = ev("weather")
        cleanliness = ev("cleanliness")
        traffic_pattern = any(
            phrase in norm_text
            for phrase in (
                "ket xe", "tac duong", "un tac", "giao thong", "tac nghen",
                "xe may chen", "o to noi duoi", "oto noi duoi", "coi xe",
                "duong dong", "dong xe", "xe co dong", "gio cao diem",
            )
        )
        heavy_traffic_pattern = any(
            phrase in norm_text
            for phrase in (
                "ket xe", "tac duong", "un tac", "giao thong", "tac nghen",
                "dong nghet", "xe may chen chuc", "o to noi duoi",
                "oto noi duoi", "dung cho den do", "hit khoi bui",
            )
        )
        parking_infra_pattern = any(
            phrase in norm_text
            for phrase in (
                "bai do xe", "bai xe", "cho dau xe", "cho do xe",
                "gui xe", "giu xe", "phi gui xe", "bai giu xe",
                "khong co cho dau xe", "kho tim bai xe", "ham gui xe",
            )
        )
        weather_pattern = any(
            phrase in norm_text
            for phrase in (
                "thoi tiet", "troi mua", "mua lon", "mua phun", "mua bat chot",
                "troi nang", "nang nong", "nang gat", "nang gay", "troi lanh",
                "lanh gia", "se lanh", "gio lon", "gio manh", "bao", "ngap nuoc",
                "troi dep", "troi xau", "troi u am", "oi buc", "mat me",
                "am u", "xam xit", "mua rao", "mua to", "mua bat ngo",
                "nang qua", "nang kinh khung",
            )
        )
        heavy_weather_pattern = any(
            phrase in norm_text
            for phrase in (
                "troi mua", "mua lon", "mua bat chot", "nang nong",
                "nang gat", "lanh gia", "gio lon", "gio manh", "bao",
                "ngap nuoc", "troi xau", "troi u am", "xam xit",
                "mua rao", "mua phun", "mua trai mua", "mua do xuong",
                "am u", "mua to", "mua bat ngo",
                "nang qua", "nang kinh khung",
            )
        )
        title_weather_pattern = any(
            phrase in title_norm
            for phrase in (
                "troi mua", "mua lon", "mua rao", "mua trai mua",
                "gio lon", "gio manh", "nang nong", "troi u am",
                "thoi tiet xau", "ngap nuoc",
                "am u", "nang qua", "nang kinh khung", "mua cai la",
                "dinh mua trai mua", "mua bat chot", "mua bat ngo",
            )
        )
        dominant_weather_pattern = heavy_weather_pattern and (
            title_weather_pattern or weather >= 2.00
        )
        cleanliness_pattern = any(
            phrase in norm_text
            for phrase in (
                "sach se", "ve sinh", "nha ve sinh", "toilet", "wc", "phong tam",
                "mui hoi", "hoi ham", "hoi thoi", "rac", "bui bam", "am moc",
                "ban ghe ban", "san ban", "chen dia ban", "ly ban", "con trung",
                "ruoi", "muoi", "kien", "gian",
            )
        )
        strong_cleanliness_pattern = any(
            phrase in norm_text
            for phrase in (
                "nha ve sinh ban", "toilet ban", "wc ban", "mui hoi",
                "hoi ham", "hoi thoi", "rac thai", "rac day", "am moc",
                "khong ve sinh", "kem ve sinh", "con trung", "ruoi",
            )
        )
        price_false_positive = any(
            phrase in norm_text
            for phrase in (
                "danh gia cao", "duoc danh gia cao", "review cao",
            )
        )
        price_amount_count = len(
            re.findall(r"\b\d+\s*(?:k|ngan|nghin|trieu|vnd)\b", norm_text)
        ) + len(re.findall(r"\b\d{2,3}\s?000\b", norm_text))
        price_amount_pattern = price_amount_count > 0
        standalone_price_word = (
            bool(re.search(r"\bgia\b", norm_text))
            and not any(
                phrase in norm_text
                for phrase in (
                    "danh gia", "duoc danh gia", "review gia", "gia dinh", "gia vi",
                    "nguoi gia", "cu gia", "khi gia", "gia yeu", "gia tre", "gia ca roi",
                )
            )
        )
        # Free-entry mentions ("vào cửa miễn phí", "không thu phí") are usually an
        # incidental perk inside a venue/infra description, not the review focus.
        free_entry_pattern = any(
            phrase in norm_text
            for phrase in (
                "mien phi", "khong ton phi", "khong tinh phi", "khong mat phi",
                "khong thu phi", "khong co thu phi", "khong ton tien ve",
            )
        )
        # Judgmental price language — the reviewer is evaluating cost, not just
        # listing amounts as visit information.
        price_eval_pattern = any(
            phrase in norm_text
            for phrase in (
                "qua dat", "dat qua", "gia cao", "gia qua cao", "gia hoi cao",
                "muc gia cao", "kha mac", "hoi mac", "qua mac", "gia mac",
                "cung mac", "khong re", "khong thay re", "gia re", "re hon",
                "re lam", "binh dan", "gia hop ly", "gia tot", "gia phai chang",
                "phai chang", "dang dong tien", "khong dang tien",
                "khong xung dang", "tra gia", "gia thach",
                # NOTE: "mat tien" (mất tiền) is intentionally absent — it also
                # matches "mặt tiền" (facade); "hoa don" also matches "hoá đồng".
                "kha thach", "cat co", "chat chem", "ton tien",
                "uu dai", "khuyen mai", "giam gia",
                "so voi ngay thuong", "xuat hoa don", "tinh hoa don", "bill",
            )
        ) or (
            bool(re.search(r"(?<!khong )(?<!chang )\bmac\b", norm_text))
            and "mac du" not in norm_text
        )
        explicit_price_pattern = any(
            phrase in norm_text
            for phrase in (
                "phi vao cua", "gia ve", "gia vao", "gia phong",
                "gia menu", "mat phi", "ton tien", "bao nhieu tien",
                "muc gia", "gia cao", "gia hoi cao", "gia qua cao",
                "so voi ngay thuong", "qua dat", "khong qua dat",
                "gia ca", "gia tien", "gia hop ly", "gia re", "dat qua",
                "re qua", "gia mac", "qua mac", "khong qua mac", "kha mac",
                "hoi mac", "xung dang", "dang dong tien", "phi dich vu",
            )
        ) or standalone_price_word
        price_pattern = price_amount_pattern or explicit_price_pattern or free_entry_pattern
        if price_false_positive:
            price_pattern = False
        # Strong price now requires evaluative language or a review that is
        # essentially a price listing (many amounts). A couple of amounts quoted
        # as visit information in a venue/tour review is not enough.
        strong_price_pattern = (
            price_eval_pattern or price_amount_count >= 4
        ) and not price_false_positive
        infra_pattern = any(
            phrase in norm_text
            for phrase in (
                "duong di", "duong vao", "duong len", "loi vao",
                "bang chi dan", "bien chi dan", "chi dan", "bien bao",
                "ghep ghenh", "doc dung", "kho tim duong", "hoi duong",
                "kho di", "de tim", "kho tim", "hem nho", "ngo nho",
                "duong nho", "duong da", "da tang", "duong sat", "duong tron",
                "cua vao", "cong vao", "bai xe", "bai do xe", "cho dau xe",
                "cho do xe", "cau thang", "hanh lang", "trang thiet bi",
                "co so vat chat", "may lanh", "dieu hoa", "wifi", "thang may",
            )
        )
        heavy_infra_pattern = any(
            phrase in norm_text
            for phrase in (
                "duong kho", "duong xau", "ghep ghenh", "doc dung",
                "bai xe", "bai do xe", "cho dau xe", "cho do xe",
                "bien chi dan", "bang chi dan", "khong co bang", "khong co bien",
                "cau thang", "hanh lang", "trang thiet bi", "co so vat chat",
                "may lanh", "dieu hoa", "wifi", "thang may", "sua chua",
                "nang cap", "xuong cap",
            )
        )
        soft_infra_pattern = any(
            phrase in norm_text
            for phrase in (
                "cho ngoi", "ghe ngoi", "ban ghe", "mat bang", "loi di",
                "khu vuc", "phong oc", "khong gian rong", "khong gian chat",
                "san nha", "mai che", "toa nha", "trung tam", "tang ham",
                "ham gui xe", "cua hang nho", "quan nho", "quan rong",
            )
        )
        access_infra_pattern = any(
            phrase in norm_text
            for phrase in (
                "duong vao", "duong len", "duong di", "loi vao", "loi di",
                "cua vao", "cong vao", "kho tim duong", "hoi duong",
                "bang chi dan", "bien chi dan", "chi dan", "bien bao",
                "hem nho", "ngo nho", "duong nho", "duong xau", "duong kho",
                "doc dung", "ghep ghenh", "da tang", "duong tron",
            )
        )
        facility_infra_pattern = any(
            phrase in norm_text
            for phrase in (
                "co so vat chat", "trang thiet bi", "thang may", "may lanh",
                "dieu hoa", "wifi", "internet", "ban ghe", "ghe ngoi",
                "phong oc", "khuon vien", "toa nha", "san nha", "mai che",
                "am thanh", "anh sang", "loa", "man hinh", "dien nuoc",
                "dong cua", "sua chua", "thi cong", "nang cap", "xuong cap",
            )
        )
        clear_infra_pattern = (
            heavy_infra_pattern
            or parking_infra_pattern
            or access_infra_pattern
            or facility_infra_pattern
        )
        address_only_infra_pattern = any(
            phrase in norm_text
            for phrase in (
                "de tim", "kho tim", "nam trong ngo", "trong ngo", "dia chi",
                "doi dien", "chuyen ve", "gan nha", "kha gan", "pho luong dinh cua",
            )
        ) and not heavy_infra_pattern
        atmosphere_pattern = any(
            phrase in norm_text
            for phrase in (
                "view dep", "canh dep", "phong canh dep", "khung canh dep",
                "khong khi", "bau khong khi", "canh quan", "decor dep",
                "trang tri dep", "noi that dep", "kien truc dep",
                "lang man", "yen tinh", "am cung", "thoang mat",
                "goc chup anh", "diem check in", "song nuoc dep",
            )
        )
        # Explicit scenery praise: when this coexists with access-road/parking
        # mentions, the aesthetic experience is usually the review focus and the
        # road is just how the reviewer got there.
        scenic_praise_pattern = any(
            phrase in norm_text
            for phrase in (
                "canh dep", "dep tuyet", "tuyet dep", "view dep",
                "phong canh dep", "khung canh dep", "canh quan dep",
                "dep me", "dep lam", "view ho", "view song", "view nui",
                "ho dep", "nui dep", "non nuoc huu tinh",
            )
        )
        clear_crowd_pattern = any(
            phrase in norm_text
            for phrase in (
                "dong duc", "qua dong", "dong nguoi", "dong khach",
                "nhieu nguoi", "day nguoi", "xep hang", "cho doi",
                "hang dai", "cho hang tieng", "chen chuc", "chen lan",
                "qua tai", "kin cho", "het cho", "khong con cho",
                "gio cao diem", "cuoi tuan dong",
                "dong lam", "rat dong", "cang dong", "dong hon",
                "nguoi dong", "dong du khach", "dong nghet", "dong kin",
                "hon ca tieng", "gan ca tieng", "cho ca tieng",
                "doi ca tieng", "nguoi voi nguoi", "dong cuc",
            )
        )
        activity_pattern = any(
            phrase in norm_text
            for phrase in (
                "tham quan", "di tham quan", "di tour", "kham pha",
                "trai nghiem", "di thuyen", "di tau", "thue tau",
                "cheo thuyen", "di dao", "dao quanh", "vao vuon",
                "cho ca an",
            )
        )
        strong_activity_pattern = any(
            phrase in norm_text
            for phrase in (
                "di tour", "tour", "di thuyen", "di tau", "thue tau",
                "cheo thuyen", "choi", "tro choi", "khu vui choi",
                "workshop", "xem phim", "karaoke", "leo nui", "cam trai",
                "cau ca", "boi loi", "spa", "massage", "tu hai", "cho ca an",
            )
        )
        entertainment_pattern = any(
            phrase in norm_text
            for phrase in (
                "karaoke", "xem phim", "rap phim", "phim lotte", "tro choi",
                "khu vui choi", "leo nui", "cam trai", "cau ca", "boi loi",
            )
        )
        purchase_delivery_pattern = any(
            phrase in norm_text
            for phrase in (
                "dat mua", "giao len", "giao hang", "mua ve", "mua mang ve",
                "ship", "dat nhờ", "dat nho", "mua duoc",
            )
        )
        market_food_pattern = any(
            phrase in norm_text
            for phrase in (
                "cho ban", "dac san", "thuc pham", "rau cu", "thit ca",
                "mam", "bun ca", "bun rieu", "do an", "mon ngon", "an trua",
                "dau tam", "trai cay", "vuon dau",
            )
        )
        strong_food_phrases = [
                "pho", "pho bo", "bat pho", "com", "bun", "bun ca", "bun rieu",
                "banh chung", "gio cha", "cha ca", "xoi", "sua chua",
                "do an", "mon an", "thuc an", "do uong", "nuoc dung",
                "nuoc leo", "thit", "gan", "quay", "mam", "dac san",
                "an ngon", "ngon", "mem", "thom", "nhat", "man", "ngot",
        ]
        # Use token boundaries for short food words.  Raw substring matching made
        # ``pho`` match ``phong``, and ``gan`` match ``khong gian``/``gan day``,
        # stealing activity, atmosphere and infrastructure reviews.
        strong_food_pattern = count_keyword_hits(
            norm_text, strong_food_phrases
        ) > 0
        food_delivery_pattern = any(
            phrase in norm_text
            for phrase in (
                "dat do an", "dat banh", "dat gio", "dat cha", "dat tren now",
                "ship hang", "ship den", "goi ve", "goi mon ve", "dong goi",
                "hop day du", "mang ve",
            )
        )
        strong_service_pattern = any(
            phrase in norm_text
            for phrase in (
                "nhan vien", "tiep vien", "thai do phuc vu", "phuc vu",
                "phuc vu nhanh", "phuc vu cham", "chu quan", "quan chu",
                "ban hang", "chao moi", "tu van", "goi mon", "len mon",
                "ra mon", "order", "tiep khach", "xu ly", "khieu nai",
                "huong dan vien", "tour guide", "tai xe",
            )
        )
        service_complaint_pattern = any(
            phrase in norm_text
            for phrase in (
                "thai do", "thai do nv", "nhan vien kem", "nhan vien te",
                "do loi", "loi do khach", "khach khong chu y", "goi dien",
                "thieu mat", "thieu do", "khong dan khach", "dua hoa don",
                "thanh toan xong", "tra tien", "duoi khach", "noi chuyen voi khach",
                "thieu chuyen nghiep", "that vong ve thai do",
            )
        )
        weak_service_only = service == 1 and not strong_service_pattern

        if activity >= 2:
            adjusted["activity"] = adjusted.get("activity", 0.0) * 1.35
            if activity >= atmosphere + 1:
                adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.88
            if activity >= food + 2:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.82
            if strong_service_pattern and service >= 1:
                adjusted["service"] = adjusted.get("service", 0.0) * 1.30
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.88
        elif activity_pattern:
            adjusted["activity"] = adjusted.get("activity", 0.0) * 1.25
            if food <= 2:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.85
            if atmosphere <= activity + 1:
                adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.92
            if strong_service_pattern and service >= 1:
                adjusted["service"] = adjusted.get("service", 0.0) * 1.25
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.90
        elif entertainment_pattern:
            adjusted["activity"] = adjusted.get("activity", 0.0) * 1.45
            if service <= 1 and not strong_service_pattern:
                adjusted["service"] = adjusted.get("service", 0.0) * 0.80
            if infra <= 1:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.85

        if purchase_delivery_pattern and activity <= 1:
            adjusted["activity"] = adjusted.get("activity", 0.0) * 0.70
            if market_food_pattern or food >= 1:
                adjusted["food"] = adjusted.get("food", 0.0) * 1.20

        if strong_food_pattern and food >= 1:
            adjusted["food"] = adjusted.get("food", 0.0) * (1.45 if food_delivery_pattern else 1.30)
            if service <= 2:
                adjusted["service"] = adjusted.get("service", 0.0) * 0.86
            if activity <= 2:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.78
            if infra <= 2 and not (infra_pattern or heavy_infra_pattern or soft_infra_pattern):
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.72
            if atmosphere <= 2:
                adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.76

        if atmosphere >= 2 and not infra_pattern:
            adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 1.20
            if activity == 0:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.92
        elif atmosphere_pattern and not infra_pattern:
            adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 1.15

        # Food is easy to over-predict in long travel reviews that briefly mention
        # a snack/drink. Require stronger food evidence when another topic is clearer.
        if food == 0:
            adjusted["food"] = adjusted.get("food", 0.0) * 0.65
        elif food <= 1 and max(activity, atmosphere, service, infra) >= 2:
            adjusted["food"] = adjusted.get("food", 0.0) * 0.72
        elif food >= 3:
            adjusted["food"] = adjusted.get("food", 0.0) * 1.20

        if service >= 2:
            adjusted["service"] = adjusted.get("service", 0.0) * (1.55 if strong_service_pattern else 1.25)
            if food <= service:
                adjusted["food"] = adjusted.get("food", 0.0) * (0.92 if strong_food_pattern else 0.78)
            if infra <= service:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.82
            if activity <= service or strong_service_pattern:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.82
        elif service == 0:
            adjusted["service"] = adjusted.get("service", 0.0) * 0.75
        elif service == 1 and strong_service_pattern:
            adjusted["service"] = adjusted.get("service", 0.0) * 1.35
            if activity >= 1:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.88
            if food >= 1:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.90
            if infra >= 1:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.90
        elif weak_service_only and (activity >= 1 or infra >= 1 or atmosphere >= 2):
            adjusted["service"] = adjusted.get("service", 0.0) * 0.88

        if strong_service_pattern and service_complaint_pattern:
            adjusted["service"] = adjusted.get("service", 0.0) * 1.22
            adjusted["price"] = adjusted.get("price", 0.0) * 0.62
            adjusted["weather"] = adjusted.get("weather", 0.0) * 0.55
            if food <= max(service, 1):
                adjusted["food"] = adjusted.get("food", 0.0) * 0.82
            if activity <= max(service, 1):
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.78
            if infra <= max(service, 1):
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.82

        if ev("cleanliness") >= 1:
            adjusted["cleanliness"] = adjusted.get("cleanliness", 0.0) * 1.35
            adjusted["price"] = adjusted.get("price", 0.0) * 0.60
        else:
            adjusted["cleanliness"] = adjusted.get("cleanliness", 0.0) * 0.45
        if infra >= 2:
            adjusted["infra"] = adjusted.get("infra", 0.0) * (1.70 if (infra_pattern or heavy_infra_pattern) else 1.30)
            if infra_pattern or infra >= atmosphere + 1:
                adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.78
            if activity >= 1 and not strong_activity_pattern and not entertainment_pattern:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.80
        elif infra_pattern:
            adjusted["infra"] = adjusted.get("infra", 0.0) * 1.60
            adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.78
            if activity >= 1 and not strong_activity_pattern and not entertainment_pattern:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.78
        elif infra == 1 and (activity >= 1 or food >= 1 or atmosphere >= 1):
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.88
        if (heavy_infra_pattern or (infra_pattern and not address_only_infra_pattern)) and infra >= 1:
            adjusted["infra"] = adjusted.get("infra", 0.0) * 1.35
            adjusted["price"] = adjusted.get("price", 0.0) * 0.62
            if food <= 1 and not strong_food_pattern:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.88
            if activity <= 2 and not (strong_activity_pattern or entertainment_pattern):
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.78
        elif soft_infra_pattern and infra >= 1 and not atmosphere_pattern:
            adjusted["infra"] = adjusted.get("infra", 0.0) * 1.25
            if price_amount_pattern and not explicit_price_pattern:
                adjusted["price"] = adjusted.get("price", 0.0) * 0.75
            if activity >= 1 and not (strong_activity_pattern or entertainment_pattern):
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.85
        if address_only_infra_pattern and (strong_food_pattern or food >= 1 or price_pattern):
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.55
            if strong_food_pattern and food >= 1:
                adjusted["food"] = adjusted.get("food", 0.0) * 1.15
        if activity >= 2 and not infra_pattern:
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.86
        elif (strong_activity_pattern or entertainment_pattern) and infra <= 1:
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.82
        # "Miễn phí"/"không thu phí" with no price judgement or repeated amounts:
        # the review is about the venue itself, not its cost. Likewise a single
        # amount quoted inside a strongly activity/infra-focused review is visit
        # information, not a price evaluation.
        free_entry_only = (
            free_entry_pattern
            and not price_eval_pattern
            and price_amount_count == 0
        )
        incidental_amount_only = (
            price_amount_count <= 3
            and not price_eval_pattern
            and not free_entry_pattern
            and (
                (strong_activity_pattern and activity >= 2)
                or (clear_infra_pattern and infra >= 2)
            )
        )
        if free_entry_only or incidental_amount_only:
            adjusted["price"] = adjusted.get("price", 0.0) * 0.45
            if free_entry_only and infra >= 1:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 1.10
        if ev("price") >= 2:
            if price_false_positive:
                adjusted["price"] = adjusted.get("price", 0.0) * 0.70
            elif free_entry_only:
                pass  # already handled above; do not re-boost via keyword count
            elif heavy_infra_pattern or infra_pattern:
                adjusted["price"] = adjusted.get("price", 0.0) * (1.18 if strong_price_pattern else 0.85)
            elif price_amount_pattern and not price_eval_pattern and (activity >= 1 or food >= 1 or infra >= 1):
                adjusted["price"] = adjusted.get("price", 0.0) * 0.90
            elif strong_price_pattern:
                adjusted["price"] = adjusted.get("price", 0.0) * 1.60
            else:
                adjusted["price"] = adjusted.get("price", 0.0) * 1.15
        elif price_pattern and not (free_entry_only or incidental_amount_only):
            adjusted["price"] = adjusted.get("price", 0.0) * (1.55 if strong_price_pattern else 1.12)
            if food <= 1:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.90
            if activity <= 1:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.92
        if crowd >= 2.20:
            adjusted["crowd"] = adjusted.get("crowd", 0.0) * (1.85 if clear_crowd_pattern else 1.35)
            if not infra_pattern:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.90
            if not strong_activity_pattern:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.72
            if not atmosphere_pattern:
                adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.82
        elif 1 <= crowd < 2.20 and clear_crowd_pattern:
            adjusted["crowd"] = adjusted.get("crowd", 0.0) * 1.35
        if strong_service_pattern and ev("weather") <= 1:
            adjusted["weather"] = adjusted.get("weather", 0.0) * 0.60
        if ev("weather") >= 2:
            adjusted["weather"] = adjusted.get("weather", 0.0) * 1.25

        # Final evidence gates tuned from the manual confusion matrix:
        # traffic/weather/atmosphere were frequently absorbed by infra/food/price,
        # while food/infra were over-predicted. These rules only fire when lexical
        # evidence for the target topic is explicit enough to be a reliable tie-breaker.
        if heavy_traffic_pattern or (traffic >= 2 and traffic_pattern):
            adjusted["traffic"] = adjusted.get("traffic", 0.0) * 1.90
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.82
            adjusted["activity"] = adjusted.get("activity", 0.0) * 0.88
            adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.88
            if not explicit_price_pattern:
                adjusted["price"] = adjusted.get("price", 0.0) * 0.82
            if not strong_food_pattern:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.88
        elif traffic_pattern and traffic >= 1:
            adjusted["traffic"] = adjusted.get("traffic", 0.0) * 1.35
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.94
        elif parking_infra_pattern and infra >= 1:
            adjusted["traffic"] = adjusted.get("traffic", 0.0) * 0.55
            adjusted["infra"] = adjusted.get("infra", 0.0) * 1.35

        if dominant_weather_pattern or (weather >= 2.00 and weather_pattern and not atmosphere_pattern and not clear_infra_pattern):
            adjusted["weather"] = adjusted.get("weather", 0.0) * 1.65
            if not strong_food_pattern:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.78
            if not heavy_infra_pattern:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.82
            if not strong_activity_pattern:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.84
            if not atmosphere_pattern:
                adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.88
        elif weather_pattern and weather >= 1 and not atmosphere_pattern and not clear_infra_pattern:
            adjusted["weather"] = adjusted.get("weather", 0.0) * 1.20
            if not heavy_infra_pattern:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.94
            if food <= 1:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.86

        if (
            clear_infra_pattern
            and infra >= 1
            and not heavy_traffic_pattern
            and not dominant_weather_pattern
        ):
            if scenic_praise_pattern and atmosphere >= 1:
                # Scenery-focused review that mentions the access road/parking
                # in passing: keep infra competitive but do not let it swallow
                # the aesthetic focus of the review.
                adjusted["infra"] = adjusted.get("infra", 0.0) * 1.20
                adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 1.25
            else:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 1.65
                if not strong_activity_pattern:
                    adjusted["activity"] = adjusted.get("activity", 0.0) * 0.78
                if not atmosphere_pattern:
                    adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.84
            if not heavy_traffic_pattern:
                adjusted["traffic"] = adjusted.get("traffic", 0.0) * 0.58
            if not heavy_weather_pattern:
                adjusted["weather"] = adjusted.get("weather", 0.0) * 0.62

        if strong_price_pattern and not price_false_positive:
            adjusted["price"] = adjusted.get("price", 0.0) * 1.35
            if not strong_activity_pattern:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.78
            if not clear_infra_pattern:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.88
            if not strong_food_pattern:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.88
            adjusted["weather"] = adjusted.get("weather", 0.0) * 0.70

        if strong_cleanliness_pattern or cleanliness >= 2:
            adjusted["cleanliness"] = adjusted.get("cleanliness", 0.0) * 1.75
            adjusted["food"] = adjusted.get("food", 0.0) * 0.62
            if not clear_infra_pattern:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.70
            adjusted["price"] = adjusted.get("price", 0.0) * 0.58
        elif cleanliness_pattern and cleanliness >= 1:
            adjusted["cleanliness"] = adjusted.get("cleanliness", 0.0) * 1.35
            if food <= 1:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.76

        if (
            atmosphere_pattern
            and atmosphere >= 1
            and not heavy_infra_pattern
            and not dominant_weather_pattern
        ):
            adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 1.65
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.58
            if not explicit_price_pattern:
                adjusted["price"] = adjusted.get("price", 0.0) * 0.62
            if food <= 2:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.70
            if not strong_activity_pattern:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.78

        if (
            (strong_activity_pattern or entertainment_pattern)
            and activity >= 1
            and not clear_crowd_pattern
            and not heavy_traffic_pattern
            and not dominant_weather_pattern
        ):
            adjusted["activity"] = adjusted.get("activity", 0.0) * 1.45
            if not strong_service_pattern:
                adjusted["service"] = adjusted.get("service", 0.0) * 0.74
            if not heavy_infra_pattern:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.72
            if food <= 2 and not market_food_pattern:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.72

        if not price_pattern:
            adjusted["price"] = adjusted.get("price", 0.0) * 0.52
        elif price_pattern and not explicit_price_pattern and max(activity, atmosphere, infra, food) >= 2:
            adjusted["price"] = adjusted.get("price", 0.0) * 0.82

        if strong_food_pattern and food >= 1:
            if (weather_pattern or traffic_pattern) and food <= 2:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.62
            if atmosphere_pattern and atmosphere >= 1 and food <= 2 and not market_food_pattern:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.70

        # Final dominant-evidence arbitration. These are structural distinctions,
        # not dataset examples: moving vehicle flow is traffic (not merely a road),
        # external conditions are weather, and explicit staff/process complaints
        # are service even when food items are mentioned as order context.
        if heavy_traffic_pattern:
            adjusted["traffic"] = adjusted.get("traffic", 0.0) * 1.55
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.55
            adjusted["crowd"] = adjusted.get("crowd", 0.0) * 0.82
        if dominant_weather_pattern:
            adjusted["weather"] = adjusted.get("weather", 0.0) * 1.55
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.62
            adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 0.60
            adjusted["food"] = adjusted.get("food", 0.0) * 0.72
        if clear_crowd_pattern and crowd >= 2.20 and not heavy_traffic_pattern:
            adjusted["crowd"] = adjusted.get("crowd", 0.0) * 1.40
            adjusted["activity"] = adjusted.get("activity", 0.0) * 0.72
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.82
        if strong_service_pattern and service_complaint_pattern:
            adjusted["service"] = adjusted.get("service", 0.0) * 1.65
            adjusted["food"] = adjusted.get("food", 0.0) * 0.58
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.68
            adjusted["activity"] = adjusted.get("activity", 0.0) * 0.75
        if strong_price_pattern and not price_false_positive:
            adjusted["price"] = adjusted.get("price", 0.0) * 1.25
            if not strong_food_pattern:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.82

        # Repeated activity/aesthetic evidence may coexist with one incidental
        # access, price or crowd sentence. Restore the sustained review focus
        # only when its lexical coverage is clearly stronger.
        if (
            (strong_activity_pattern or entertainment_pattern)
            and activity >= 2.50
            and (not clear_crowd_pattern or crowd < 2.20)
            and not heavy_traffic_pattern
            and not dominant_weather_pattern
        ):
            adjusted["activity"] = adjusted.get("activity", 0.0) * 1.35
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.76
            adjusted["price"] = adjusted.get("price", 0.0) * 0.76
            adjusted["crowd"] = adjusted.get("crowd", 0.0) * 0.82
        if (
            atmosphere_pattern
            and atmosphere >= 2.50
            and atmosphere >= infra + 0.40
            and not dominant_weather_pattern
            and not strong_activity_pattern
        ):
            adjusted["atmosphere"] = adjusted.get("atmosphere", 0.0) * 1.35
            adjusted["infra"] = adjusted.get("infra", 0.0) * 0.72
            adjusted["price"] = adjusted.get("price", 0.0) * 0.82

        # Conservative near-tie arbitration.  Broad topic multipliers tend to
        # improve recall at the cost of the already-strong topics.  At this late
        # stage, only rescue a weak topic when (1) its lexical evidence is
        # explicit and repeated, and (2) the semantic/lexical blended score is
        # already close to the current winner.  This mainly resolves reviews
        # whose incidental access/facility sentence lets ``infra`` absorb the
        # sustained activity, scenery or price focus.
        def _winner() -> Tuple[str, float]:
            if not adjusted:
                return "other", 0.0
            return max(adjusted.items(), key=lambda item: item[1])

        def _rescue_if_close(
            topic: str,
            allowed_winners: set[str],
            min_ratio: float,
        ) -> bool:
            winner_topic, winner_score = _winner()
            candidate_score = float(adjusted.get(topic, 0.0))
            if winner_topic == topic:
                return True
            if winner_topic not in allowed_winners or winner_score <= 0.0:
                return False
            if candidate_score < winner_score * min_ratio:
                return False
            adjusted[topic] = winner_score * 1.015
            return True

        # Crowd is a contextual attribute in many activity reviews.  It should
        # win only when its repeated evidence is at least as focused as the
        # actions being described; otherwise keep it competitive but remove the
        # earlier crowd-dominance boost.  The strict evidence gap preserves
        # genuine crowd reviews and the current 100% crowd recall.
        winner_topic, _ = _winner()
        if (
            winner_topic == "crowd"
            and (strong_activity_pattern or entertainment_pattern)
            and activity >= 2.50
            and activity >= crowd + 0.40
        ):
            adjusted["crowd"] = adjusted.get("crowd", 0.0) * 0.78

        activity_focus = (
            (strong_activity_pattern or entertainment_pattern)
            and activity >= 2.50
            and not heavy_traffic_pattern
            and not dominant_weather_pattern
            and (not clear_crowd_pattern or activity >= crowd + 0.40)
        )
        if activity_focus:
            _rescue_if_close(
                "activity",
                {"infra", "crowd", "service", "food", "atmosphere"},
                0.82,
            )

        atmosphere_focus = (
            (scenic_praise_pattern or atmosphere_pattern)
            and atmosphere >= 2.50
            and not dominant_weather_pattern
            and not strong_activity_pattern
            and not entertainment_pattern
        )
        if atmosphere_focus:
            _rescue_if_close(
                "atmosphere",
                {"infra", "service", "food", "price", "other"},
                0.84,
            )

        price_focus = (
            strong_price_pattern
            and price >= 1.45
            and not price_false_positive
            and not free_entry_only
            and not incidental_amount_only
        )
        if price_focus:
            _rescue_if_close(
                "price",
                {"infra", "activity", "cleanliness", "food", "atmosphere"},
                0.82,
            )

        return adjusted

    def _classify_topic(self, raw_text: str, norm_text: str) -> Tuple[str, Dict[str, float], str]:
        """Returns (main_topic, topic_scores, topic_source).

        topic_source values:
          "e5+proto" — E5 + prototype cosine blend (best accuracy)
          "e5"       — E5 only (prototype model unavailable)
          "keyword"  — keyword matching only (E5 unavailable)

        Pipeline:
          1. Keyword counts (always computed, used as a lexical boost in all paths).
          2. E5 (primary): query-document similarity against topic descriptions.
          3. Prototype blend (secondary): cosine similarity against prototype sentences
             from the sentence-embedding model, blended when both models are active.
          4. E5 "other" score is used directly in the "other" threshold decision so
             reviews that semantically match "other" are not forced into a specific topic.
        """
        # ── 1. Keyword counts ─────────────────────────────────────────────────
        # Use both frequency and distribution. A topic repeated across several
        # clauses is more likely to be the review's focus than a location/access
        # detail mentioned once. The first short line is commonly a user-written
        # title, so explicit evidence there receives a modest, generic boost.
        # CSV/JSON exports sometimes preserve line breaks as the two literal
        # characters ``\\n``. Canonicalise both representations before detecting
        # a title or clause boundary.
        lexical_doc = str(raw_text or "").replace("\\r\\n", "\n").replace("\\n", "\n")
        raw_lines = [line.strip() for line in lexical_doc.splitlines() if line.strip()]
        title_norm = normalize_text(raw_lines[0]) if raw_lines and len(raw_lines[0]) <= 160 else ""
        lexical_segments = [
            normalize_text(part)
            for part in re.split(r"[.!?;\n]+", lexical_doc)
            if len(normalize_text(part)) >= 4
        ]
        keyword_raw: Dict[str, float] = {}
        for topic, keywords in TOPIC_KEYWORDS.items():
            base_hits = float(count_keyword_hits(norm_text, keywords))
            title_hits = float(count_keyword_hits(title_norm, keywords)) if title_norm else 0.0
            covered_segments = sum(
                1 for segment in lexical_segments
                if count_keyword_hits(segment, keywords) > 0
            )
            # Coverage is capped so verbose reviews cannot win merely by length.
            coverage_bonus = 0.45 * min(4, covered_segments)
            keyword_raw[topic] = base_hits + 1.25 * title_hits + coverage_bonus
        keyword_total = sum(keyword_raw.values())
        keyword_norm = {
            t: (s / keyword_total if keyword_total else 0.0)
            for t, s in keyword_raw.items()
        }

        # ── 2. E5 query-document scores ───────────────────────────────────────
        tc = self.classifier_provider.topic_classifier
        e5_scores = tc.predict(raw_text) if (tc and tc.active) else None

        if e5_scores is not None:
            # E5 returns a score for "other" as well; honour it directly.
            e5_other = float(e5_scores.get("other", 0.0))

            # ── 3. Optional prototype blend ───────────────────────────────────
            proto_scores = self.embedding_provider.predict_topic_semantic(norm_text)

            combined: Dict[str, float] = {}
            if proto_scores is not None:
                # Three-way blend: E5 62% + prototype 20% + keyword 18%.
                for topic in TOPIC_KEYWORDS:
                    combined[topic] = (
                        0.62 * float(e5_scores.get(topic, 0.0))
                        + 0.20 * float(proto_scores.get(topic, 0.0))
                        + 0.18 * keyword_norm.get(topic, 0.0)
                    )
                source = "e5+proto"
            else:
                # Two-way blend: E5 78% + keyword 22%.
                for topic in TOPIC_KEYWORDS:
                    combined[topic] = (
                        0.78 * float(e5_scores.get(topic, 0.0))
                        + 0.22 * keyword_norm.get(topic, 0.0)
                    )
                source = "e5"

            combined = self._apply_topic_decision_adjustments(
                combined, keyword_raw, norm_text, title_norm
            )
            best_combined = max(combined.values()) if combined else 0.0

            # "other" when E5 very strongly predicts it OR no specific topic is confident.
            # Threshold 0.50: chỉ khi E5 gán >50% xác suất cho "other" mới hard-assign,
            # tránh việc review về bar/café/công viên bị gán nhầm "other".
            if e5_other > 0.50 or best_combined < self.config.topic_other_threshold:
                return "other", {**{k: 0.0 for k in TOPIC_KEYWORDS}, "other": 1.0}, source

            total = sum(combined.values()) or 1.0
            normalized = {t: s / total for t, s in combined.items()}
            normalized["other"] = 0.0
            best_topic = max(normalized.items(), key=lambda x: x[1])[0]
            return best_topic, ensure_float_dict(normalized), source

        # ── 4. Fallback: keyword-only ─────────────────────────────────────────
        if keyword_total == 0.0:
            return "other", {**{k: 0.0 for k in TOPIC_KEYWORDS}, "other": 1.0}, "keyword"
        score_payload = {k: v / keyword_total for k, v in keyword_raw.items()}
        score_payload = self._apply_topic_decision_adjustments(
            score_payload, keyword_raw, norm_text, title_norm
        )
        adjusted_total = sum(score_payload.values()) or 1.0
        score_payload = {k: v / adjusted_total for k, v in score_payload.items()}
        score_payload["other"] = 0.0
        best_topic = max(score_payload.items(), key=lambda x: x[1])[0]
        return best_topic, score_payload, "keyword"

    def _classify_time_label_rule(
        self, norm_text: str, main_topic: str
    ) -> Tuple[str, Optional[Dict[str, str]]]:
        """
        Returns (time_label, error_info).
        time_label: "short-term" | "long-term" | "amb"
        error_info: None when classified, dict with code+message when "amb".
        """
        strong = count_keyword_hits(norm_text, STRONG_SHORT_TIME_CUES)
        weak = count_keyword_hits(norm_text, WEAK_SHORT_TIME_CUES)
        long_hits = count_keyword_hits(norm_text, LONG_TIME_CUES)

        # Subtract context-aware false positives before decision logic.
        weak = max(0, weak - count_keyword_hits(norm_text, FALSE_POSITIVE_WEAK_CUES))
        long_hits = max(0, long_hits - count_keyword_hits(norm_text, FALSE_POSITIVE_LONG_CUES))

        # Regex-based habitual patterns catch cases where filler words interrupt
        # the anchor phrase (e.g. "tuần nào 2 bé cũng" → "tuan nao 2 be cung").
        long_hits += count_habitual_pattern_hits(norm_text)

        # Strong short-term anchor with NO competing long-term evidence → conclusive.
        # Example: "Hôm nay nhân viên thái độ tệ" (no recurring-visit signals) → short-term.
        if strong > 0 and long_hits == 0:
            return "short-term", None

        # Strong cue coexists with long-term signals → ambiguous: the strong cue may refer to
        # a side observation (e.g. "hôm nay trời đẹp") while the main complaint is persistent
        # (e.g. "đã thử lại nhiều lần nhưng dịch vụ vẫn tệ"). Defer to model.
        if strong > 0 and long_hits > 0:
            return (
                "amb",
                {
                    "code": "mixed_temporal_signals",
                    "message": "Từ chỉ thời điểm cụ thể và tín hiệu dài hạn cùng xuất hiện; không thể tự phân loại.",
                },
            )

        # Transient topic with any weak signal → short-term.
        if main_topic in TRANSIENT_TOPICS and weak > 0:
            return "short-term", None

        # Multiple weak signals → short-term.
        if weak >= 2:
            return "short-term", None

        # Explicit long-term markers, no competing short signals → long-term.
        if long_hits > 0 and weak == 0:
            return "long-term", None

        # No temporal markers at all → treat as long-term (general observation).
        if strong == 0 and weak == 0 and long_hits == 0:
            return "long-term", None

        # Conflicting weak short + long signals.
        if weak > 0 and long_hits > 0:
            return (
                "amb",
                {
                    "code": "conflicting_time_anchor",
                    "message": "Tín hiệu ngắn hạn và dài hạn xung đột, không thể xác định time_label.",
                },
            )

        # Single weak signal in a non-transient topic — insufficient evidence.
        return (
            "amb",
            {
                "code": "weak_temporal_signal",
                "message": "Tín hiệu thời gian yếu (chỉ có từ chỉ thì hiện tại), không đủ để phân loại.",
            },
        )

    def _classify_time_label(
        self, raw_text: str, _norm_text: str, _main_topic: str
    ) -> Tuple[str, Optional[Dict[str, str]]]:
        """Chỉ dùng PhoBERT fine-tuned. Trả về 'amb' khi model chưa tải hoặc không chắc chắn."""
        model_result = self.classifier_provider.predict_time_label(raw_text)
        if model_result is not None:
            return model_result
        if self.classifier_provider.phobert_time_active:
            return "amb", {
                "code": "phobert_inference_unavailable",
                "message": "PhoBERT đã active nhưng không trả về kết quả inference.",
                "detail": self.classifier_provider.phobert_time_last_error or "",
            }
        return "amb", {
            "code": "no_phobert_model",
            "message": "PhoBERT chưa được tải. Đặt --phobert-time-model để phân loại time_label.",
        }

    def _rule_based_sentiment(
        self,
        norm_text: str,
        stars,
    ) -> Tuple[Dict[str, float], float]:
        stars_int = int(stars) if stars is not None else None
        if stars_int is None:
            base_pos, base_neu, base_neg = 0.33, 0.34, 0.33
        elif stars_int >= 4:
            base_pos, base_neu, base_neg = 0.70, 0.20, 0.10
        elif stars_int <= 2:
            base_pos, base_neu, base_neg = 0.10, 0.20, 0.70
        else:
            base_pos, base_neu, base_neg = 0.25, 0.50, 0.25

        # Negation-aware counting: "không ngon" → negative, "không tệ" → positive.
        eff_pos, eff_neg = count_sentiment_hits_negation_aware(
            norm_text, POSITIVE_WORDS, NEGATIVE_WORDS
        )
        strong_neg_hits = count_strong_negative_hits(norm_text)
        mild_neg_hits = count_keyword_hits(norm_text, MILD_NEGATIVE_SENTIMENT_PHRASES)
        strong_pos_hits = count_keyword_hits(norm_text, STRONG_POSITIVE_SENTIMENT_PHRASES)

        # Titles and explicit recommendation/return intent are high-salience
        # summaries written by the reviewer. Weight their polarity without using
        # any venue- or dataset-specific phrase.
        # normalize_text removes newlines, so recover a likely title from the
        # first sentence as a conservative fallback (maximum 18 tokens).
        title_match = re.split(r"[.!?]", norm_text, maxsplit=1)[0].strip()
        title_norm = title_match if len(title_match.split()) <= 18 else ""
        if title_norm:
            title_pos, title_neg = count_sentiment_hits_negation_aware(
                title_norm, POSITIVE_WORDS, NEGATIVE_WORDS
            )
            title_strong_neg = count_strong_negative_hits(title_norm)
            title_strong_pos = count_keyword_hits(
                title_norm, STRONG_POSITIVE_SENTIMENT_PHRASES
            )
            eff_pos += title_pos + 2 * title_strong_pos
            eff_neg += title_neg + 2 * title_strong_neg

        # Keep the action close to the negated modal.  The former ``.{0,24}``
        # pattern misread praise such as "khong nen bo qua ngoi chua ... den"
        # as "khong nen den" merely because ``den`` appeared later.
        negative_intent = any(
            phrase in norm_text
            for phrase in (
                "khong nen den", "chang nen den", "khong muon den",
                "khong nen mua", "chang nen mua", "khong muon mua",
                "khong nen an", "khong nen uong",
                "khong muon quay lai", "chang muon quay lai",
                "khong the quay lai", "khong nen gioi thieu",
            )
        )
        if negative_intent:
            strong_neg_hits += 1

        # Long complaint phrases should dominate incidental praise in the same review.
        # Example: "khung cảnh đẹp nhưng trời xám xịt, gió mạnh, lên hình không đẹp".
        eff_neg += 2 * strong_neg_hits + mild_neg_hits
        eff_pos += strong_pos_hits

        contrast_negative = bool(
            re.search(
                r"\b(nhung|tuy nhien|mac du|song)\b.{0,120}\b("
                r"te|rat te|qua te|that vong|kho chiu|ket xe|dong nghet|"
                r"khong ngon|khong tot|khong dep|khong sach|khong dang|"
                r"khong nen|coc can|duoi khach|mat ve sinh|cho rat lau|doi rat lau"
                r")\b",
                norm_text,
            )
        )
        if contrast_negative:
            eff_neg += 2

        # A few broad positive tokens are useful, but they should not outweigh
        # concrete price/traffic/weather/service complaints.
        if strong_neg_hits > 0 and eff_pos > 0:
            eff_pos = max(0, eff_pos - min(eff_pos, strong_neg_hits))
        if eff_neg >= 2 and eff_neg >= eff_pos and strong_pos_hits == 0:
            eff_pos = max(0, eff_pos - 1)
        complaint_evidence = (
            strong_neg_hits > 0
            or contrast_negative
            or (mild_neg_hits >= 2 and eff_neg >= eff_pos)
            or (eff_neg >= 3 and eff_neg > eff_pos)
        )
        if complaint_evidence and stars_int is not None and stars_int >= 4:
            # Some public reviews carry high stars but the useful text is a
            # concrete complaint. Do not let stars dominate those cases.
            base_pos, base_neu, base_neg = 0.45, 0.20, 0.35
        no_long_wait_patterns = (
            "khong phai cho qua lau",
            "khong phai cho lau",
            "khong phai doi qua lau",
            "khong phai doi lau",
            "khong cho qua lau",
            "khong doi qua lau",
        )
        for phrase in no_long_wait_patterns:
            if phrase in norm_text:
                if eff_neg > 0:
                    eff_neg -= 1
                eff_pos += 1

        keyword_total = eff_pos + eff_neg

        if keyword_total > 0:
            kw_ratio = (eff_pos - eff_neg) / keyword_total
            if kw_ratio > 0.3:
                boost = min(0.35, 0.12 + 0.04 * keyword_total)
                pos = min(0.92, base_pos + boost)
                neg = max(0.02, base_neg - boost * 0.75)
            elif kw_ratio < -0.12:
                if strong_neg_hits > 0 or contrast_negative:
                    boost = min(0.68, 0.20 + 0.055 * keyword_total + 0.09 * strong_neg_hits)
                    pos = max(0.02, base_pos - boost * 1.05)
                    neg = min(0.96, base_neg + boost * 1.10)
                else:
                    boost = min(0.52, 0.15 + 0.05 * keyword_total + 0.035 * mild_neg_hits)
                    pos = max(0.02, base_pos - boost * 0.85)
                    neg = min(0.94, base_neg + boost)
            else:
                if strong_neg_hits > 0 or (mild_neg_hits >= 2 and eff_neg >= eff_pos):
                    boost = min(0.48, 0.18 + 0.06 * strong_neg_hits + 0.04 * mild_neg_hits)
                    pos = max(0.04, base_pos - boost * 0.80)
                    neg = min(0.90, base_neg + boost)
                else:
                    pos, neg = base_pos, base_neg
            neu = max(0.02, 1.0 - pos - neg)
            total = pos + neu + neg
            strength = min(
                1.0,
                (keyword_total + strong_neg_hits + 0.5 * mild_neg_hits + int(contrast_negative)) / 5.0,
            )
            return (
                {"positive": pos / total, "neutral": neu / total, "negative": neg / total},
                strength,
            )

        return {"positive": base_pos, "neutral": base_neu, "negative": base_neg}, 0.0

    def _blend_sentiment(
        self,
        model_result: Optional[Dict[str, float]],
        rule_result: Dict[str, float],
        rule_strength: float,
    ) -> Dict[str, float]:
        if model_result is None:
            return rule_result

        model_pol = float(model_result["positive"] - model_result["negative"])
        rule_pol = float(rule_result["positive"] - rule_result["negative"])

        if rule_strength <= 0.0:
            return model_result

        if model_pol * rule_pol < 0 and abs(rule_pol) >= 0.30:
            # The model is currently optimistic on many explicit complaints.
            # Let strong lexical evidence override it more decisively.
            # Requires a clearly-polarised rule signal (|pol| >= 0.30): every
            # verified complaint in the labeled set scores beyond -0.35, while
            # mixed positive reviews cluster in the weakly-negative band.
            rule_weight = min(0.90, 0.62 + 0.28 * rule_strength)
        else:
            rule_weight = min(0.62, 0.22 + 0.40 * rule_strength)
        model_weight = 1.0 - rule_weight

        blended = {
            "positive": model_weight * model_result["positive"] + rule_weight * rule_result["positive"],
            "neutral": model_weight * model_result["neutral"] + rule_weight * rule_result["neutral"],
            "negative": model_weight * model_result["negative"] + rule_weight * rule_result["negative"],
        }
        if (
            rule_strength >= 0.45
            and rule_result.get("negative", 0.0) >= 0.52
            and blended["positive"] > blended["negative"]
        ):
            # Clear complaint evidence is still under-called by the model; nudge
            # borderline blended cases over the decision boundary.
            needed = min(blended["positive"] - blended["negative"] + 0.05, blended["positive"] * 0.45)
            if needed > 0:
                blended["positive"] -= needed
                blended["negative"] += needed
        total = sum(blended.values()) or 1.0
        return {k: float(v / total) for k, v in blended.items()}

    def _classify_sentiment(self, raw_text: str, norm_text: str, stars) -> Dict[str, float]:
        """Blend model sentiment with negation-aware lexical evidence."""
        model_result = self.classifier_provider.predict_sentiment(raw_text)
        rule_result, rule_strength = self._rule_based_sentiment(norm_text, stars)
        blended = self._blend_sentiment(model_result, rule_result, rule_strength)

        # Many review sources expose a short user-written title on the first
        # non-empty line. It is a high-salience summary (e.g. an overall warning)
        # and should not be drowned out by a long body containing incidental
        # positive nouns/adjectives. Apply this to any sufficiently explicit
        # title, independent of topic or venue.
        sentiment_doc = str(raw_text or "").replace("\\r\\n", "\n").replace("\\n", "\n")
        lines = [line.strip() for line in sentiment_doc.splitlines() if line.strip()]
        if len(lines) >= 2 and len(lines[0]) <= 160:
            title_rule, title_strength = self._rule_based_sentiment(
                normalize_text(lines[0]), None
            )
            title_polarity = title_rule["positive"] - title_rule["negative"]
            if title_strength >= 0.20 and abs(title_polarity) >= 0.20:
                title_weight = min(0.45, 0.22 + 0.25 * title_strength)
                blended = {
                    label: (1.0 - title_weight) * blended[label]
                    + title_weight * title_rule[label]
                    for label in ("positive", "neutral", "negative")
                }
                body_norm = normalize_text(" ".join(lines[1:]))
                body_strong_negative = count_strong_negative_hits(body_norm) > 0
                if (
                    title_rule["negative"] >= 0.55
                    and title_strength >= 0.40
                    and body_strong_negative
                    and blended["negative"] <= blended["positive"]
                ):
                    # An explicit negative headline is the author's summary, not
                    # a weak clause. Cross the decision boundary conservatively
                    # while retaining the original probability information.
                    transfer = min(
                        blended["positive"] * 0.45,
                        (blended["positive"] - blended["negative"] + 0.06) / 2.0,
                    )
                    blended["positive"] -= transfer
                    blended["negative"] += transfer
                total = sum(blended.values()) or 1.0
                blended = {label: float(value / total) for label, value in blended.items()}
        return blended

    def _split_sentences(self, raw_text: str) -> List[str]:
        """Split review into clauses on punctuation and Vietnamese contrast conjunctions.

        Contrast conjunctions (nhưng, tuy nhiên, mặc dù, song) signal a topic/sentiment
        shift mid-sentence and are replaced with a null separator before splitting,
        so each resulting clause can be analysed independently.
        """
        text = raw_text
        for conj in ["tuy nhiên", "tuy nhien", "mặc dù", "mac du", "nhưng", "nhung"]:
            text = re.sub(r'(?i)\b' + re.escape(conj) + r'\b', '\x00', text)
        # "song" as a standalone conjunction only (avoid matching mid-word)
        text = re.sub(r'(?i)\bsong\b(?=\s+\S)', '\x00', text)
        parts = re.split(r'[.!?;,\x00]+', text)
        return [p.strip() for p in parts if p and len(p.strip()) > 5]

    def _build_topic_sentiment_scores(
        self,
        raw_text: str,
        base_sentiment: Dict[str, float],
        topic_scores: Dict[str, float],
    ) -> Dict[str, Dict[str, float]]:
        """Build per-topic sentiment by aggregating sentence-level signals.

        Each sentence is classified independently for topic and sentiment.
        Per-topic sentiment is a weighted average of sentences that discuss the topic,
        scaled by the overall topic_score to preserve magnitude consistency with
        _flatten_sentiment. Falls back to base_sentiment × topic_score when no
        sentence covers a topic or when the review is a single clause.
        """
        sentences = self._split_sentences(raw_text)

        # Single-clause review: sentence-level analysis adds no value → use old method.
        if len(sentences) < 2:
            return build_topic_sentiment_scores(base_sentiment, topic_scores)

        tc = self.classifier_provider.topic_classifier

        # Collect per-sentence (topic_scores, sentiment) pairs.
        sent_data: List[Tuple[Dict[str, float], Dict[str, float]]] = []
        for sent in sentences:
            sent_topic: Dict[str, float] = (
                (tc.predict(sent) or {}) if (tc and tc.active) else {}
            )
            sent_sentiment = self._classify_sentiment(sent, normalize_text(sent), None)
            sent_data.append((sent_topic, sent_sentiment))

        result: Dict[str, Dict[str, float]] = {}

        for topic, ts in topic_scores.items():
            topic_score = float(ts)
            total_weight = sum(st.get(topic, 0.0) for st, _ in sent_data)

            if total_weight < 1e-9:
                # No sentence discusses this topic → fallback to old method for this topic.
                if topic_score <= 0.0:
                    continue
                result[topic] = {
                    "positive": float(base_sentiment["positive"] * topic_score),
                    "neutral":  float(base_sentiment["neutral"]  * topic_score),
                    "negative": float(base_sentiment["negative"] * topic_score),
                }
                continue

            # Sentence-level classifiers are useful for mixed-topic reviews, but
            # short isolated clauses are substantially noisier and often overly
            # positive. Preserve the title/negation-aware document decision as
            # the anchor instead of replacing it completely with clause scores.
            clause_sentiment = {
                "positive": sum(ss["positive"] * st.get(topic, 0.0) for st, ss in sent_data) / total_weight,
                "neutral":  sum(ss["neutral"]  * st.get(topic, 0.0) for st, ss in sent_data) / total_weight,
                "negative": sum(ss["negative"] * st.get(topic, 0.0) for st, ss in sent_data) / total_weight,
            }
            ordered_base = sorted(base_sentiment.values(), reverse=True)
            base_margin = ordered_base[0] - ordered_base[1]
            canonical_doc = str(raw_text or "").replace("\\n", "\n")
            doc_lines = [line.strip() for line in canonical_doc.splitlines() if line.strip()]
            title_text = doc_lines[0] if len(doc_lines) >= 2 and len(doc_lines[0]) <= 160 else ""
            title_rule, title_strength = self._rule_based_sentiment(
                normalize_text(title_text), None
            ) if title_text else (
                {"positive": 0.33, "neutral": 0.34, "negative": 0.33}, 0.0
            )
            reliable_negative_title = (
                title_strength >= 0.40
                and title_rule["negative"] >= 0.55
            )
            complaint_clauses = [
                normalize_text(part)
                for part in re.split(r"[.!?;\n]+", canonical_doc)
                if normalize_text(part)
            ]
            complaint_clause_count = sum(
                1 for clause in complaint_clauses
                if count_strong_negative_hits(clause) > 0
            )
            body_complaint_count = sum(
                1 for clause in complaint_clauses[1:]
                if count_strong_negative_hits(clause) > 0
            )
            reliable_document_complaint = (
                base_sentiment["negative"] >= base_sentiment["positive"]
                and (
                    (reliable_negative_title and body_complaint_count >= 1)
                    or complaint_clause_count >= 2
                    or (
                        base_sentiment["negative"] >= 0.55
                        and complaint_clause_count >= 1
                    )
                )
            )
            # Preserve clause-level nuance for ordinary/mixed reviews. Only let
            # the document anchor dominate when negative evidence is explicit;
            # this asymmetry raises negative recall without sacrificing the very
            # high positive recall of the sentence model. The document classifier
            # is title- and negation-aware while isolated short clauses skew
            # positive, so any negative-leaning document decision gets extra
            # weight over the clause aggregate.
            base_negative_leaning = (
                base_sentiment["negative"] > base_sentiment["positive"]
            )
            if reliable_document_complaint:
                document_weight = 0.80
            elif base_negative_leaning and complaint_clause_count >= 1:
                document_weight = 0.62
            elif base_negative_leaning:
                # Negative-leaning document without any explicit complaint
                # clause: often a mixed/positive review the model misreads.
                document_weight = 0.30
            elif base_margin >= 0.20:
                document_weight = 0.24
            else:
                document_weight = 0.16
            clause_weight = 1.0 - document_weight
            pos = document_weight * base_sentiment["positive"] + clause_weight * clause_sentiment["positive"]
            neu = document_weight * base_sentiment["neutral"]  + clause_weight * clause_sentiment["neutral"]
            neg = document_weight * base_sentiment["negative"] + clause_weight * clause_sentiment["negative"]

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
        ttl_hours = self._ttl_hours_for_topic(topic, 48)
        return base_time + timedelta(hours=ttl_hours)

    # --- Algorithm 2: Detect conflicts ---

    def algorithm_2_detect_conflicts(
        self,
        contents: List[Dict[str, Any]],
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        conflicts: List[Dict[str, Any]] = []
        review_news = [c for c in contents if c.get("time_label") == "short-term"]
        current_review_olds = [c for c in contents if c.get("time_label") == "long-term"]
        historical_review_olds = self._load_historical_long_terms()

        review_olds: List[Dict[str, Any]] = []
        seen_old_keys: set[Tuple[str, str, str, str, str]] = set()
        for old in historical_review_olds + current_review_olds:
            review_id = str(old.get("review_id") or "")
            if review_id:
                old_key = ("review_id", review_id, "", "", "")
            else:
                old_key = (
                    "content",
                    str(old.get("place_id") or ""),
                    str(old.get("main_topic") or ""),
                    str(old.get("created_at") or ""),
                    str(old.get("content") or ""),
                )
            if old_key in seen_old_keys:
                continue
            seen_old_keys.add(old_key)
            review_olds.append(old)

        olds_by_group: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
        for old in review_olds:
            key = (str(old.get("place_id")), str(old.get("main_topic")))
            olds_by_group[key].append(old)

        total_pairs_examined = 0
        for content in sorted(review_news, key=lambda c: c["created_at"]):
            key = (str(content.get("place_id")), str(content.get("main_topic")))
            raw_candidates = [
                old
                for old in olds_by_group.get(key, [])
                if parse_iso(old.get("created_at")) and parse_iso(old["created_at"]) <= parse_iso(content["created_at"])
            ]

            topic = str(content.get("main_topic"))
            ttl_hours = self._ttl_hours_for_topic(topic, 72)
            lookback_multiplier = self._lookback_multiplier_for_topic(topic)
            lookback_hours = ttl_hours * max(1, lookback_multiplier)
            ref_time = parse_iso(content["created_at"])
            if ref_time is not None:
                boundary = ref_time - timedelta(hours=lookback_hours)
                raw_candidates = [
                    old for old in raw_candidates
                    if parse_iso(old["created_at"]) and parse_iso(old["created_at"]) >= boundary
                ]

            candidates = self._select_algorithm2_candidates(content, raw_candidates)
            total_pairs_examined += len(candidates)

            for old in candidates:
                sim = self._review_similarity(content, old)

                conflict_topic = content["main_topic"]

                # Dampen similarity by how topic-focused each review actually is.
                # Embedding encodes the FULL review; if only 30% is about this topic,
                # the similarity signal is noisier. Average topic relevance scales sim
                # from 50% (unrelated topics dominate) to 100% (fully topic-focused).
                topic_conf = (
                    content["topic_scores"].get(conflict_topic, 0.3)
                    + old["topic_scores"].get(conflict_topic, 0.3)
                ) / 2.0
                adjusted_sim = sim * (0.5 + 0.5 * topic_conf)

                nli_label, p_contra = self._infer_nli(content, old, sim, conflict_topic)
                polarity_gap = self._polarity_gap_for_conflict(content, old, conflict_topic)
                sentiment_gap = max(
                    self._sentiment_distance_for_topic(content, old, conflict_topic),
                    polarity_gap,
                )
                aspect_conflict_score = self._aspect_contradiction_score(
                    content,
                    old,
                    conflict_topic,
                    sim,
                    topic_conf,
                    polarity_gap,
                )
                strong_polarity_conflict = (
                    nli_label == "contradiction"
                    and sentiment_gap >= ALGORITHM2_STRONG_POLARITY_GAP
                )
                aspect_contradiction = (
                    aspect_conflict_score >= ALGORITHM2_ASPECT_CONTRADICTION_THRESHOLD
                )

                if (
                    sim < ALGORITHM2_MIN_SIMILARITY
                    and not strong_polarity_conflict
                    and not aspect_contradiction
                ):
                    continue

                if aspect_contradiction:
                    conflict_score = max(
                        aspect_conflict_score,
                        0.30 * max(0.0, adjusted_sim)
                        + 0.40 * sentiment_gap
                        + 0.30 * p_contra,
                    )
                    min_conflict_score = ALGORITHM2_ASPECT_CONTRADICTION_THRESHOLD
                elif strong_polarity_conflict:
                    conflict_score = (
                        0.20 * max(0.0, adjusted_sim)
                        + 0.40 * sentiment_gap
                        + 0.40 * p_contra
                    )
                    min_conflict_score = ALGORITHM2_STRONG_CONTRADICTION_THRESHOLD
                else:
                    conflict_score = 0.45 * adjusted_sim + 0.25 * sentiment_gap + 0.30 * p_contra
                    min_conflict_score = self.config.conflict_score_threshold

                should_record_conflict = (
                    sim >= 0.8
                    or (sim >= ALGORITHM2_MIN_SIMILARITY and nli_label == "contradiction")
                    or strong_polarity_conflict
                    or aspect_contradiction
                )

                if should_record_conflict and conflict_score >= min_conflict_score:
                    conflicts.append({
                        "id": str(uuid.uuid4()),
                        "new_content_id": content["id"],
                        "old_content_id": old["id"],
                        "conflict_score": float(round(conflict_score, 4)),
                        "conflict_topic": content["main_topic"],
                        "conflict_evidence": (
                            "aspect_sentiment_contradiction"
                            if aspect_contradiction
                            else (
                                "sentiment_contradiction"
                                if strong_polarity_conflict
                                else "semantic_contradiction"
                            )
                        ),
                        "created_at": content["created_at"],
                    })
                    content["has_conflict"] = True
                    old["has_conflict"] = True

        meta = {
            "review_new_count": len(review_news),
            "review_old_count": len(review_olds),
            "current_review_old_count": len(current_review_olds),
            "historical_review_old_count": len(historical_review_olds),
            "historical_long_term_source": "review_ai.review_contents",
            "total_pairs_examined": total_pairs_examined,
            "lookback_multiplier_default": self.config.old_lookback_multiplier,
            "lookback_multiplier_by_topic": self.config.lookback_multiplier_by_topic or ALGORITHM2_LOOKBACK_MULTIPLIER_BY_TOPIC,
            "max_candidates_per_review": self.config.max_candidates_per_review,
            "aspect_contradiction_threshold": ALGORITHM2_ASPECT_CONTRADICTION_THRESHOLD,
        }
        return conflicts, meta

    def _select_algorithm2_candidates(
        self,
        review_new: Dict[str, Any],
        raw_candidates: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        limit = self.config.max_candidates_per_review
        if limit is None or limit <= 0 or len(raw_candidates) <= limit:
            return raw_candidates

        ref_time = parse_iso(review_new.get("created_at"))

        def candidate_rank(old: Dict[str, Any]) -> float:
            old_time = parse_iso(old.get("created_at"))
            if ref_time is not None and old_time is not None:
                return max(0.0, (ref_time - old_time).total_seconds())
            return float("inf")

        ranked = sorted(raw_candidates, key=candidate_rank)
        return ranked[:limit]

    def _model_polarity_for_topic(
        self, review: Dict[str, Any], topic: Optional[str]
    ) -> float:
        if topic:
            t = review["sentiment_scores"].get(topic, {})
            tot = (t.get("positive", 0.0) + t.get("neutral", 0.0) + t.get("negative", 0.0))
            if tot > 0:
                return (t.get("positive", 0.0) - t.get("negative", 0.0)) / tot
        flat = self._flatten_sentiment(review["sentiment_scores"])
        return flat["positive"] - flat["negative"]

    def _lexical_polarity_for_conflict(self, text: str) -> float:
        norm_text = normalize_text(text)
        rule_result, rule_strength = self._rule_based_sentiment(norm_text, None)
        if rule_strength <= 0:
            return 0.0
        return float(rule_result["positive"] - rule_result["negative"])

    def _topic_contrast_hits(self, text: str, topic: str) -> Tuple[int, int]:
        phrase_sets = TOPIC_CONTRAST_PHRASES.get(topic)
        if not phrase_sets:
            return 0, 0

        norm_text = normalize_text(text)

        def _count(phrases: List[str]) -> int:
            hits = 0
            for phrase in phrases:
                norm_phrase = normalize_text(phrase)
                if not norm_phrase:
                    continue
                if " " in norm_phrase:
                    hits += norm_text.count(norm_phrase)
                elif norm_phrase in norm_text.split():
                    hits += 1
            return hits

        return _count(phrase_sets.get("positive", [])), _count(phrase_sets.get("negative", []))

    def _aspect_contradiction_score(
        self,
        review_new: Dict[str, Any],
        review_old: Dict[str, Any],
        topic: str,
        similarity: float,
        topic_confidence: float,
        polarity_gap: float,
    ) -> float:
        """Score same-topic, opposite-aspect contradictions missed by global NLI.

        Full-review embeddings can be high for two service reviews even when the
        actual aspect is opposite ("phuc vu cham" vs "phuc vu nhanh"). This
        signal requires explicit topic contrast phrases plus enough polarity gap,
        so it is narrower than simply lowering Algorithm 2's global threshold.
        """
        if similarity < ALGORITHM2_ASPECT_CONTRADICTION_MIN_SIMILARITY:
            return 0.0
        if topic_confidence < ALGORITHM2_ASPECT_TOPIC_FOCUS_MIN:
            return 0.0

        new_pos_hits, new_neg_hits = self._topic_contrast_hits(
            str(review_new.get("content", "")),
            topic,
        )
        old_pos_hits, old_neg_hits = self._topic_contrast_hits(
            str(review_old.get("content", "")),
            topic,
        )

        opposite_phrases = (
            (new_pos_hits > 0 and old_neg_hits > 0)
            or (new_neg_hits > 0 and old_pos_hits > 0)
        )
        if not opposite_phrases:
            return 0.0

        new_pol = self._polarity_for_conflict(review_new, topic)
        old_pol = self._polarity_for_conflict(review_old, topic)
        opposite_polarity = new_pol * old_pol < 0
        if not opposite_polarity and polarity_gap < ALGORITHM2_ASPECT_POLARITY_GAP_MIN:
            return 0.0

        phrase_strength = min(1.0, (new_pos_hits + new_neg_hits + old_pos_hits + old_neg_hits) / 4.0)
        polarity_strength = min(1.0, polarity_gap)
        similarity_strength = max(0.0, min(1.0, similarity))
        topic_strength = max(0.0, min(1.0, topic_confidence))

        return float(
            0.30 * similarity_strength
            + 0.25 * topic_strength
            + 0.25 * polarity_strength
            + 0.20 * phrase_strength
        )

    def _polarity_for_conflict(
        self, review: Dict[str, Any], topic: Optional[str]
    ) -> float:
        model_pol = self._model_polarity_for_topic(review, topic)
        lexical_pol = self._lexical_polarity_for_conflict(str(review.get("content", "")))

        # Prefer lexical polarity when it is clear enough. This protects Algorithm 2
        # from sentiment-model mistakes on short aspect-focused Vietnamese reviews.
        if abs(lexical_pol) >= ALGORITHM2_LEXICAL_POLARITY_MIN:
            return lexical_pol
        return model_pol

    def _polarity_gap_for_conflict(
        self, a: Dict[str, Any], b: Dict[str, Any], topic: Optional[str]
    ) -> float:
        return abs(
            self._polarity_for_conflict(a, topic)
            - self._polarity_for_conflict(b, topic)
        )

    def _infer_nli(
        self,
        a: Dict[str, Any],
        b: Dict[str, Any],
        similarity: float,
        conflict_topic: Optional[str] = None,
    ) -> Tuple[str, float]:
        a_pol = self._polarity_for_conflict(a, conflict_topic)  # range [-1, +1]
        b_pol = self._polarity_for_conflict(b, conflict_topic)
        pol_product = a_pol * b_pol
        pol_distance = abs(a_pol - b_pol)  # range [0, 2]

        if pol_product < 0:
            # Opposite sentiment directions → contradiction.
            # Higher polarity distance = more certain contradiction (0.40–0.85).
            p_contra = 0.40 + 0.45 * (pol_distance / 2.0)
            return "contradiction", round(p_contra, 3)
        elif pol_product > 0:
            # Same direction → entailment, probability of contradiction is low.
            p_contra = max(0.02, 0.20 - 0.15 * similarity)
            return "entailment", round(p_contra, 3)
        else:
            # One or both reviews are neutral/mixed → weak signal.
            p_contra = 0.15 + 0.15 * (pol_distance / 2.0)  # 0.15–0.30
            return "neutral", round(p_contra, 3)

    def _flatten_sentiment(self, sentiment: Dict[str, Any]) -> Dict[str, float]:
        if "positive" in sentiment and "neutral" in sentiment and "negative" in sentiment:
            return {
                "positive": float(sentiment["positive"]),
                "neutral": float(sentiment["neutral"]),
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

    def _polarity(self, sentiment: Dict[str, Any]) -> int:
        flat = self._flatten_sentiment(sentiment)
        if flat["positive"] > flat["negative"]:
            return 1
        if flat["negative"] > flat["positive"]:
            return -1
        return 0

    def _lexical_overlap_similarity(self, a: Dict[str, Any], b: Dict[str, Any]) -> float:
        left = content_token_set(str(a.get("content", "")))
        right = content_token_set(str(b.get("content", "")))
        if not left or not right:
            return 0.0
        return float((2.0 * len(left & right)) / (len(left) + len(right)))

    def _review_similarity(self, a: Dict[str, Any], b: Dict[str, Any]) -> float:
        embedding_sim = cosine_similarity(a.get("embedding", []), b.get("embedding", []))
        lexical_sim = self._lexical_overlap_similarity(a, b)

        # Hash embeddings are sparse/noisy. Same-topic repeated observations often
        # share enough domain words to be obvious even when cosine is unreliable.
        same_sentiment = self._sentiment_label(a.get("sentiment_scores", {})) == self._sentiment_label(
            b.get("sentiment_scores", {})
        )
        lexical_adjusted = lexical_sim
        if lexical_sim >= 0.30:
            lexical_adjusted += 0.25 if same_sentiment else 0.15
        return float(max(embedding_sim, min(1.0, lexical_adjusted)))

    def _sentiment_distance(self, a: Dict[str, Any], b: Dict[str, Any]) -> float:
        a_sent = self._flatten_sentiment(a["sentiment_scores"])
        b_sent = self._flatten_sentiment(b["sentiment_scores"])
        distance = (
            abs(a_sent["positive"] - b_sent["positive"])
            + abs(a_sent["neutral"] - b_sent["neutral"])
            + abs(a_sent["negative"] - b_sent["negative"])
        ) / 3.0
        return float(min(1.0, max(0.0, distance)))

    def _sentiment_distance_for_topic(
        self, a: Dict[str, Any], b: Dict[str, Any], topic: str
    ) -> float:
        """Sentiment distance computed only on the sentiment scores for `topic`.

        sentiment_scores has shape {topic: {positive, neutral, negative}} where
        each value is sentiment_prob × topic_score (not normalized to 1.0).
        We normalize within-topic before computing L1 distance so that reviews
        with a low topic_score are still comparable on their directional signal.
        Falls back to full-review sentiment when topic scores are missing.
        """
        def _extract_normalized(review: Dict[str, Any]) -> Dict[str, float]:
            t = review["sentiment_scores"].get(topic, {})
            tot = (t.get("positive", 0.0) + t.get("neutral", 0.0) + t.get("negative", 0.0))
            if tot <= 0:
                return self._flatten_sentiment(review["sentiment_scores"])
            return {
                "positive": t.get("positive", 0.0) / tot,
                "neutral": t.get("neutral", 0.0) / tot,
                "negative": t.get("negative", 0.0) / tot,
            }

        a_sent = _extract_normalized(a)
        b_sent = _extract_normalized(b)
        distance = (
            abs(a_sent["positive"] - b_sent["positive"])
            + abs(a_sent["neutral"] - b_sent["neutral"])
            + abs(a_sent["negative"] - b_sent["negative"])
        ) / 3.0
        return float(min(1.0, max(0.0, distance)))

    # --- Algorithm small: Time management ---

    def algorithm_small_time_management(
        self,
        contents: List[Dict[str, Any]],
        conflicts: List[Dict[str, Any]],
        algorithm2_meta: Dict[str, Any],
    ) -> Dict[str, Any]:
        now = self.config.now
        hidden_review_ids: List[str] = []
        notifications: List[Dict[str, Any]] = []
        self._promotion_diagnostics: List[Dict[str, Any]] = []

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

        (
            long_term_summaries,
            promoted_ids,
            hidden_long_term_ids,
            conflict_resolutions,
        ) = self._derive_long_term_summaries(contents, conflicts)

        for content_id in hidden_long_term_ids:
            if content_id not in hidden_review_ids:
                hidden_review_ids.append(content_id)

        return {
            "generated_at": to_iso(now),
            "hidden_review_ids": hidden_review_ids,
            "hidden_long_term_review_ids": hidden_long_term_ids,
            "notifications": notifications,
            "long_term_summaries": long_term_summaries,
            "promoted_review_content_ids": promoted_ids,
            "conflict_resolutions": conflict_resolutions,
            "promotion_diagnostics": self._promotion_diagnostics,
            "algorithm3_input_summary": self._algorithm3_input_summary,
            "algorithm2_input_summary": algorithm2_meta,
            "promotion_mode": self.config.promotion_mode,
        }

    def _derive_long_term_summaries(
        self,
        contents: List[Dict[str, Any]],
        conflicts: List[Dict[str, Any]],
    ) -> Tuple[List[Dict[str, Any]], List[str], List[str], List[Dict[str, Any]]]:
        by_group: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
        current_content_ids = {str(content.get("id")) for content in contents}
        recent_db_short_terms = self._load_recent_short_terms_for_algorithm3()
        candidates_by_id: Dict[str, Dict[str, Any]] = {
            str(content.get("id")): content for content in recent_db_short_terms
        }
        # Freshly classified values from this batch override a DB copy.
        candidates_by_id.update({str(content.get("id")): content for content in contents})
        max_window_start = self.config.now - timedelta(
            days=self._max_observation_window_days()
        )
        contents_by_id: Dict[str, Dict[str, Any]] = {
            str(content.get("id")): content for content in contents
        }
        conflicts_by_new_id: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for conflict in conflicts:
            new_content_id = conflict.get("new_content_id")
            if new_content_id:
                conflicts_by_new_id[str(new_content_id)].append(conflict)

        # DB applied the largest window. Apply the topic-specific window before
        # grouping, so expired observations never enter a group or cluster.
        for content in candidates_by_id.values():
            if content.get("time_label") != "short-term":
                continue
            created_at = parse_iso(content.get("created_at"))
            if created_at is None or created_at < max_window_start:
                continue
            topic = str(content.get("main_topic") or "other")
            rule = self._observation_rule_for_topic(topic)
            topic_window_start = self.config.now - timedelta(
                days=int(rule["window_days"])
            )
            if created_at < topic_window_start:
                continue
            key = (str(content.get("place_id")), topic)
            by_group[key].append(content)

        self._algorithm3_input_summary = {
            "max_observation_window_days": self._max_observation_window_days(),
            "db_short_term_count_in_max_window": len(recent_db_short_terms),
            "deduplicated_content_count": len(candidates_by_id),
            "topic_window_candidate_count": sum(len(items) for items in by_group.values()),
            "group_count": len(by_group),
        }

        summaries: List[Dict[str, Any]] = []
        promoted_content_ids: List[str] = []
        hidden_long_term_ids: List[str] = []
        conflict_resolutions: List[Dict[str, Any]] = []

        for (place_id, topic), group_items in by_group.items():
            rule = self._observation_rule_for_topic(topic)
            window_days = int(rule["window_days"])
            threshold = int(rule["threshold"])
            sim_threshold = float(rule["sim_threshold"])
            candidates = group_items

            group_diag = {
                "place_id": place_id,
                "topic": topic,
                "short_term_count": len(group_items),
                "candidate_count_in_window": len(candidates),
                "required_support_count": threshold,
                "sim_threshold": sim_threshold,
                "window_days": window_days,
                "clusters": [],
                "status": "pending",
            }
            self._promotion_diagnostics.append(group_diag)

            if len(candidates) < threshold:
                group_diag["status"] = "not_enough_candidates_in_window"
                continue

            clusters: List[List[Dict[str, Any]]] = []
            for item in sorted(candidates, key=lambda x: x["created_at"]):
                placed = False
                for cluster in clusters:
                    cluster_sim = max(self._review_similarity(item, other) for other in cluster)
                    if cluster_sim >= sim_threshold:
                        cluster.append(item)
                        placed = True
                        break
                if not placed:
                    clusters.append([item])

            for cluster in clusters:
                group_diag["clusters"].append({
                    "size": len(cluster),
                    "review_content_ids": [str(item.get("id")) for item in cluster],
                    "cohesion": float(round(self._cluster_cohesion(cluster), 4)),
                })
            group_diag["status"] = "clusters_built"

            for cluster in clusters:
                if len(cluster) < threshold:
                    continue

                representative = max(cluster, key=lambda x: (x.get("stars", 0), len(x.get("content", ""))))
                sentiment_counter = Counter(
                    self._sentiment_label(item["sentiment_scores"]) for item in cluster
                )
                sentiment_consistency = self._sentiment_consistency(sentiment_counter, len(cluster))
                cluster_cohesion = self._cluster_cohesion(cluster)
                cluster_conflicts = [
                    conflict
                    for item in cluster
                    for conflict in conflicts_by_new_id.get(str(item.get("id")), [])
                ]
                conflicting_old_ids = sorted({
                    str(conflict.get("old_content_id"))
                    for conflict in cluster_conflicts
                    if conflict.get("old_content_id")
                })
                avg_conflict_score = (
                    sum(float(conflict.get("conflict_score", 0.0)) for conflict in cluster_conflicts)
                    / len(cluster_conflicts)
                    if cluster_conflicts else 0.0
                )
                should_hide_old = self._has_strong_replacement_evidence(
                    support_count=len(cluster),
                    threshold=threshold,
                    avg_conflict_score=avg_conflict_score,
                    sentiment_consistency=sentiment_consistency,
                    cluster_cohesion=cluster_cohesion,
                    sim_threshold=sim_threshold,
                    has_conflicting_old=bool(conflicting_old_ids),
                )

                summary_id = str(uuid.uuid4())
                summaries.append({
                    "id": summary_id,
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
                        "neutral": int(sentiment_counter.get("neutral", 0)),
                        "negative": int(sentiment_counter.get("negative", 0)),
                    },
                    "sentiment_consistency": float(round(sentiment_consistency, 4)),
                    "cluster_cohesion": float(round(cluster_cohesion, 4)),
                    "conflicting_long_term_content_ids": conflicting_old_ids,
                    "avg_conflict_score": float(round(avg_conflict_score, 4)),
                    "replacement_evidence": (
                        "strong"
                        if should_hide_old
                        else ("insufficient" if conflicting_old_ids else "none")
                    ),
                    "long_term_derived_at": to_iso(self.config.now),
                })

                targets = cluster if self.config.promotion_mode == "all" else [representative]
                for target in targets:
                    target["time_label"] = "long-term"
                    target["is_temporary"] = False
                    target["expiration_date"] = None
                    promoted_content_ids.append(target["id"])
                    if str(target.get("id")) not in current_content_ids:
                        self.algorithm3_historical_updates.append(target)

                if conflicting_old_ids:
                    action = "hide" if should_hide_old else "keep"
                    reason = (
                        "strong_repeated_conflicting_short_term_evidence"
                        if should_hide_old
                        else "promoted_cluster_not_strong_enough_to_hide_old_long_term"
                    )
                    for old_id in conflicting_old_ids:
                        old_content = contents_by_id.get(old_id)
                        if should_hide_old:
                            if old_id not in hidden_long_term_ids:
                                hidden_long_term_ids.append(old_id)
                            if old_content is not None:
                                old_content["is_hidden"] = True
                                old_content["hidden_reason"] = "superseded_by_promoted_long_term_summary"
                                old_content["superseded_by_summary_id"] = summary_id
                        conflict_resolutions.append({
                            "old_content_id": old_id,
                            "new_summary_id": summary_id,
                            "action": action,
                            "reason": reason,
                            "support_count": len(cluster),
                            "required_support_count": threshold + REPLACEMENT_EXTRA_SUPPORT,
                            "avg_conflict_score": float(round(avg_conflict_score, 4)),
                            "required_conflict_score": REPLACEMENT_CONFLICT_SCORE_THRESHOLD,
                            "sentiment_consistency": float(round(sentiment_consistency, 4)),
                            "required_sentiment_consistency": REPLACEMENT_SENTIMENT_CONSISTENCY_THRESHOLD,
                            "cluster_cohesion": float(round(cluster_cohesion, 4)),
                            "required_cluster_cohesion": float(round(
                                min(1.0, sim_threshold + REPLACEMENT_COHESION_MARGIN), 4
                            )),
                        })

                group_diag["status"] = "promoted"

        return summaries, promoted_content_ids, hidden_long_term_ids, conflict_resolutions

    def _sentiment_consistency(self, sentiment_counter: Counter, cluster_size: int) -> float:
        if cluster_size <= 0 or not sentiment_counter:
            return 0.0
        return float(max(sentiment_counter.values()) / cluster_size)

    def _cluster_cohesion(self, cluster: List[Dict[str, Any]]) -> float:
        if len(cluster) < 2:
            return 1.0
        sims: List[float] = []
        for i, left in enumerate(cluster):
            for right in cluster[i + 1:]:
                sims.append(self._review_similarity(left, right))
        return float(sum(sims) / len(sims)) if sims else 1.0

    def _has_strong_replacement_evidence(
        self,
        support_count: int,
        threshold: int,
        avg_conflict_score: float,
        sentiment_consistency: float,
        cluster_cohesion: float,
        sim_threshold: float,
        has_conflicting_old: bool,
    ) -> bool:
        if not has_conflicting_old:
            return False
        required_support = threshold + REPLACEMENT_EXTRA_SUPPORT
        required_cohesion = min(1.0, sim_threshold + REPLACEMENT_COHESION_MARGIN)
        return (
            support_count >= required_support
            and avg_conflict_score >= REPLACEMENT_CONFLICT_SCORE_THRESHOLD
            and sentiment_consistency >= REPLACEMENT_SENTIMENT_CONSISTENCY_THRESHOLD
            and cluster_cohesion >= required_cohesion
        )

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


def _content_review_ids(client, content_ids: List[str]) -> List[str]:
    """Resolve review IDs for review_content IDs in bounded REST requests."""
    unique_content_ids = list(dict.fromkeys(str(value) for value in content_ids if value))
    review_ids: List[str] = []
    resolved_content_ids = set()
    for i in range(0, len(unique_content_ids), _DB_BATCH):
        chunk = unique_content_ids[i : i + _DB_BATCH]
        response = (
            client
            .schema("review_ai")
            .from_("review_contents")
            .select("id,review_id")
            .in_("id", chunk)
            .execute()
        )
        for row in response.data or []:
            if row.get("id") and row.get("review_id"):
                resolved_content_ids.add(str(row["id"]))
                review_ids.append(str(row["review_id"]))

    unresolved = set(unique_content_ids) - resolved_content_ids
    if unresolved:
        raise RuntimeError(
            "Cannot resolve review_id for review_contents: "
            + ", ".join(sorted(unresolved))
        )
    return list(dict.fromkeys(review_ids))


def _expired_short_term_review_ids(client, now_iso: str) -> List[str]:
    """Load expired short-term reviews that are still approved."""
    review_ids: List[str] = []
    offset = 0
    while True:
        response = (
            client
            .schema("review_ai")
            .from_("review_contents")
            .select("review_id,reviews!inner(status)")
            .eq("time_label", "short-term")
            .lte("expiration_date", now_iso)
            .eq("reviews.status", "approved")
            .range(offset, offset + _DB_BATCH - 1)
            .execute()
        )
        rows = response.data or []
        review_ids.extend(
            str(row["review_id"])
            for row in rows
            if row.get("review_id")
        )
        if len(rows) < _DB_BATCH:
            break
        offset += _DB_BATCH
    return list(dict.fromkeys(review_ids))


def apply_algorithm3_db_updates(
    client,
    result: Dict[str, Any],
    now_iso: str,
) -> Dict[str, int]:
    """Persist Algorithm 3 visibility and promotion decisions."""
    promoted_content_ids = list(
        dict.fromkeys(
            str(value)
            for value in result.get("promoted_review_content_ids", [])
            if value
        )
    )
    hidden_long_term_content_ids = list(
        dict.fromkeys(
            str(value)
            for value in result.get("hidden_long_term_review_ids", [])
            if value
        )
    )

    # Make promotion persistence explicit. This also covers historical
    # short-term contents that were not part of the current pending batch.
    for i in range(0, len(promoted_content_ids), _DB_BATCH):
        chunk = promoted_content_ids[i : i + _DB_BATCH]
        (
            client
            .schema("review_ai")
            .from_("review_contents")
            .update({
                "time_label": "long-term",
                "expiration_date": None,
                "is_temporary": False,
            })
            .in_("id", chunk)
            .execute()
        )

    expired_review_ids = _expired_short_term_review_ids(client, now_iso)
    hidden_long_term_review_ids = _content_review_ids(
        client, hidden_long_term_content_ids
    )
    for i in range(0, len(expired_review_ids), _DB_BATCH):
        chunk = expired_review_ids[i : i + _DB_BATCH]
        (
            client
            .schema("review_ai")
            .from_("reviews")
            .update({
                "status": "hidden",
                "hidden_reason": "Đánh giá ngắn hạn đã hết hiệu lực",
                "hidden_at": now_iso,
            })
            .eq("status", "approved")
            .in_("id", chunk)
            .execute()
        )

    for i in range(0, len(hidden_long_term_review_ids), _DB_BATCH):
        chunk = hidden_long_term_review_ids[i : i + _DB_BATCH]
        (
            client
            .schema("review_ai")
            .from_("reviews")
            .update({
                "status": "hidden",
                "hidden_reason": "Đánh giá dài hạn này đã được thay thế bởi bản tổng hợp dài hạn mới",
                "hidden_at": now_iso,
            })
            .in_("id", chunk)
            .execute()
        )

    promoted_review_ids = _content_review_ids(client, promoted_content_ids)
    for i in range(0, len(promoted_review_ids), _DB_BATCH):
        chunk = promoted_review_ids[i : i + _DB_BATCH]
        (
            client
            .schema("review_ai")
            .from_("reviews")
            .update({
                "status": "approved",
                "hidden_reason": None,
                "hidden_at": None,
            })
            .eq("status", "hidden")
            .in_("id", chunk)
            .execute()
        )

    return {
        "expired_reviews_hidden": len(expired_review_ids),
        "long_term_reviews_hidden": len(hidden_long_term_review_ids),
        "contents_promoted": len(promoted_content_ids),
        "promoted_reviews_checked": len(promoted_review_ids),
    }


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


def mark_conflicted_contents(client, conflicts: List[Dict[str, Any]]) -> None:
    conflict_ids = {
        content_id
        for conflict in conflicts
        for content_id in (conflict.get("new_content_id"), conflict.get("old_content_id"))
        if content_id
    }
    for content_id in conflict_ids:
        (
            client
            .schema("review_ai")
            .from_("review_contents")
            .update({"has_conflict": True})
            .eq("id", content_id)
            .execute()
        )
