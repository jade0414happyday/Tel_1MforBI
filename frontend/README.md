\# TEL Frontend //frontend/index.html




\## Run locally

\## Verify   //驗收步驟

Open:             //在瀏覽器搜尋

http://127.0.0.1:5173/  //我的電腦:簡易靜態伺服器用的埠號



Expected:   //看到的畫面特徵

You can see "TEL 專案骨架 OK"



cd frontend



python -m http.server 5173 //簡易靜態伺服器

open http://127.0.0.1:5173/
New-Item -ItemType File -Path frontend\\favicon.ico -Force



git add frontend/README.md frontend/favicon.ico

git commit -m "chore: add local run instructions"
git push

