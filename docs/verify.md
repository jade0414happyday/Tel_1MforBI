# Verify: stress-months checkpoint

## Version
- tag: v0.6.2-stress-months
- commit: a2a7a58
- route: /profile/stress-months

## Contract sample
File: api/contract.json

Expected keys:
- ok
- version
- route
- query.book
- query.bank_code
- query.from
- query.to
- count
- rows[].month
- rows[].inflow
- rows[].outflow
- rows[].net
- rows[].txn_count
- rows[].missing_amount_txn_count
- rows[].stress_reason

## Smoke test
Command:
powershell -ExecutionPolicy Bypass -File .\scripts\smoke_profile_stress_months.ps1

Expected:
- PASS: /profile/stress-months smoke test
- version = tel-api-profile-0.6.2
- route = /profile/stress-months
- count >= 1

## Manual curl
Command:
curl.exe "http://127.0.0.1:3001/profile/stress-months?book=A&bank_code=SinoPac&from=2018-08&to=2018-08"

Expected sample:
{"ok":1,"version":"tel-api-profile-0.6.2","route":"/profile/stress-months","query":{"book":"A","bank_code":"SINOPAC","from":"2018-08","to":"2018-08"},"count":1,"rows":[{"month":"2018-08","inflow":0,"outflow":200,"net":-200,"txn_count":3,"missing_amount_txn_count":0,"stress_reason":"NEGATIVE_NET"}]}
