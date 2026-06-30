#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
review_filter_local_new.py

Local Supabase runner for the short-term review filtering pipeline.
Reads pending review contents from review_ai.review_contents joined to review_ai.reviews,
then writes Algorithm 1 results back to review_ai.review_contents and Algorithm 2
conflicts to review_ai.review_conflicts.

Configuration is loaded from a .env file. Required:
    SUPABASE_URL
    SUPABASE_KEY

Optional:
    SUPABASE_SCHEMA=review_ai
    SUPABASE_BATCH_SIZE=500
    SUPABASE_LIMIT=
    USE_PRETRAINED_MODEL=true
    USE_PRETRAINED_CLASSIFIERS=true
    PHOBERT_TIME_MODEL=
"""

from __future__ import annotations

import os
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
    ],
    "crowd": [
        "dong duc", "qua dong", "qua tai", "xep hang", "cho doi", "it khach",
        "kin cho", "het cho", "chen chuc", "nhieu nguoi", "day nguoi",
        "vang ve", "dong khach", "nhieu khach", "thieu khach",
        "hang dai", "cho lau", "trong vang",
        "chen lan", "qua tai", "khong con cho", "ghe trong", "ban trong",
        "gio cao diem", "cuoi tuan dong", "dong nguoi", "vang lanh",
        "doi hang", "doi vo", "cho hang tieng", "chen vao",
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
        "gia tot", "gia binh dan", "binh dan", "sang chanh",
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
        "on ao", "yen ang", "thoang mat", "am cung",
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
        "bãi đỗ xe, chỗ đậu xe, phương tiện, đường xá xung quanh."
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
    "ve sinh", "sach", "nhanh", "hieu qua", "tien loi",
    "phong phu", "da dang", "da chon lua", "nhieu lua chon",
    "gia tri", "xung dang", "xung tam", "tuyet hao",
    "rat thich", "thich lam", "quy lam", "quy",
    "rat dang", "se quay lai", "nhat dinh quay lai", "recommend",
    "goi y", "de xuat", "dang thu", "nen thu", "nen den",
]

NEGATIVE_WORDS: List[str] = [
    "te", "toi", "that vong", "xau", "kinh khung", "khong hai long",
    "qua dat", "cho lau", "om ao", "ban", "on ao", "kem chat luong",
    "that bai", "kem", "lua dao", "chan nan", "kho chiu", "bat man",
    "cham tre", "phuc vu kem", "nhan vien thu", "tho lo",
    "khong sach", "bat tien", "mat vi", "khong ngon", "nhieu loi",
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
    "dat ma khong ngon", "dat ma kem", "dat vo ly",
    "ban biu", "ban thiu", "o ban", "khong ve sinh",
    "hoi", "con trung", "gian", "ruoi", "mut",
    "cho lau qua", "cho mai", "doi rat lau",
    "khong nhan", "tu choi", "vo ly", "lo lang",
    "kho chiu qua", "phat buc", "tuc gian", "that kinh",
]

# Lighter models chosen for best accuracy-to-size trade-off on Vietnamese text.
# paraphrase-multilingual-MiniLM-L12-v2: ~420MB, strong multilingual sentence embeddings.
DEFAULT_EMBEDDING_MODEL  = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DEFAULT_TOPIC_MODEL      = "intfloat/multilingual-e5-small"
# lxyuan/distilbert-base-multilingual-cased-sentiments-student: ~260MB (DistilBERT),
# outputs positive/neutral/negative directly — simpler and lighter than star-rating models.
DEFAULT_SENTIMENT_MODEL = "lxyuan/distilbert-base-multilingual-cased-sentiments-student"
# MoritzLaurer/mDeBERTa-v3-base-mnli-xnli: ~550MB, best multilingual NLI balance,
# handles Vietnamese well for topic and time_label zero-shot classification.
DEFAULT_ZEROSHOT_MODEL = "MoritzLaurer/mDeBERTa-v3-base-mnli-xnli"


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


# Vietnamese negation tokens (normalized/no-diacritic form).
_VI_NEG_TOKENS = frozenset({"khong", "chang", "chua", "dung", "khoi"})

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

    eff_pos = 0
    eff_neg = 0

    for kw in positive_kws:
        parts = kw.split()
        if len(parts) == 1:
            for i, tok in enumerate(token_list):
                if tok == kw:
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
    candidate_mode: str
    top_k: int
    old_lookback_multiplier: int
    promotion_mode: str
    conflict_score_threshold: float = 0.65
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

    def embed(self, normalized_text: str, tokens: List[str]) -> List[float]:
        if self.model_active and self._model is not None and self._tokenizer is not None:
            try:
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
            except Exception:
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
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        self._torch = torch
        self._tokenizer = AutoTokenizer.from_pretrained(model_name)
        self._model = _from_pretrained_safe(AutoModelForSequenceClassification, model_name)
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

    Loaded from a local model path configured with PHOBERT_TIME_MODEL.
    """

    def __init__(self, model_path: str, device):
        try:
            import sentencepiece  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "Install sentencepiece before using PHOBERT_TIME_MODEL: pip install sentencepiece"
            ) from exc

        import torch
        from transformers import AutoTokenizer, AutoModelForSequenceClassification
        self._torch = torch

        try:
            self._tokenizer = AutoTokenizer.from_pretrained(model_path, use_fast=False)
        except Exception:
            self._tokenizer = AutoTokenizer.from_pretrained("vinai/phobert-base", use_fast=False)

        self._model = _from_pretrained_safe(AutoModelForSequenceClassification, model_path)
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
    """Zero-shot topic classifier using intfloat/multilingual-e5-small.

    E5 models are trained for query-document retrieval, which maps directly to
    "does this review belong to this topic?" — a much better fit than NLI entailment
    or paraphrase detection. No fine-tuning required; topic descriptions in Vietnamese
    with full diacritics give good zero-shot accuracy across domains.
    """

    def __init__(self, use_pretrained_classifiers: bool, model_name: str):
        self.active = False
        self.error: Optional[str] = None
        self._model = None
        self._tokenizer = None
        self._torch = None
        self._label_embs = None  # cached after first call

        if not use_pretrained_classifiers:
            return
        try:
            import torch
            from transformers import AutoTokenizer, AutoModel
            _device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
            self._tokenizer = AutoTokenizer.from_pretrained(model_name)
            self._model = _from_pretrained_safe(AutoModel, model_name)
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
            # "query: " prefix per E5 convention; use raw text WITH diacritics.
            query_emb = self._encode([f"query: {raw_text}"])[0]
            raw_scores = {
                topic: float(self._torch.dot(query_emb, lemb).cpu())
                for topic, lemb in label_embs.items()
            }
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
        self.short_term_confidence_threshold = max(0.75, confidence_threshold)
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

        # E5 topic classifier loads independently — a failure doesn't block sentiment/NLI.
        self.topic_classifier = TopicE5Classifier(use_pretrained_classifiers, topic_model_name)

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
            raw = self.sentiment_pipeline(text, top_k=None)
            rows = raw[0] if (isinstance(raw, list) and raw and isinstance(raw[0], list)) else (raw if isinstance(raw, list) else [raw])

            label_to_score: Dict[str, float] = {
                str(item.get("label", "")).lower().strip(): float(item.get("score", 0.0))
                for item in rows
            }

            # Direct pos/neu/neg output (e.g. lxyuan/distilbert-base-multilingual-cased-sentiments-student).
            pos = label_to_score.get("positive", 0.0)
            neu = label_to_score.get("neutral", 0.0)
            neg = label_to_score.get("negative", 0.0)
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
        except Exception:
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

    def predict_time_label(self, text: str) -> Optional[Tuple[str, Optional[Dict[str, str]]]]:
        """Returns (time_label, error_info) or None if PhoBERT is unavailable.

        Chỉ sử dụng PhoBERT fine-tuned. Trả về None khi model chưa được tải,
        lúc đó pipeline sẽ gán "amb".
        """
        if not self.phobert_time_active or self.phobert_time_classifier is None:
            return None
        try:
            scores = self.phobert_time_classifier(text)
            sorted_items = sorted(scores.items(), key=lambda x: x[1], reverse=True)
            top_label, top_score = sorted_items[0]
            second_score = sorted_items[1][1] if len(sorted_items) > 1 else 0.0
            margin = top_score - second_score

            required_confidence = (
                self.short_term_confidence_threshold
                if top_label == "short-term"
                else self.confidence_threshold
            )

            if top_score < required_confidence:
                return (
                    "amb",
                    {
                        "code": "weak_temporal_signal_phobert",
                        "predicted_label": top_label,
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
                        "message": f"PhoBERT không phân biệt rõ (margin={margin:.2f}) ngắn hạn hay dài hạn.",
                    },
                )
            return top_label, None
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

