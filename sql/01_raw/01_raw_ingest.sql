
-- sql/01_schema/02_star_schema_set4.sql
-- 主線採 #5：SinoPac_SET4_star_v2（修正欄位引用為 v_SinoPac_pretty 的中文欄名）

USE tel_bi;

-- 重跑安全：先關 FK 再 drop
SET @OLD_FK_CHECKS := @@FOREIGN_KEY_CHECKS;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS fact_txn;
DROP TABLE IF EXISTS dim_category;
DROP TABLE IF EXISTS dim_merchant;
DROP TABLE IF EXISTS dim_channel;
DROP TABLE IF EXISTS dim_account;

SET FOREIGN_KEY_CHECKS = @OLD_FK_CHECKS;

-- dim_account
CREATE TABLE dim_account (
  account_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bank_name VARCHAR(50) NOT NULL,
  account_book CHAR(1) NOT NULL,
  UNIQUE KEY uk_bank_book (bank_name, account_book)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- dim_channel
CREATE TABLE dim_channel (
  channel_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  channel_name VARCHAR(50) NOT NULL,
  UNIQUE KEY uk_channel (channel_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- dim_merchant
CREATE TABLE dim_merchant (
  merchant_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  merchant_name VARCHAR(50) NOT NULL,
  UNIQUE KEY uk_merchant (merchant_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- dim_category
CREATE TABLE dim_category (
  category_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  parent_category_id BIGINT UNSIGNED NULL,
  category_name VARCHAR(50) NOT NULL,
  level TINYINT UNSIGNED NOT NULL,
  UNIQUE KEY uk_cat_parent_level_name (parent_category_id, level, category_name),
  KEY idx_level_name (level, category_name),
  KEY idx_parent (parent_category_id),
  CONSTRAINT fk_cat_parent
    FOREIGN KEY (parent_category_id) REFERENCES dim_category(category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- seed UNKNOWN
INSERT IGNORE INTO dim_account (bank_name, account_book) VALUES ('SinoPac','A');
INSERT IGNORE INTO dim_channel (channel_name) VALUES ('UNKNOWN');
INSERT IGNORE INTO dim_merchant (merchant_name) VALUES ('UNKNOWN');
INSERT IGNORE INTO dim_category (parent_category_id, category_name, level) VALUES (NULL, 'UNKNOWN', 1);

-- cache UNKNOWN ids
SET @unknown_channel_id := (SELECT channel_id FROM dim_channel WHERE channel_name='UNKNOWN' LIMIT 1);
SET @unknown_merchant_id := (SELECT merchant_id FROM dim_merchant WHERE merchant_name='UNKNOWN' LIMIT 1);
SET @unknown_cat1_id := (
  SELECT category_id
  FROM dim_category
  WHERE parent_category_id IS NULL AND level=1 AND category_name='UNKNOWN'
  LIMIT 1
);

-- grow dim lists from v_SinoPac_pretty
INSERT IGNORE INTO dim_account (bank_name, account_book)
SELECT DISTINCT 'SinoPac', p.`帳簿`
FROM v_SinoPac_pretty p
WHERE p.`帳簿` IS NOT NULL AND p.`帳簿` <> '';

INSERT IGNORE INTO dim_channel (channel_name)
SELECT DISTINCT p.`渠道提示`
FROM v_SinoPac_pretty p
WHERE p.`渠道提示` IS NOT NULL AND p.`渠道提示` <> '';

INSERT IGNORE INTO dim_merchant (merchant_name)
SELECT DISTINCT p.`對手方提示`
FROM v_SinoPac_pretty p
WHERE p.`對手方提示` IS NOT NULL AND p.`對手方提示` <> '';

INSERT IGNORE INTO dim_category (parent_category_id, category_name, level)
SELECT DISTINCT NULL, p.`類別1`, 1
FROM v_SinoPac_pretty p
WHERE p.`類別1` IS NOT NULL AND p.`類別1` <> '';

INSERT IGNORE INTO dim_category (parent_category_id, category_name, level)
SELECT DISTINCT c1.category_id, p.`類別2`, 2
FROM v_SinoPac_pretty p
JOIN dim_category c1
  ON c1.parent_category_id IS NULL
 AND c1.level = 1
 AND c1.category_name = p.`類別1`
WHERE p.`類別2` IS NOT NULL AND p.`類別2` <> '';

-- B1/B2 規則分類版（用 淨額 + 摘要 + 對手方提示）
INSERT IGNORE INTO dim_category (parent_category_id, category_name, level)
SELECT DISTINCT NULL,
  CASE
    WHEN p.`淨額` > 0 AND p.`摘要` LIKE '%薪%' THEN '收入'
    WHEN p.`淨額` > 0                          THEN '存入'
    WHEN p.`淨額` < 0                          THEN '支出'
    WHEN p.`摘要` LIKE 'CD%'                   THEN '轉帳'
    ELSE '其他'
  END,
  1
FROM v_SinoPac_pretty p;

INSERT IGNORE INTO dim_category (parent_category_id, category_name, level)
SELECT DISTINCT c1.category_id,
  CASE
    WHEN p.`摘要` LIKE '%薪%' THEN '薪資'
    WHEN p.`摘要` LIKE 'CD%' THEN '轉帳'
    WHEN p.`淨額` < 0 AND COALESCE(p.`對手方提示`, '') <> '' THEN CONCAT('支出-', p.`對手方提示`)
    WHEN p.`淨額` > 0 AND COALESCE(p.`對手方提示`, '') <> '' THEN CONCAT('存入-', p.`對手方提示`)
    ELSE '一般'
  END,
  2
FROM v_SinoPac_pretty p
JOIN dim_category c1
  ON c1.parent_category_id IS NULL
 AND c1.level = 1
 AND c1.category_name =
  CASE
    WHEN p.`淨額` > 0 AND p.`摘要` LIKE '%薪%' THEN '收入'
    WHEN p.`淨額` > 0                          THEN '存入'
    WHEN p.`淨額` < 0                          THEN '支出'
    WHEN p.`摘要` LIKE 'CD%'                   THEN '轉帳'
    ELSE '其他'
  END;

-- fact_txn
CREATE TABLE fact_txn (
  txn_id BIGINT UNSIGNED PRIMARY KEY,
  account_id BIGINT UNSIGNED NOT NULL,
  txn_date DATE NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  summary_raw VARCHAR(255) NOT NULL,

  channel_id BIGINT UNSIGNED NULL,
  merchant_id BIGINT UNSIGNED NULL,
  category_id BIGINT UNSIGNED NULL,

  deposit_raw DECIMAL(12,2) NULL,
  withdraw_raw DECIMAL(12,2) NULL,
  balance DECIMAL(12,2) NULL,
  flag_missing_amount TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  KEY idx_account_date (account_id, txn_date),
  KEY idx_date (txn_date),
  KEY idx_merchant (merchant_id),
  KEY idx_category (category_id),

  CONSTRAINT fk_fact_account  FOREIGN KEY (account_id)  REFERENCES dim_account(account_id),
  CONSTRAINT fk_fact_channel  FOREIGN KEY (channel_id)  REFERENCES dim_channel(channel_id),
  CONSTRAINT fk_fact_merchant FOREIGN KEY (merchant_id) REFERENCES dim_merchant(merchant_id),
  CONSTRAINT fk_fact_category FOREIGN KEY (category_id) REFERENCES dim_category(category_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- load fact_txn from v_SinoPac_pretty
INSERT INTO fact_txn (
  txn_id, account_id, txn_date, amount, summary_raw,
  channel_id, merchant_id, category_id,
  deposit_raw, withdraw_raw, balance, flag_missing_amount, created_at
)
SELECT
  p.`ID`,
  a.account_id,
  p.`日期`,
  COALESCE(p.`淨額`, 0),
  p.`摘要`,

  COALESCE(ch.channel_id, @unknown_channel_id),
  COALESCE(m.merchant_id, @unknown_merchant_id),

  COALESCE(
    c2.category_id,
    c1.category_id,
    @unknown_cat1_id
  ),

  p.`存入_raw`,
  p.`支出_raw`,
  p.`餘額`,
  CASE WHEN COALESCE(p.`flag_金額缺失`, 0) <> 0 THEN 1 ELSE 0 END,
  p.`建檔時間`
FROM v_SinoPac_pretty p
JOIN dim_account a
  ON a.bank_name='SinoPac' AND a.account_book=p.`帳簿`
LEFT JOIN dim_channel ch
  ON ch.channel_name=p.`渠道提示`
LEFT JOIN dim_merchant m
  ON m.merchant_name=p.`對手方提示`
LEFT JOIN dim_category c1
  ON c1.parent_category_id IS NULL AND c1.level=1 AND c1.category_name=p.`類別1`
LEFT JOIN dim_category c2
  ON c2.level=2 AND c2.category_name=p.`類別2` AND c2.parent_category_id=c1.category_id;

-- 查詢清楚：star pretty view（報表用）
CREATE OR REPLACE VIEW v_SinoPac_star_pretty AS
SELECT
  f.txn_id AS `ID`,
  a.account_book AS `帳簿`,
  f.txn_date AS `日期`,
  DATE_FORMAT(f.txn_date, '%Y-%m') AS `月份`,
  f.summary_raw AS `摘要`,

  f.deposit_raw AS `存入_raw`,
  f.withdraw_raw AS `支出_raw`,
  CASE WHEN f.amount > 0 THEN f.amount ELSE 0 END AS `存入`,
  CASE WHEN f.amount < 0 THEN -f.amount ELSE 0 END AS `支出`,
  f.amount AS `淨額`,
  f.balance AS `餘額`,

  ch.channel_name AS `渠道提示`,
  m.merchant_name AS `對手方提示`,
  c1.category_name AS `類別1`,
  c2.category_name AS `類別2`,

  f.flag_missing_amount AS `flag_金額缺失`,
  f.created_at AS `建檔時間`
FROM fact_txn f
JOIN dim_account a ON a.account_id=f.account_id
LEFT JOIN dim_channel ch ON ch.channel_id=f.channel_id
LEFT JOIN dim_merchant m ON m.merchant_id=f.merchant_id
LEFT JOIN dim_category c2 ON c2.category_id=f.category_id AND c2.level=2
LEFT JOIN dim_category c1 ON c1.category_id=COALESCE(c2.parent_category_id, f.category_id) AND c1.level=1;

-- 驗收：筆數對齊 + UNKNOWN 落點
SELECT
  (SELECT COUNT(*) FROM v_SinoPac_pretty) AS pretty_cnt,
  (SELECT COUNT(*) FROM fact_txn)         AS fact_cnt;

SELECT
  SUM(channel_id  = @unknown_channel_id)  AS unknown_channel_cnt,
  SUM(merchant_id = @unknown_merchant_id) AS unknown_merchant_cnt,
  SUM(category_id = @unknown_cat1_id)     AS unknown_category_cnt
FROM fact_txn;
