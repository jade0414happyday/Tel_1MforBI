-- one-shot: build + verify (run in MySQL Workbench)
-- assumes Workbench working directory can resolve relative path "sql/..."

SOURCE sql/00_run_all.sql;

-- minimal healthcheck (inline)
USE tel_bi;

SELECT DATABASE() AS current_schema;

SELECT
  SUM(Table_type='BASE TABLE') AS base_table_cnt,
  SUM(Table_type='VIEW')       AS view_cnt
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = 'tel_bi';

SHOW FULL TABLES IN tel_bi WHERE Table_type = 'BASE TABLE';
SHOW FULL TABLES IN tel_bi WHERE Table_type = 'VIEW';
