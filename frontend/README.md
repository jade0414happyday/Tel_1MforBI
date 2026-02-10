# TEL Frontend

## Run locally
在本機用 Python 靜態伺服器開 `frontend/index.html`。

```bash
cd frontend
python -m http.server 5173



python -m http.server 5173 //簡易靜態伺服器

open http://127.0.0.1:5173/
New-Item -ItemType File -Path frontend\\favicon.ico -Force



git add frontend/README.md frontend/favicon.ico

git commit -m "chore: add local run instructions"
git push

