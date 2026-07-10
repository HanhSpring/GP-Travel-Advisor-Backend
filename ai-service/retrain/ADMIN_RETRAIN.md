# Admin local retrain

This integration runs `retrain_pipeline.py` on the machine/container hosting the
AI service. It never invokes or modifies the Colab wrapper and does not use the
Colab Drive state/output directories.

## One-time setup

1. Run `api-service/sql/2026_recommender_retrain_admin.sql` in Supabase SQL Editor.
2. Install local training dependencies:

   ```powershell
   pip install -r retrain/requirements.txt
   ```

3. Ensure the AI service `.env` has Supabase, rating-matrix and optional R2
   configuration. `RETRAIN_RESTART_CMD` is ignored for Admin jobs because the
   service hot-reloads the model safely after training.
4. Restart both API service and AI service, then open Admin > Algorithm Runner.

## Use Google Drive base input through R2

Upload once from a Colab runtime after mounting Google Drive:

```bash
python retrain/upload_base_matrix_to_r2.py \
  --source-dir "/content/drive/MyDrive/Recommender System"
```

The uploader accepts either the `rating_matrix_foody.*` names or the legacy
`rating_matrix.*` names, and always stores canonical objects at:

```text
base_training_data/rating_matrix_foody.npz
base_training_data/rating_matrix_foody_users.csv
base_training_data/rating_matrix_foody_items.csv
```

After the upload succeeds, configure local/Admin AI service `.env`:

```env
RETRAIN_BASE_RATING_SOURCE=r2
R2_BASE_TRAINING_PREFIX=base_training_data
RETRAIN_BASE_RATING_CACHE_DIR=E:/tmp/retrain_base_rating
```

Every local retrain checks R2 metadata and downloads only missing or changed
files. Downloads use a `.part` file plus size/SHA-256 verification before replacing
the cache. The existing Colab retrain wrapper remains unchanged.

## Behavior

- Manual runs use `--force`.
- Scheduled runs use change detection and can finish without retraining when no
  places, reviews or activity logs changed.
- Only one pending/running job is allowed per recommender algorithm.
- At most 50 jobs can be created for the demo.
- `training_runs` stores progress/results; `model_versions` stores promoted
  artifact metrics; `algorithm_logs` stores audit messages.
- The UI polls every three seconds and reports rating-only/hybrid RMSE after a
  successful run.
