**Có Goong + có filter type**

```powershell
python -X utf8 .\scripts\tsp_tw_ga.py `
  --days 3 `
  --start 08:00 `
  --end 19:00 `
  --city-id 3b9a22b3-293b-5313-97c5-d9b71c30756f `
  --travel-cache .\scripts\travel_matrix_hcm_filtered_goong.json `
  --refresh-travel-cache `
```

**Có Goong + không filter type**

```powershell
python -X utf8 .\scripts\tsp_tw_ga.py --days 3 --start 08:00 --end 21:00 --city-id 3b9a22b3-293b-5313-97c5-d9b71c30756f --no-type-filter --travel-cache .\scripts\travel_matrix_hcm_all_types_goong.json
```

**Không Goong + có filter type**

```powershell
python -X utf8 .\scripts\tsp_tw_ga.py --days 3 --start 08:00 --end 21:00 --city-id 3b9a22b3-293b-5313-97c5-d9b71c30756f --no-goong
```

**Không Goong + không filter type**

```powershell
python -X utf8 .\scripts\tsp_tw_ga.py --days 3 --start 08:00 --end 21:00 --city-id 3b9a22b3-293b-5313-97c5-d9b71c30756f --no-goong --no-type-filter
```

Nếu muốn ép gọi lại Goong dù đã có cache, thêm:

```powershell
--refresh-travel-cache
```


Nếu muốn mình chạy lại bản 5 seed thực nghiệm

python -X utf8 .\scripts\run_ga_experiments.py --city-id 3b9a22b3-293b-5313-97c5-d9b71c30756f --limit 50 --days 3 --start 08:00 --end 21:00 --gen 200 --seeds 40,41,42,43,44 --no-goong


python -X utf8 .\scripts\tsp_tw_ga.py `
  --days 3 `
  --start 08:00 `
  --end 21:00 `
  --city-id 3b9a22b3-293b-5313-97c5-d9b71c30756f `
  --limit 50 `
  --seed 42 `
  --travel-cache .\scripts\travel_matrix_hcm_filtered_goong.json `
  --pop 50 `
  --mutation 0.30 `
  --early-stop-patience 30 `
  --alpha-travel 0.20 `
  --beta-wait 0.30
