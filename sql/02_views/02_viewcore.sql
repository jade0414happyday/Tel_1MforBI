-- sql/02_views/01_v_sinopac_pretty.sql
-- 來源：#2 的 v_SinoPac_pretty（主線 view）

USE tel_bi;

DROP VIEW IF EXISTS v_SinoPac_pretty;

CREATE VIEW v_SinoPac_pretty AS
SELECT
  r.id AS `ID`,
  r.account_book AS `帳簿`,
  r.txn_date AS `日期`,
  DATE_FORMAT(r.txn_date, '%Y-%m') AS `月份`,

  TRIM(
    CASE
      WHEN LOCATE('(', r.summary) > 0
        THEN SUBSTRING(r.summary, 1, LOCATE('(', r.summary) - 1)
      ELSE r.summary
    END
  ) AS `摘要`,

  CASE
    WHEN LOCATE('(', r.summary) > 0
     AND LOCATE(')', r.summary) > LOCATE('(', r.summary)
      THEN SUBSTRING(
        r.summary,
        LOCATE('(', r.summary) + 1,
        LOCATE(')', r.summary) - LOCATE('(', r.summary) - 1
      )
    ELSE NULL
  END AS `標籤`,

  r.deposit_amount AS `存入_raw`,
  r.withdraw_amount AS `支出_raw`,
  r.balance AS `餘額`,

  CASE
    WHEN (
      r.summary LIKE '%薪轉%' OR r.summary LIKE '%存款利息%' OR r.summary LIKE '%回饋%' OR r.summary LIKE '%中獎%' OR
      r.summary LIKE '%轉入%' OR r.summary LIKE '%存入%' OR r.summary LIKE '%匯入%' OR
      r.summary LIKE '%跨行存入%' OR r.summary LIKE '%跨行轉入%' OR
      r.summary LIKE '%普發%' OR r.summary LIKE '%退款%' OR r.summary LIKE '%旋轉拍賣%'
    )
      THEN COALESCE(r.deposit_amount, r.withdraw_amount, 0)
    ELSE COALESCE(r.deposit_amount, 0)
  END AS `存入`,

  CASE
    WHEN (
      r.summary LIKE '%薪轉%' OR r.summary LIKE '%存款利息%' OR r.summary LIKE '%回饋%' OR r.summary LIKE '%中獎%' OR
      r.summary LIKE '%轉入%' OR r.summary LIKE '%存入%' OR r.summary LIKE '%匯入%' OR
      r.summary LIKE '%跨行存入%' OR r.summary LIKE '%跨行轉入%' OR
      r.summary LIKE '%普發%' OR r.summary LIKE '%退款%' OR r.summary LIKE '%旋轉拍賣%'
    )
      THEN 0
    ELSE COALESCE(r.withdraw_amount, r.deposit_amount, 0)
  END AS `支出`,

  (
    CASE
      WHEN (
        r.summary LIKE '%薪轉%' OR r.summary LIKE '%存款利息%' OR r.summary LIKE '%回饋%' OR r.summary LIKE '%中獎%' OR
        r.summary LIKE '%轉入%' OR r.summary LIKE '%存入%' OR r.summary LIKE '%匯入%' OR
        r.summary LIKE '%跨行存入%' OR r.summary LIKE '%跨行轉入%' OR
        r.summary LIKE '%普發%' OR r.summary LIKE '%退款%' OR r.summary LIKE '%旋轉拍賣%'
      )
        THEN COALESCE(r.deposit_amount, r.withdraw_amount, 0)
      ELSE COALESCE(r.deposit_amount, 0)
    END
    -
    CASE
      WHEN (
        r.summary LIKE '%薪轉%' OR r.summary LIKE '%存款利息%' OR r.summary LIKE '%回饋%' OR r.summary LIKE '%中獎%' OR
        r.summary LIKE '%轉入%' OR r.summary LIKE '%存入%' OR r.summary LIKE '%匯入%' OR
        r.summary LIKE '%跨行存入%' OR r.summary LIKE '%跨行轉入%' OR
        r.summary LIKE '%普發%' OR r.summary LIKE '%退款%' OR r.summary LIKE '%旋轉拍賣%'
      )
        THEN 0
      ELSE COALESCE(r.withdraw_amount, r.deposit_amount, 0)
    END
  ) AS `淨額`,

  CASE
    WHEN r.summary LIKE '%薪轉%' THEN '薪轉'
    WHEN r.summary LIKE '%悠遊卡%' OR r.summary LIKE '%悠游卡%' THEN '悠遊卡'
    WHEN r.summary LIKE '%簽帳卡%' THEN '簽帳卡'
    WHEN r.summary LIKE '%手機%' OR r.summary LIKE '%收機%' THEN '手機'
    WHEN r.summary LIKE '%跨行%' THEN '跨行'
    WHEN r.summary LIKE '%匯%' THEN '匯款/匯入匯出'
    WHEN r.summary LIKE '%提款%' THEN '提款'
    ELSE NULL
  END AS `渠道提示`,

  CASE
    WHEN r.summary LIKE '%中信%' THEN '中信'
    WHEN r.summary LIKE '%國泰%' THEN '國泰'
    WHEN r.summary LIKE '%台新%' THEN '台新'
    WHEN r.summary LIKE '%如新%' THEN '如新'
    ELSE NULL
  END AS `對手方提示`,

  CASE
    WHEN r.deposit_amount IS NULL AND r.withdraw_amount IS NULL THEN 1
    ELSE 0
  END AS `flag_金額缺失`,

  lbl.cat1 AS `類別1`,
  lbl.cat2 AS `類別2`,
  lbl.memo AS `人工備註`,
  r.note AS `原始備註`,
  r.created_at AS `建檔時間`
FROM SinoPac_raw_a r
LEFT JOIN sinopac_txn_labels lbl
  ON lbl.txn_id = r.id;
