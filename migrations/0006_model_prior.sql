-- 学習の起点にした事前重み(一目均衡表はバックテスト由来で変わるため記録)
ALTER TABLE model_log ADD COLUMN prior_json TEXT;
