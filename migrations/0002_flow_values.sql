-- 金額(円)。オプションはプレミアム代金
ALTER TABLE flows ADD COLUMN sell_value INTEGER;
ALTER TABLE flows ADD COLUMN buy_value INTEGER;
