-- sql/00_run_all.sql
-- single entrypoint; generated on 2026-02-01 12:51:26

CREATE DATABASE IF NOT EXISTS tel_bi;
USE tel_bi;

-- session charset guard (Workbench / mysql client)
SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci;

-- optional: hard-guard for troubleshooting
SELECT
  @@character_set_client      AS cs_client,
  @@character_set_connection  AS cs_conn,
  @@character_set_results     AS cs_results,
  @@collation_connection      AS col_conn;

-- 02_views (順序不動，只改檔名)
SOURCE sql/02_views/02_api_contract.sql;
SOURCE sql/02_views/02_viewcore.sql;

-- 03_star (順序不動，只改檔名)
SOURCE sql/03_star/03_star_check.sql;
SOURCE sql/03_star/03_star_main.sql;

-- 04_checks (SELECT-only) (順序不動，只改檔名)
SOURCE sql/04_checks/04_check_tools_all.sql;

-- 90_checks (SELECT-only) (不動)
SOURCE sql/90_checks/20_check_v_fact_txn_pretty.sql;


