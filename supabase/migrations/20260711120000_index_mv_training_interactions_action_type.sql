-- Ho tro loc "chi giu rating/review/visited" (STRONG_SIGNAL_ACTION_TYPES) dang duoc dung o 2
-- noi: export_training_data.py::load_interactions() (Phase 0 export cho Two-Tower) va
-- AlgorithmTrainingService.detectTrainingDataChange() (change-detection truoc khi export lai,
-- xem docs/trigger/08-performance-fixes-and-current-flow.md muc 4). Truoc migration nay,
-- mv_training_interactions chi co index tren (created_at) va 1 unique composite voi action_type
-- o vi tri thu 3 (khong dung duoc lam dieu kien loc chinh) -- WHERE action_type IN (...) phai
-- seq-scan toan bo materialized view. Dat action_type truoc trong composite vi ca 2 noi tren deu
-- loc theo action_type roi moi sap xep/lay max theo created_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_mv_training_interactions_action_type_created_at
  ON travel.mv_training_interactions USING btree (action_type, created_at DESC);
