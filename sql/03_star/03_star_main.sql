-- sql/90_checks/01_check_pipeline.sql
-- 主線採 #4：可重播驗收流水線 + v_tel_healthcheck

USE tel_bi;

-- Gate 0：Session / DB context
SELECT DATABASE() AS current_db, @@version AS mysql_version;
SELECT @@sql_mode AS sql_mode;

-- Gate 1：Base table 狀態
SHOW TABLES LIKE 'SinoPac_raw_a';
SHOW TABLES LIKE 'sinopac_txn_labels';

SELECT
  COUNT(*) AS raw_cnt,
  MIN(txn_date) AS min_date,
  MAX(txn_date) AS max_date
FROM SinoPac_raw_a;

SELECT id, COUNT(*) AS dup_cnt
FROM SinoPac_raw_a
GROUP BY id
HAVING COUNT(*) > 1
LIMIT 20;

-- Gate 2：金額欄位完整性
SELECT
  id, txn_date, summary, deposit_amount, withdraw_amount, balance, note
FROM SinoPac_raw_a
WHERE deposit_amount IS NULL AND withdraw_amount IS NULL
ORDER BY txn_date, id
LIMIT 50;

SELECT
  id, txn_date, summary, deposit_amount, withdraw_amount, balance, note
FROM SinoPac_raw_a
WHERE deposit_amount IS NOT NULL AND withdraw_amount IS NOT NULL
ORDER BY txn_date, id
LIMIT 50;

-- Gate 3：v_SinoPac_pretty
SHOW FULL TABLES
WHERE Table_type = 'VIEW'
  AND Tables_in_tel_bi IN ('v_SinoPac_pretty','v_fact_txn_pretty');

SELECT COUNT(*) AS pretty_cnt FROM v_SinoPac_pretty;

SELECT
  SUM(`flag_金額缺失` IS NULL) AS flag_null_cnt,
  SUM(`flag_金額缺失` NOT IN (0,1)) AS flag_bad_cnt
FROM v_SinoPac_pretty;

SELECT
  `ID`, `日期`, `摘要`, `存入_raw`, `支出_raw`, `餘額`, `原始備註`, `flag_金額缺失`
FROM v_SinoPac_pretty
WHERE `flag_金額缺失` = 1
ORDER BY `日期`, `ID`
LIMIT 50;

-- Gate 4：v_fact_txn_pretty（API 合約）
SELECT COUNT(*) AS api_cnt FROM v_fact_txn_pretty;

SELECT
  SUM(amount IS NULL) AS amount_null_cnt,
  SUM(flag_missing_amount IS NULL) AS flag_null_cnt,
  SUM(flag_missing_amount NOT IN (0,1)) AS flag_bad_cnt
FROM v_fact_txn_pretty;

SELECT *
FROM v_fact_txn_pretty
ORDER BY txn_date DESC, txn_id DESC
LIMIT 10;

-- Gate 5：healthcheck view
DROP VIEW IF EXISTS v_tel_healthcheck;

CREATE VIEW v_tel_healthcheck AS
SELECT
  'v_SinoPac_pretty' AS object_name,
  (SELECT COUNT(*) FROM v_SinoPac_pretty) AS row_cnt,
  (SELECT SUM(`flag_金額缺失`=1) FROM v_SinoPac_pretty) AS missing_amount_rows
UNION ALL
SELECT
  'v_fact_txn_pretty' AS object_name,
  (SELECT COUNT(*) FROM v_fact_txn_pretty) AS row_cnt,
  (SELECT SUM(flag_missing_amount=1) FROM v_fact_txn_pretty) AS missing_amount_rows;

SELECT * FROM v_tel_healthcheck;
