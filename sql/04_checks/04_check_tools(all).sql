-- sql/99_archive/SET_channel_only_verify.sql
-- 來源：#6（診斷工具），不進主線依賴
-- 設計目標：可重跑、可在 fact_txn 已掛外鍵時執行、不 DROP/CREATE 任何永久 dim/fact
-- 做法：只建立 TEMPORARY tables（tmp_sp_keys + tmp_dim_*），並提供讀取式比對查詢

USE tel_bi;

-- 0) 前置檢查：確認 v_SinoPac_pretty 存在
SET @view_exists := (
  SELECT COUNT(*)
  FROM information_schema.VIEWS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'v_SinoPac_pretty'
);

SELECT
  IF(@view_exists = 1, 'OK', 'MISSING') AS view_status;

-- 0.1) normalize keys：用 TEMPORARY TABLE，避免重掃與重算 TRIM
DROP TEMPORARY TABLE IF EXISTS tmp_sp_keys;

CREATE TEMPORARY TABLE tmp_sp_keys (
  account_book  CHAR(1)      NULL,
  channel_name  VARCHAR(50)  NULL,
  merchant_name VARCHAR(50)  NULL,
  KEY idx_book (account_book),
  KEY idx_channel (channel_name),
  KEY idx_merchant (merchant_name)
) ENGINE=InnoDB;

-- 若 view 不存在，改成插入 0 筆，確保後續查詢可跑完
SET @sql_ins_keys := IF(
  @view_exists = 1,
  'INSERT INTO tmp_sp_keys (account_book, channel_name, merchant_name)
   SELECT
     CASE
       WHEN LENGTH(TRIM(p.`帳簿`)) = 0 THEN NULL
       ELSE LEFT(TRIM(p.`帳簿`), 1)
     END AS account_book,
     CASE
       WHEN LENGTH(TRIM(p.`渠道提示`)) = 0 THEN NULL
       ELSE LEFT(TRIM(p.`渠道提示`), 50)
     END AS channel_name,
     CASE
       WHEN LENGTH(TRIM(p.`對手方提示`)) = 0 THEN NULL
       ELSE LEFT(TRIM(p.`對手方提示`), 50)
     END AS merchant_name
   FROM v_SinoPac_pretty p',
  'INSERT INTO tmp_sp_keys (account_book, channel_name, merchant_name)
   SELECT NULL, NULL, NULL
   WHERE 1 = 0'
);

PREPARE stmt_ins_keys FROM @sql_ins_keys;
EXECUTE stmt_ins_keys;
DEALLOCATE PREPARE stmt_ins_keys;

-- quick sanity
SELECT
  COUNT(*) AS tmp_sp_keys_rows,
  SUM(channel_name IS NULL) AS null_channel_rows,
  SUM(merchant_name IS NULL) AS null_merchant_rows
FROM tmp_sp_keys;

-- 1) build tmp dim（全 TEMPORARY，不觸碰永久 dim）
DROP TEMPORARY TABLE IF EXISTS tmp_dim_account;
DROP TEMPORARY TABLE IF EXISTS tmp_dim_channel;
DROP TEMPORARY TABLE IF EXISTS tmp_dim_merchant;
DROP TEMPORARY TABLE IF EXISTS tmp_dim_category;

CREATE TEMPORARY TABLE tmp_dim_account (
  bank_name VARCHAR(50) NOT NULL,
  account_book CHAR(1) NOT NULL,
  PRIMARY KEY (bank_name, account_book)
) ENGINE=InnoDB;

CREATE TEMPORARY TABLE tmp_dim_channel (
  channel_name VARCHAR(50) NOT NULL,
  PRIMARY KEY (channel_name)
) ENGINE=InnoDB;

CREATE TEMPORARY TABLE tmp_dim_merchant (
  merchant_name VARCHAR(50) NOT NULL,
  PRIMARY KEY (merchant_name)
) ENGINE=InnoDB;

CREATE TEMPORARY TABLE tmp_dim_category (
  level TINYINT NOT NULL,
  category_name VARCHAR(50) NOT NULL,
  PRIMARY KEY (level, category_name)
) ENGINE=InnoDB;

-- seed UNKNOWN
INSERT IGNORE INTO tmp_dim_channel  (channel_name)  VALUES ('UNKNOWN');
INSERT IGNORE INTO tmp_dim_merchant (merchant_name) VALUES ('UNKNOWN');
INSERT IGNORE INTO tmp_dim_category (level, category_name) VALUES (1, 'UNKNOWN');

-- grow from tmp_sp_keys
INSERT IGNORE INTO tmp_dim_account (bank_name, account_book)
SELECT
  'SinoPac' AS bank_name,
  k.account_book
FROM tmp_sp_keys k
WHERE k.account_book IS NOT NULL
GROUP BY k.account_book;

INSERT IGNORE INTO tmp_dim_channel (channel_name)
SELECT
  k.channel_name
FROM tmp_sp_keys k
WHERE k.channel_name IS NOT NULL
GROUP BY k.channel_name;

INSERT IGNORE INTO tmp_dim_merchant (merchant_name)
SELECT
  k.merchant_name
FROM tmp_sp_keys k
WHERE k.merchant_name IS NOT NULL
GROUP BY k.merchant_name;

-- 2) verify: channel distribution (來自 view 的提示值)
SELECT
  IFNULL(k.channel_name, 'NULL') AS channel_hint,
  COUNT(*) AS row_cnt
FROM tmp_sp_keys k
GROUP BY IFNULL(k.channel_name, 'NULL')
ORDER BY row_cnt DESC
LIMIT 50;

SELECT COUNT(*) AS tmp_dim_channel_cnt FROM tmp_dim_channel;

SELECT channel_name
FROM tmp_dim_channel
ORDER BY channel_name
LIMIT 200;

-- 3) optional: 若永久 dim_channel 存在，做 read-only 比對（不改任何表）
SET @dim_channel_exists := (
  SELECT COUNT(*)
  FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'dim_channel'
);

SELECT
  IF(@dim_channel_exists = 1, 'OK', 'MISSING') AS dim_channel_table_status;

SET @sql_real_cnt := IF(
  @dim_channel_exists = 1,
  'SELECT COUNT(*) AS dim_channel_cnt FROM dim_channel',
  'SELECT NULL AS dim_channel_cnt'
);

PREPARE stmt_real_cnt FROM @sql_real_cnt;
EXECUTE stmt_real_cnt;
DEALLOCATE PREPARE stmt_real_cnt;

-- 提示值中，哪些不在永久 dim_channel（只在 dim_channel 存在時輸出）
SET @sql_missing_in_dim := IF(
  @dim_channel_exists = 1,
  'SELECT
     k.channel_name AS channel_hint_not_in_dim
   FROM (
     SELECT DISTINCT channel_name
     FROM tmp_sp_keys
     WHERE channel_name IS NOT NULL
   ) k
   LEFT JOIN dim_channel d
     ON d.channel_name = k.channel_name
   WHERE d.channel_name IS NULL
   ORDER BY k.channel_name
   LIMIT 200',
  'SELECT NULL AS channel_hint_not_in_dim WHERE 1 = 0'
);

PREPARE stmt_missing_in_dim FROM @sql_missing_in_dim;
EXECUTE stmt_missing_in_dim;
DEALLOCATE PREPARE stmt_missing_in_dim;
