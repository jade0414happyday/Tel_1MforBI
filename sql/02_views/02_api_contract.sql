-- sql/02_views/02_v_fact_txn_pretty_api.sql
-- API 合約 view：給 Node/Java 直接讀
-- 目標：
-- 1) amount NOT NULL
-- 2) flag_missing_amount 只出現 0/1
-- 3) 提供 API 合約欄位：account_book, bank_code（由 dim_account 推得）
--
-- 來源：
-- fact_txn (207 rows 已驗證)
-- dim_account(account_id, account_book, bank_name) 已驗證可 join
--
-- 注意：
-- channel/merchant/category 目前先用 UNKNOWN 佔位，避免 API 回空字串/NULL
-- 後續要接 dim_channel/dim_merchant/dim_category 時，一律用 LEFT JOIN + missing check

USE tel_bi;

DROP VIEW IF EXISTS v_fact_txn_pretty;

CREATE VIEW v_fact_txn_pretty AS
SELECT
  f.txn_id              AS txn_id,
  f.txn_date            AS txn_date,
  COALESCE(f.amount, 0) AS amount,
  f.summary_raw         AS summary_raw,

  a.bank_name           AS bank_name,
  a.account_book        AS account_book,

  'UNKNOWN'             AS channel_name,
  'UNKNOWN'             AS merchant_name,
  'UNKNOWN'             AS cat1,
  'UNKNOWN'             AS cat2,

  f.balance             AS balance,
  f.deposit_raw         AS deposit_raw,
  f.withdraw_raw        AS withdraw_raw,

  CASE
    WHEN COALESCE(f.flag_missing_amount, 0) <> 0 THEN 1
    ELSE 0
  END                   AS flag_missing_amount,

  f.created_at          AS created_at,

  UPPER(REPLACE(REPLACE(a.bank_name, ' ', ''), '-', '')) AS bank_code

FROM fact_txn f
LEFT JOIN dim_account a
  ON a.account_id = f.account_id;

