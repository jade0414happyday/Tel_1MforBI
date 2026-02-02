-- sql/90_checks/20_check_v_fact_txn_pretty.sql
--  ت  G ꦺ v_fact_txn_pretty API  X   P 򥻸 ƫ~  ]single-row result ^
--   ɡG u   SELECT F ̫ u ^ 1 row F i w  ʥ    ]missing_cols ^

USE tel_bi;

-- 0) view exists
SELECT
  COUNT(*) INTO @view_exists_cnt
FROM information_schema.VIEWS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'v_fact_txn_pretty';

-- 1) required columns exist (contract)
SELECT
  SUM(CASE WHEN c.COLUMN_NAME IS NULL THEN 1 ELSE 0 END) AS missing_cnt,
  GROUP_CONCAT(rc.col ORDER BY rc.col SEPARATOR ',') AS missing_cols
INTO @missing_required_cnt, @missing_required_cols
FROM (
  SELECT 'txn_id' AS col
  UNION ALL SELECT 'txn_date'
  UNION ALL SELECT 'amount'
  UNION ALL SELECT 'bank_name'
  UNION ALL SELECT 'account_book'
  UNION ALL SELECT 'bank_code'
  UNION ALL SELECT 'flag_missing_amount'
) rc
LEFT JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = DATABASE()
 AND c.TABLE_NAME = 'v_fact_txn_pretty'
 AND c.COLUMN_NAME = rc.col
WHERE c.COLUMN_NAME IS NULL;

-- 2) data constraints + row count (single scan)
--  ` N G   q   ] view  w b D u إߧ    F Y view    s b |         ] ŦX fail-fast ^
SELECT
  COUNT(*) AS total_rows,
  SUM(CASE WHEN amount IS NULL THEN 1 ELSE 0 END) AS amount_null_cnt,
  SUM(CASE WHEN txn_date IS NULL THEN 1 ELSE 0 END) AS txn_date_null_cnt,
  SUM(CASE WHEN flag_missing_amount IS NULL OR flag_missing_amount NOT IN (0,1) THEN 1 ELSE 0 END) AS flag_missing_amount_bad_cnt,
  SUM(CASE WHEN bank_code IS NULL OR TRIM(bank_code) = '' THEN 1 ELSE 0 END) AS bank_code_blank_cnt,
  SUM(CASE WHEN account_book IS NULL OR TRIM(account_book) = '' THEN 1 ELSE 0 END) AS account_book_blank_cnt
INTO
  @total_rows,
  @amount_null_cnt,
  @txn_date_null_cnt,
  @flag_bad_cnt,
  @bank_code_blank_cnt,
  @account_book_blank_cnt
FROM v_fact_txn_pretty;

-- 3) final single-row verdict (1 row)
SELECT
  'v_fact_txn_pretty_contract' AS check_name,
  CASE
    WHEN @view_exists_cnt = 1
     AND IFNULL(@missing_required_cnt, 0) = 0
     AND @total_rows > 0
     AND @amount_null_cnt = 0
     AND @txn_date_null_cnt = 0
     AND @flag_bad_cnt = 0
     AND @bank_code_blank_cnt = 0
     AND @account_book_blank_cnt = 0
    THEN 'OK' ELSE 'FAIL'
  END AS status,
  -- fail_cnt_total G A n ݪ   @   e ]     = 0 ^
  (
    (CASE WHEN @view_exists_cnt = 1 THEN 0 ELSE 1 END)
    + IFNULL(@missing_required_cnt, 0)
    + (CASE WHEN @total_rows > 0 THEN 0 ELSE 1 END)
    + @amount_null_cnt
    + @txn_date_null_cnt
    + @flag_bad_cnt
    + @bank_code_blank_cnt
    + @account_book_blank_cnt
  ) AS fail_cnt_total,
  --  w     / W h
  @view_exists_cnt AS view_exists_cnt,
  IFNULL(@missing_required_cnt, 0) AS missing_required_cnt,
  IFNULL(@missing_required_cols, '') AS missing_required_cols,
  @total_rows AS total_rows,
  @amount_null_cnt AS amount_null_cnt,
  @txn_date_null_cnt AS txn_date_null_cnt,
  @flag_bad_cnt AS flag_missing_amount_bad_cnt,
  @bank_code_blank_cnt AS bank_code_blank_cnt,
  @account_book_blank_cnt AS account_book_blank_cnt;