class ReviewFilteringPipeline:
    def __init__(self, config: PipelineConfig, supabase_client: Optional[Any] = None):
        self.config = config
        self.supabase = supabase_client
        if self.supabase is None and config.supabase_url and config.supabase_key:
            if create_client is None:
                raise ImportError("supabase-py not installed. Run: pip install supabase")
            self.supabase = create_client(config.supabase_url, config.supabase_key)
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
            "algorithm2_candidate_mode": self.config.candidate_mode,
            "algorithm2_top_k": self.config.top_k,
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

                content_db_id = review.get("content_db_id")
                place_id = review.get("place_id") or review.get("business_id") or "supabase"

                outputs.append({
                    "id": str(content_db_id or uuid.uuid4()),
                    "content_db_id": content_db_id,
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
                content_db_id = review.get("content_db_id")
                outputs.append({
                    "id": str(content_db_id or uuid.uuid4()),
                    "content_db_id": content_db_id,
                    "review_id": review.get("review_id"),
                    "place_id": review.get("place_id") or review.get("business_id") or "supabase",
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
        infra = ev("infra")
        crowd = ev("crowd")
        price_false_positive = any(
            phrase in norm_text
            for phrase in (
                "danh gia cao", "duoc danh gia cao", "review cao",
            )
        )
        price_amount_pattern = bool(
            re.search(r"\b\d+\s*(k|ngan|nghin|trieu|vnd)\b", norm_text)
            or re.search(r"\b\d{2,3}\s?000\b", norm_text)
        )
        standalone_price_word = (
            bool(re.search(r"\bgia\b", norm_text))
            and not any(
                phrase in norm_text
                for phrase in ("danh gia", "duoc danh gia", "review gia", "gia dinh", "gia vi")
            )
        )
        explicit_price_pattern = any(
            phrase in norm_text
            for phrase in (
                "mien phi", "phi vao cua", "gia ve", "gia vao", "gia phong",
                "gia menu", "mat phi", "ton tien", "bao nhieu tien",
                "muc gia", "gia cao", "gia hoi cao", "gia qua cao",
                "so voi ngay thuong", "qua dat", "khong qua dat",
                "gia ca", "gia tien", "gia hop ly", "gia re", "dat qua",
                "re qua", "gia mac", "qua mac", "khong qua mac", "kha mac",
                "hoi mac", "xung dang", "dang dong tien", "phi dich vu",
            )
        ) or standalone_price_word
        price_pattern = price_amount_pattern or explicit_price_pattern
        if price_false_positive:
            price_pattern = False
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
        strong_food_pattern = any(
            phrase in norm_text
            for phrase in (
                "pho", "pho bo", "bat pho", "com", "bun", "bun ca", "bun rieu",
                "banh chung", "gio cha", "cha ca", "xoi", "sua chua",
                "do an", "mon an", "thuc an", "do uong", "nuoc dung",
                "nuoc leo", "thit", "gan", "quay", "mam", "dac san",
                "an ngon", "ngon", "mem", "thom", "nhat", "man", "ngot",
            )
        )
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
        if ev("price") >= 2:
            if price_false_positive:
                adjusted["price"] = adjusted.get("price", 0.0) * 0.70
            elif heavy_infra_pattern or infra_pattern:
                adjusted["price"] = adjusted.get("price", 0.0) * (1.05 if explicit_price_pattern else 0.85)
            elif price_amount_pattern and not explicit_price_pattern and (activity >= 1 or food >= 1 or infra >= 1):
                adjusted["price"] = adjusted.get("price", 0.0) * 0.90
            elif explicit_price_pattern:
                adjusted["price"] = adjusted.get("price", 0.0) * 1.42
            else:
                adjusted["price"] = adjusted.get("price", 0.0) * 1.15
        elif price_pattern:
            adjusted["price"] = adjusted.get("price", 0.0) * (1.50 if explicit_price_pattern else 1.12)
            if food <= 1:
                adjusted["food"] = adjusted.get("food", 0.0) * 0.90
            if activity <= 1:
                adjusted["activity"] = adjusted.get("activity", 0.0) * 0.92
        if crowd >= 2:
            adjusted["crowd"] = adjusted.get("crowd", 0.0) * 1.25
            if not infra_pattern:
                adjusted["infra"] = adjusted.get("infra", 0.0) * 0.90
        elif crowd == 1 and any(
            phrase in norm_text
            for phrase in ("dong nguoi", "nhieu nguoi", "xep hang", "cho doi", "chen chuc")
        ):
            adjusted["crowd"] = adjusted.get("crowd", 0.0) * 1.18
        if strong_service_pattern and ev("weather") <= 1:
            adjusted["weather"] = adjusted.get("weather", 0.0) * 0.60
        if ev("weather") >= 2:
            adjusted["weather"] = adjusted.get("weather", 0.0) * 1.25

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
        keyword_raw: Dict[str, float] = {
            topic: float(count_keyword_hits(norm_text, keywords))
            for topic, keywords in TOPIC_KEYWORDS.items()
        }
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

            combined = self._apply_topic_decision_adjustments(combined, keyword_raw, norm_text)
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
        score_payload = self._apply_topic_decision_adjustments(score_payload, keyword_raw, norm_text)
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
        return "amb", {
            "code": "no_phobert_model",
            "message": "PhoBERT chưa được tải. Đặt --phobert-time-model để phân loại time_label.",
        }

    def _classify_sentiment(self, raw_text: str, norm_text: str, stars) -> Dict[str, float]:
        """Model first; stars + negation-aware keyword fallback when model unavailable."""
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

        # Negation-aware counting: "không ngon" → negative, "không tệ" → positive.
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
            sent_sentiment = self.classifier_provider.predict_sentiment(sent) or base_sentiment
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

            # Weighted-average sentiment direction across sentences for this topic,
            # then scaled by overall topic_score so _flatten_sentiment still works correctly.
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
                sim = cosine_similarity(content["embedding"], old["embedding"])
                if sim < 0.5:
                    continue

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
                sentiment_gap = self._sentiment_distance_for_topic(content, old, conflict_topic)
                conflict_score = 0.45 * adjusted_sim + 0.25 * sentiment_gap + 0.30 * p_contra

                if sim >= 0.8 or (sim >= 0.5 and nli_label == "contradiction"):
                    if conflict_score >= self.config.conflict_score_threshold:
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
            "current_review_old_count": len(current_review_olds),
            "historical_review_old_count": len(historical_review_olds),
            "total_pairs_examined": total_pairs_examined,
            "candidate_mode": self.config.candidate_mode,
            "top_k": self.config.top_k,
            "lookback_multiplier_default": self.config.old_lookback_multiplier,
            "lookback_multiplier_by_topic": self.config.lookback_multiplier_by_topic or ALGORITHM2_LOOKBACK_MULTIPLIER_BY_TOPIC,
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
        # Prefer topic-specific sentiment so unrelated content doesn't distort polarity.
        def _topic_polarity(review: Dict[str, Any]) -> float:
            if conflict_topic:
                t = review["sentiment_scores"].get(conflict_topic, {})
                tot = (t.get("positive", 0.0) + t.get("neutral", 0.0) + t.get("negative", 0.0))
                if tot > 0:
                    return (t.get("positive", 0.0) - t.get("negative", 0.0)) / tot
            flat = self._flatten_sentiment(review["sentiment_scores"])
            return flat["positive"] - flat["negative"]

        a_pol = _topic_polarity(a)  # range [-1, +1]
        b_pol = _topic_polarity(b)
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

        conflict_ids = {c["new_content_id"] for c in conflicts} | {c["old_content_id"] for c in conflicts}
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
        conflict_ids: set[str],
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
            rule = self._observation_rule_for_topic(topic)
            window_days = int(rule["window_days"])
            threshold = int(rule["threshold"])
            sim_threshold = float(rule["sim_threshold"])
            window_start = self.config.now - timedelta(days=window_days)

            candidates = [
                item for item in group_items
                if parse_iso(item["created_at"]) and parse_iso(item["created_at"]) >= window_start
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

                representative = max(cluster, key=lambda x: (x.get("stars", 0), len(x.get("content", ""))))
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
                        "neutral": int(sentiment_counter.get("neutral", 0)),
                        "negative": int(sentiment_counter.get("negative", 0)),
                    },
                    "long_term_derived_at": to_iso(self.config.now),
                })

                targets = cluster if self.config.promotion_mode == "all" else [representative]
                for target in targets:
                    target["time_label"] = "long-term"
                    target["is_temporary"] = False
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
